function cancellationError(message = "The PDF fallback render was cancelled.") {
  return new DOMException(message, "AbortError");
}

/** Serialize DOM-only PDF.js renders for one document revision. */
export function createPdfFallbackScheduler() {
  let active = null;
  let disposed = false;
  let queue = [];
  let sequence = 0;

  const cancelEntry = (entry) => {
    if (!entry || entry.settled || entry.cancelled) return;
    entry.cancelled = true;
    entry.controller.abort();
    if (active !== entry) {
      queue = queue.filter((candidate) => candidate !== entry);
      entry.settled = true;
      entry.reject(cancellationError());
    }
  };

  const drain = async () => {
    if (active || disposed) return;
    queue.sort(
      (left, right) =>
        Number(Boolean(right.visible)) - Number(Boolean(left.visible)) ||
        Number(left.distance) - Number(right.distance) ||
        left.sequence - right.sequence,
    );
    const next = queue.shift();
    if (!next) return;
    if (next.cancelled) {
      void drain();
      return;
    }
    active = next;
    try {
      const value = await next.run(next.controller.signal);
      if (next.cancelled) next.reject(cancellationError());
      else next.resolve(value);
    } catch (error) {
      next.reject(error);
    } finally {
      next.settled = true;
      active = null;
      void drain();
    }
  };

  return {
    schedule({ key, visible = false, distance = Number.POSITIVE_INFINITY, run }) {
      if (disposed) {
        const promise = Promise.reject(
          cancellationError("The PDF fallback scheduler was disposed."),
        );
        return { cancel() {}, promise };
      }
      if (active?.key === key) cancelEntry(active);
      for (const entry of [...queue]) {
        if (entry.key === key) cancelEntry(entry);
      }
      const controller = new AbortController();
      let resolve;
      let reject;
      const promise = new Promise((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
      });
      const entry = {
        cancelled: false,
        controller,
        distance,
        key,
        reject,
        resolve,
        run,
        sequence: sequence++,
        settled: false,
        visible,
      };
      queue.push(entry);
      void drain();
      return {
        cancel: () => cancelEntry(entry),
        promise,
      };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      cancelEntry(active);
      for (const entry of [...queue]) cancelEntry(entry);
      queue = [];
    },
    getState() {
      return {
        activeKey: active?.key ?? null,
        queuedKeys: queue.map((entry) => entry.key),
      };
    },
  };
}
