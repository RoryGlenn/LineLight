// Let the browser finish its first paint, but do not add an arbitrary ten-second
// delay before a missing default voice can begin downloading.
export const OFFLINE_INSTALL_IDLE_DELAY_MS = 0;
export const OFFLINE_WARM_IDLE_TIMEOUT_MS = 5_000;
// The model/voice byte total excludes the bundled ONNX runtime (about 22 MB)
// and Cache Storage metadata. A fixed 50 MB margin covers both without making
// larger model packs reserve a needless percentage-based surplus.
export const OFFLINE_STORAGE_HEADROOM_BYTES = 50_000_000;
export const OFFLINE_FIRST_CHUNK_CHARACTERS = 24;
export const OFFLINE_MIN_CHUNK_CHARACTERS = 48;
export const OFFLINE_MAX_CHUNK_CHARACTERS = 360;
export const OFFLINE_TARGET_SYNTHESIS_RATIO = 0.65;

const NARRATION_PHASE_RANGES = {
  initializing: [4, 60],
  synthesizing: [60, 94],
};

const INSTALL_PHASE_RANGES = {
  downloading: [0, 84],
  verifying: [85, 85],
  initializing: [86, 94],
  warming: [95, 99],
  ready: [100, 100],
};

/**
 * Keep a default offline voice convenient without starting its heavy download
 * while another document task needs the browser's CPU, memory, and storage.
 *
 * @param {{
 *   attempted: boolean,
 *   engine: string,
 *   importing: boolean,
 *   packState: string,
 *   settingsRestored: boolean,
 * }} state
 */
export function shouldScheduleOfflinePreparation(state) {
  return Boolean(
    state.settingsRestored &&
      state.engine === "offline" &&
      state.packState === "missing" &&
      !state.importing &&
      !state.attempted,
  );
}

/**
 * Importing a document should stop an incomplete pack transaction, but a
 * downloaded and initialized model is independent of the open document and
 * should stay warm for the next Play action.
 *
 * @param {string} packState
 */
export function shouldDisposeOfflineWorkerForImport(packState) {
  return packState === "installing";
}

/**
 * Import stops active lookahead work so parsing remains responsive. Once the
 * new document has painted, prepare an installed pack whether or not this page
 * had already warmed its inference worker.
 *
 * @param {{
 *   packState: string,
 *   readinessState: string,
 *   restorePending?: boolean,
 * }} state
 */
export function shouldRestoreOfflineWorkerAfterImport(state) {
  return state.packState === "ready";
}

/**
 * A Play action should cancel an idle callback that has not begun, but once
 * model initialization is running it is cheaper to queue narration behind it
 * and reuse the warm worker. Lifecycle stops still abort active preparation.
 *
 * @param {{ abortActive?: boolean, started?: boolean }} state
 */
export function shouldAbortOfflineWarmRestore({
  abortActive = true,
  started = false,
} = {}) {
  return abortActive || !started;
}

/**
 * Range-backed model downloads retain one durable copy. Reserve only the part
 * of the pack that is missing plus a fixed runtime/metadata margin.
 *
 * @param {number} packBytes
 * @param {{ quota?: number, usage?: number } | undefined} estimate
 * @param {number} [retainedBytes]
 */
export function evaluateOfflineStorageHeadroom(
  packBytes,
  estimate,
  retainedBytes = 0,
) {
  const normalizedPackBytes = Math.max(0, Number(packBytes) || 0);
  const normalizedRetainedBytes = Math.min(
    normalizedPackBytes,
    Math.max(0, Number(retainedBytes) || 0),
  );
  const remainingPackBytes = normalizedPackBytes - normalizedRetainedBytes;
  const requiredBytes = Math.ceil(
    remainingPackBytes + OFFLINE_STORAGE_HEADROOM_BYTES,
  );
  const quota = Number(estimate?.quota);
  const usage = Number(estimate?.usage);
  const availableBytes =
    Number.isFinite(quota) &&
    Number.isFinite(usage) &&
    quota >= 0 &&
    usage >= 0
      ? Math.max(0, quota - usage)
      : null;
  return {
    availableBytes,
    requiredBytes,
    sufficient:
      availableBytes === null ? null : availableBytes >= requiredBytes,
  };
}

/**
 * Keep the first request short enough to reach the speaker quickly, then use
 * the measured synthesis/audio ratio to grow or shrink later requests. The
 * bounded step prevents one unusually fast or slow passage from making the
 * next chunk dramatically different.
 *
 * @param {{
 *   currentCharacters: number,
 *   synthesisMilliseconds: number,
 *   audioDurationSeconds: number,
 * }} measurement
 */
export function adaptOfflineSpeechChunkCharacters(measurement) {
  const currentCharacters = Math.min(
    OFFLINE_MAX_CHUNK_CHARACTERS,
    Math.max(
      OFFLINE_MIN_CHUNK_CHARACTERS,
      Number(measurement.currentCharacters) ||
        OFFLINE_FIRST_CHUNK_CHARACTERS,
    ),
  );
  const synthesisMilliseconds = Number(
    measurement.synthesisMilliseconds,
  );
  const audioMilliseconds = Number(measurement.audioDurationSeconds) * 1_000;

  if (
    !Number.isFinite(synthesisMilliseconds) ||
    synthesisMilliseconds <= 0 ||
    !Number.isFinite(audioMilliseconds) ||
    audioMilliseconds <= 0
  ) {
    return currentCharacters;
  }

  const synthesisRatio = synthesisMilliseconds / audioMilliseconds;
  const rawScale = OFFLINE_TARGET_SYNTHESIS_RATIO / synthesisRatio;
  const boundedScale = Math.min(2, Math.max(0.75, rawScale));
  const adapted = Math.round((currentCharacters * boundedScale) / 8) * 8;
  return Math.min(
    OFFLINE_MAX_CHUNK_CHARACTERS,
    Math.max(OFFLINE_MIN_CHUNK_CHARACTERS, adapted),
  );
}

/**
 * Initialization and synthesis each report their own 0-100 progress. Project
 * them into one monotonic player bar so a warmed model at 100% does not make a
 * still-running first synthesis falsely appear complete.
 *
 * @param {"initializing" | "synthesizing"} phase
 * @param {number} progress
 */
export function mapOfflineNarrationPhaseProgress(phase, progress) {
  const [start, end] = NARRATION_PHASE_RANGES[phase];
  const normalized = Math.min(
    100,
    Math.max(0, Number.isFinite(progress) ? progress : 0),
  );
  return Math.round(start + (normalized / 100) * (end - start));
}

/**
 * Project worker-local progress into truthful, non-overlapping install phases.
 * Model initialization starts its own 0-100 scale after the files finish, so
 * showing that raw value would leave the UI apparently frozen at 99%.
 *
 * @param {string | undefined} stage
 * @param {number} progress
 */
export function mapOfflineInstallProgress(stage, progress) {
  const phase = INSTALL_PHASE_RANGES[stage ?? "downloading"] ??
    INSTALL_PHASE_RANGES.downloading;
  const normalized = Math.min(
    100,
    Math.max(0, Number.isFinite(progress) ? progress : 0),
  );
  return Math.round(phase[0] + (normalized / 100) * (phase[1] - phase[0]));
}
