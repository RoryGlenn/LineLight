/**
 * Create a bounded producer/consumer queue for synthesized speech chunks.
 *
 * The queue eagerly prepares the current chunk plus `lookahead` future chunks.
 * Preparation errors are captured immediately so an abandoned queue never
 * creates unhandled promise rejections; `take()` rethrows the error when that
 * chunk reaches playback.
 *
 * @template TChunk
 * @template TPrepared
 * @param {{
 *   startIndex: number,
 *   endIndex: number,
 *   lookahead: number,
 *   buildChunk: (startIndex: number) => TChunk | null,
 *   getNextIndex: (chunk: TChunk) => number,
 *   prepareChunk: (chunk: TChunk) => Promise<TPrepared>,
 * }} options
 */
export function createSpeechPrefetchQueue({
  startIndex,
  endIndex,
  lookahead,
  buildChunk,
  getNextIndex,
  prepareChunk,
}) {
  const targetLookahead = Math.max(0, Math.floor(lookahead));
  /** @type {Array<{
   *   chunk: TChunk,
   *   status: "pending" | "ready" | "error",
   *   result: Promise<
   *     { ok: true, value: TPrepared } |
   *     { ok: false, error: unknown }
   *   >,
   * }>} */
  let entries = [];
  let cursor = startIndex;
  let disposed = false;
  let reachedEnd = cursor >= endIndex;

  /** @param {number} targetLength */
  const fill = (targetLength) => {
    while (
      !disposed &&
      !reachedEnd &&
      entries.length < targetLength
    ) {
      const chunk = buildChunk(cursor);
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
      const entry = {
        chunk,
        status: /** @type {"pending" | "ready" | "error"} */ ("pending"),
        result: /** @type {Promise<
         *   { ok: true, value: TPrepared } |
         *   { ok: false, error: unknown }
         * >} */ (Promise.resolve({ ok: false, error: undefined })),
      };
      entry.result = Promise.resolve()
        .then(() => prepareChunk(chunk))
        .then(
          (value) => {
            entry.status = "ready";
            return { ok: /** @type {const} */ (true), value };
          },
          (error) => {
            entry.status = "error";
            return { ok: /** @type {const} */ (false), error };
          },
        );
      entries.push(entry);
    }
  };

  // Include the first chunk as well as the requested future lookahead.
  fill(targetLookahead + 1);

  return {
    get size() {
      return entries.length;
    },

    get exhausted() {
      return reachedEnd && entries.length === 0;
    },

    peekStatus() {
      return entries[0]?.status ?? null;
    },

    async take() {
      if (disposed) return null;
      const entry = entries.shift();
      if (!entry) return null;

      const waited = entry.status === "pending";
      fill(targetLookahead);
      const outcome = await entry.result;
      if (!outcome.ok) throw outcome.error;

      return {
        chunk: entry.chunk,
        prepared: outcome.value,
        waited,
      };
    },

    dispose() {
      disposed = true;
      entries = [];
    },
  };
}
