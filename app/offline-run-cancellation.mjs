export const OFFLINE_RUN_CANCELLATION_WATCHDOG_MILLISECONDS = 750;

function isPositiveInteger(value) {
  return Number.isInteger(value) && value > 0;
}

function getOfflineWasmRunMailbox(run) {
  if (
    typeof SharedArrayBuffer === "undefined" ||
    !(run?.sharedBuffer instanceof SharedArrayBuffer) ||
    !isPositiveInteger(run.generation) ||
    run.generation > 0xffffffff ||
    !Number.isInteger(run.activeGenerationIndex) ||
    !Number.isInteger(run.cancellationGenerationIndex) ||
    run.activeGenerationIndex < 0 ||
    run.cancellationGenerationIndex !== run.activeGenerationIndex + 1
  ) {
    return null;
  }

  try {
    const mailbox = new Uint32Array(run.sharedBuffer);
    if (
      run.cancellationGenerationIndex >= mailbox.length ||
      Atomics.load(mailbox, run.activeGenerationIndex) !== run.generation
    ) {
      return null;
    }
    return mailbox;
  } catch {
    return null;
  }
}

/**
 * Request cancellation through the exposed active/request pair of LineLight's
 * three-cell mailbox; the executor-observed acknowledgement cell remains
 * runtime-private. This helper intentionally contains no ORT import so the
 * browser main thread does not load the inference runtime.
 *
 * @param {{
 *   generation: number,
 *   sharedBuffer: SharedArrayBuffer,
 *   activeGenerationIndex: number,
 *   cancellationGenerationIndex: number,
 * }} run
 */
export function requestOfflineWasmRunCancellation(run) {
  const mailbox = getOfflineWasmRunMailbox(run);
  if (!mailbox) return false;
  try {
    Atomics.store(
      mailbox,
      run.cancellationGenerationIndex,
      run.generation,
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Track page-owned cancellation state across asynchronous Worker messages.
 * A request remains canceled after an ORT run-end event: only the worker's
 * terminal acknowledgement may release its watchdog and generation state.
 *
 * @param {{
 *   timeoutMilliseconds?: number,
 *   now?: () => number,
 *   scheduleTimeout?: (callback: () => void, milliseconds: number) => unknown,
 *   clearScheduledTimeout?: (handle: unknown) => void,
 *   onTimeout?: (details: {
 *     id: number,
 *     workerEpoch: number,
 *     requestedAtMilliseconds: number,
 *     activeGeneration: number | null,
 *   }) => void,
 * }} [options]
 */
export function createOfflineRunCancellationController(options = {}) {
  const timeoutMilliseconds =
    options.timeoutMilliseconds ??
    OFFLINE_RUN_CANCELLATION_WATCHDOG_MILLISECONDS;
  const now = options.now ?? (() => performance.now());
  const scheduleTimeout =
    options.scheduleTimeout ??
    ((callback, milliseconds) => setTimeout(callback, milliseconds));
  const clearScheduledTimeout =
    options.clearScheduledTimeout ?? ((handle) => clearTimeout(handle));
  const onTimeout = options.onTimeout ?? (() => undefined);
  const requests = new Map();

  function armWatchdog(id, state) {
    if (
      !state.cancelRequested ||
      !state.activeRun ||
      state.timeoutHandle !== undefined
    ) {
      return false;
    }
    const workerEpoch = state.workerEpoch;
    state.timeoutHandle = scheduleTimeout(() => {
      const current = requests.get(id);
      if (
        current !== state ||
        !current.cancelRequested ||
        current.workerEpoch !== workerEpoch
      ) {
        return;
      }
      current.timeoutHandle = undefined;
      onTimeout({
        id,
        workerEpoch,
        requestedAtMilliseconds: current.requestedAtMilliseconds,
        activeGeneration: current.activeRun?.generation ?? null,
      });
    }, timeoutMilliseconds);
    return true;
  }

  function clearRequest(id, workerEpoch) {
    const state = requests.get(id);
    if (!state || state.workerEpoch !== workerEpoch) return false;
    if (state.timeoutHandle !== undefined) {
      clearScheduledTimeout(state.timeoutHandle);
    }
    requests.delete(id);
    return true;
  }

  return {
    register(id, workerEpoch) {
      if (!isPositiveInteger(id) || !isPositiveInteger(workerEpoch)) {
        return false;
      }
      const previous = requests.get(id);
      if (previous?.timeoutHandle !== undefined) {
        clearScheduledTimeout(previous.timeoutHandle);
      }
      requests.set(id, {
        workerEpoch,
        cancelRequested: false,
        requestedAtMilliseconds: null,
        activeRun: null,
        timeoutHandle: undefined,
      });
      return true;
    },

    request(id, workerEpoch) {
      const state = requests.get(id);
      if (!state || state.workerEpoch !== workerEpoch) return false;

      if (!state.cancelRequested) {
        state.cancelRequested = true;
        state.requestedAtMilliseconds = now();
      }

      if (!state.activeRun) return false;
      armWatchdog(id, state);
      return requestOfflineWasmRunCancellation(state.activeRun);
    },

    observeStart(message, workerEpoch) {
      const state = requests.get(message?.id);
      if (!state || state.workerEpoch !== workerEpoch) return false;
      const run = {
        generation: message.generation,
        sharedBuffer: message.sharedBuffer,
        activeGenerationIndex: message.activeGenerationIndex,
        cancellationGenerationIndex: message.cancellationGenerationIndex,
      };
      if (!getOfflineWasmRunMailbox(run)) return false;
      state.activeRun = run;
      if (!state.cancelRequested) return false;
      armWatchdog(message.id, state);
      return requestOfflineWasmRunCancellation(run);
    },

    observeEnd(message, workerEpoch) {
      const state = requests.get(message?.id);
      if (
        !state ||
        state.workerEpoch !== workerEpoch ||
        state.activeRun?.generation !== message.generation
      ) {
        return false;
      }
      state.activeRun = null;
      return true;
    },

    complete(id, workerEpoch) {
      return clearRequest(id, workerEpoch);
    },

    resetEpoch(workerEpoch) {
      let cleared = 0;
      for (const [id, state] of requests) {
        if (state.workerEpoch === workerEpoch && clearRequest(id, workerEpoch)) {
          cleared += 1;
        }
      }
      return cleared;
    },

    snapshot(id) {
      const state = requests.get(id);
      if (!state) return null;
      return {
        workerEpoch: state.workerEpoch,
        cancelRequested: state.cancelRequested,
        requestedAtMilliseconds: state.requestedAtMilliseconds,
        activeGeneration: state.activeRun?.generation ?? null,
        watchdogActive: state.timeoutHandle !== undefined,
      };
    },
  };
}
