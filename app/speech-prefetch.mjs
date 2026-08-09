/**
 * Create a bounded producer/consumer queue for synthesized speech chunks.
 *
 * Only the current chunk starts eagerly. Future chunks begin after the current
 * result is ready, which lets callers update their chunk sizing from measured
 * synthesis speed before speculative work is built. Every preparation gets an
 * independent AbortSignal so Pause can cancel future CPU work without
 * discarding the audio that is already playing.
 *
 * @template TChunk
 * @template TPrepared
 * @param {{
 *   startIndex: number,
 *   endIndex: number,
 *   lookahead: number,
 *   buildChunk: (startIndex: number) => TChunk | null,
 *   getNextIndex: (chunk: TChunk) => number,
 *   prepareChunk: (
 *     chunk: TChunk,
 *     context: { signal: AbortSignal, speculative: boolean },
 *   ) => Promise<TPrepared>,
 *   discardPrepared?: (prepared: TPrepared, chunk: TChunk) => void,
 * }} options
 */
export function createSpeechPrefetchQueue({
  startIndex,
  endIndex,
  lookahead,
  buildChunk,
  getNextIndex,
  prepareChunk,
  discardPrepared,
}) {
  const targetLookahead = Math.max(0, Math.floor(lookahead));
  /** @type {Array<{
   *   startIndex: number,
   *   chunk: TChunk,
   *   controller: AbortController,
   *   speculative: boolean,
   *   canceled: boolean,
   *   discarded: boolean,
   *   status: "pending" | "ready" | "error",
   *   outcome?:
   *     { ok: true, value: TPrepared } |
   *     { ok: false, error: unknown },
   *   result: Promise<
   *     { ok: true, value: TPrepared } |
   *     { ok: false, error: unknown }
   *   >,
   * }>} */
  let entries = [];
  /** @type {Set<(typeof entries)[number]>} */
  const activeEntries = new Set();
  let cursor = startIndex;
  let disposed = false;
  let paused = false;
  let reachedEnd = cursor >= endIndex;

  /** @param {(typeof entries)[number]} entry */
  const discardEntry = (entry) => {
    if (entry.discarded || !entry.outcome?.ok) return;
    entry.discarded = true;
    discardPrepared?.(entry.outcome.value, entry.chunk);
  };

  /**
   * @param {number} targetLength
   * @param {boolean} speculative
   */
  const fill = (targetLength, speculative) => {
    while (
      !disposed &&
      !paused &&
      !reachedEnd &&
      entries.length < targetLength
    ) {
      const chunkStartIndex = cursor;
      const chunk = buildChunk(chunkStartIndex);
      if (!chunk) {
        reachedEnd = true;
        break;
      }

      const nextIndex = getNextIndex(chunk);
      if (!Number.isInteger(nextIndex) || nextIndex <= cursor) {
        throw new Error("Speech prefetch chunks must advance the document index.");
      }

      cursor = nextIndex;
      reachedEnd = cursor >= endIndex;
      const controller = new AbortController();
      const entry = {
        startIndex: chunkStartIndex,
        chunk,
        controller,
        speculative,
        canceled: false,
        discarded: false,
        status: /** @type {"pending" | "ready" | "error"} */ ("pending"),
        outcome: undefined,
        result: /** @type {Promise<
         *   { ok: true, value: TPrepared } |
         *   { ok: false, error: unknown }
         * >} */ (Promise.resolve({ ok: false, error: undefined })),
      };
      activeEntries.add(entry);
      entry.result = Promise.resolve()
        .then(() =>
          prepareChunk(chunk, {
            signal: controller.signal,
            speculative,
          }),
        )
        .then(
          (value) => {
            entry.status = "ready";
            entry.outcome = {
              ok: /** @type {const} */ (true),
              value,
            };
            if (entry.canceled || disposed) discardEntry(entry);
            return entry.outcome;
          },
          (error) => {
            entry.status = "error";
            entry.outcome = {
              ok: /** @type {const} */ (false),
              error,
            };
            return entry.outcome;
          },
        )
        .finally(() => {
          activeEntries.delete(entry);
        });
      entries.push(entry);
    }
  };

  // Start only the requested/current audio. Its result determines the size of
  // later chunks before the minimal speculative window is filled.
  fill(1, false);

  const cancelPending = () => {
    if (disposed) return 0;
    const canceledEntries = entries.filter((entry) => entry.speculative);
    if (!canceledEntries.length) return 0;

    const canceledSet = new Set(canceledEntries);
    entries = entries.filter((entry) => !canceledSet.has(entry));
    cursor = Math.min(
      cursor,
      ...canceledEntries.map((entry) => entry.startIndex),
    );
    reachedEnd = cursor >= endIndex;
    for (const entry of canceledEntries) {
      entry.canceled = true;
      entry.controller.abort();
      discardEntry(entry);
    }
    return canceledEntries.length;
  };

  return {
    get size() {
      return entries.length;
    },

    get exhausted() {
      return reachedEnd && entries.length === 0;
    },

    get paused() {
      return paused;
    },

    peekStatus() {
      return entries[0]?.status ?? null;
    },

    async take() {
      if (disposed) return null;
      if (!entries.length && !paused) fill(1, false);
      const entry = entries.shift();
      if (!entry) return null;

      const waited = entry.status === "pending";
      const outcome = await entry.result;
      if (disposed) return null;
      if (!outcome.ok) throw outcome.error;

      // The completed result may update adaptive sizing in prepareChunk.
      // Begin only the bounded future window after that measurement exists.
      fill(targetLookahead, true);
      return {
        chunk: entry.chunk,
        prepared: outcome.value,
        waited,
      };
    },

    cancelPending,

    pause({ cancelPending: shouldCancelPending = true } = {}) {
      if (disposed || paused) return 0;
      paused = true;
      return shouldCancelPending ? cancelPending() : 0;
    },

    resume() {
      if (disposed || !paused) return;
      paused = false;
      fill(targetLookahead, true);
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      paused = true;
      for (const entry of activeEntries) {
        entry.canceled = true;
        entry.controller.abort();
        discardEntry(entry);
      }
      for (const entry of entries) discardEntry(entry);
      entries = [];
    },
  };
}

