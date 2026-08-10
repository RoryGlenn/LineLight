/** Serialize page rasters and share an identical in-flight request. */
export function createPdfRasterScheduler(render) {
  let pending = null;
  let pendingKey = "";

  return {
    async run(pageNumber, scale, metadata) {
      const key = `${pageNumber}:${Number(scale).toFixed(3)}`;
      while (pending) {
        const activeTask = pending;
        if (pendingKey === key) {
          await activeTask;
          return;
        }
        await activeTask.catch(() => undefined);
      }
      const task = Promise.resolve().then(() =>
        render(pageNumber, scale, metadata),
      );
      pending = task;
      pendingKey = key;
      try {
        await task;
      } finally {
        if (pending === task) {
          pending = null;
          pendingKey = "";
        }
      }
    },
    getInFlightKey() {
      return pendingKey || null;
    },
  };
}