/**
 * Keep a deliberately small least-recently-used set of generated speech
 * results. Callers provide the byte size because the cached value may contain
 * metadata in addition to its encoded audio buffer.
 *
 * @template TValue
 * @param {{ maxBytes?: number, maxEntries?: number }} [options]
 */
export function createBoundedSpeechAudioCache({
  maxBytes = 12 * 1024 * 1024,
  maxEntries = 6,
} = {}) {
  const byteLimit = Math.max(0, Math.floor(maxBytes));
  const entryLimit = Math.max(0, Math.floor(maxEntries));
  /** @type {Map<string, { byteLength: number, value: TValue }>} */
  const entries = new Map();
  let totalBytes = 0;

  const evictOldest = () => {
    const oldestKey = entries.keys().next().value;
    if (oldestKey === undefined) return false;
    const oldest = entries.get(oldestKey);
    entries.delete(oldestKey);
    totalBytes -= oldest?.byteLength ?? 0;
    return true;
  };

  return {
    get size() {
      return entries.size;
    },

    get byteLength() {
      return totalBytes;
    },

    /** @param {string} key */
    get(key) {
      const entry = entries.get(key);
      if (!entry) return undefined;
      entries.delete(key);
      entries.set(key, entry);
      return entry.value;
    },

    /**
     * @param {string} key
     * @param {TValue} value
     * @param {number} byteLength
     */
    set(key, value, byteLength) {
      const normalizedBytes = Math.max(0, Math.floor(Number(byteLength) || 0));
      const existing = entries.get(key);
      if (existing) {
        totalBytes -= existing.byteLength;
        entries.delete(key);
      }

      if (
        entryLimit === 0 ||
        byteLimit === 0 ||
        normalizedBytes > byteLimit
      ) {
        return false;
      }

      entries.set(key, { byteLength: normalizedBytes, value });
      totalBytes += normalizedBytes;
      while (entries.size > entryLimit || totalBytes > byteLimit) {
        if (!evictOldest()) break;
      }
      return entries.has(key);
    },

    clear() {
      entries.clear();
      totalBytes = 0;
    },
  };
}
