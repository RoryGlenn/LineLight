/**
 * Keep worker responses scoped to the exact operation that created them.
 * Both identifiers matter because document ids are intentionally reused when
 * an interrupted local import is resumed.
 */
export function isCurrentPdfSession(session, message) {
  return Boolean(
    session &&
      message &&
      session.jobId === message.jobId &&
      session.revision === message.revision,
  );
}

/** Release the only transferable payload that can retain raster memory. */
export function discardStalePdfMessage(message) {
  if (message?.type === "bitmap") message.bitmap?.close?.();
}

/** A cancel request must never terminate a newer job in the same worker. */
export function isPdfCancellationForSession(session, request) {
  return request?.type === "cancel" && isCurrentPdfSession(session, request);
}

/**
 * Background extraction is not eligible until page one is durable and its
 * first raster attempt has settled (either bitmap or explicit fallback).
 */
export function canStartPdfPage(pageNumber, milestones) {
  return (
    pageNumber === 1 ||
    Boolean(milestones?.pageOnePersisted && milestones?.pageOneRasterSettled)
  );
}

/** Page-one raster work starts only after its durable model is published. */
export function canStartPdfInitialRaster(milestones) {
  return Boolean(milestones?.pageOnePersisted && milestones?.pageOnePosted);
}

/** Stored page records may mount while the nested PDF parser is still opening. */
export async function waitForPdfDocumentReady(context) {
  if (context?.document) return context.document;
  if (!context?.documentReady) return null;
  await context.documentReady;
  return context.document ?? null;
}

/**
 * A PDF.js module worker announces its MessageHandler before it can accept a
 * supplied-port PDFWorker. Waiting for that protocol message also turns worker
 * load/CSP failures into a bounded error instead of a permanently pending PDF.
 * @param {EventTarget} port
 * @param {{signal?: AbortSignal, timeoutMs?: number}} [options]
 */
export function waitForPdfParserWorkerReady(
  port,
  { signal, timeoutMs = 10_000 } = {},
) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      port.removeEventListener("message", onMessage);
      port.removeEventListener("error", onError);
      signal?.removeEventListener("abort", onAbort);
      callback();
    };
    const onMessage = (event) => {
      const message = event?.data;
      if (
        message?.sourceName === "linelight-parser-bootstrap" &&
        message?.targetName === "main" &&
        message?.action === "bootstrap-error"
      ) {
        const detail = message.data?.message
          ? ` ${message.data.message}`
          : "";
        finish(() =>
          reject(new Error(`The PDF parser worker could not start.${detail}`)),
        );
        return;
      }
      if (
        message?.sourceName === "worker" &&
        message?.targetName === "main" &&
        message?.action === "ready"
      ) {
        finish(resolve);
      }
    };
    const onError = (event) => {
      const detail = event?.message ? ` ${event.message}` : "";
      finish(() =>
        reject(new Error(`The PDF parser worker could not start.${detail}`)),
      );
    };
    const onAbort = () => {
      finish(() =>
        reject(new DOMException("The PDF parser was cancelled.", "AbortError")),
      );
    };
    const timeout = setTimeout(() => {
      finish(() =>
        reject(new Error("The PDF parser worker did not become ready in time.")),
      );
    }, Math.max(1, timeoutMs));

    if (signal?.aborted) {
      onAbort();
      return;
    }
    port.addEventListener("message", onMessage);
    port.addEventListener("error", onError);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Report terminal storage outcomes only after their IndexedDB transaction is
 * confirmed. A failed cleanup leaves the staged prefix explicit and resumable
 * instead of claiming that data was removed or restored when it was not.
 */
export function resolvePdfTerminalOutcome({
  cleanup,
  cleanupConfirmed,
  pageOnePersisted,
  survivingDocument,
  legacyExpected = false,
}) {
  if (cleanup === "legacy-restore" && cleanupConfirmed) {
    return "legacy-restored";
  }
  if (cleanup === "discard" && cleanupConfirmed) return "discarded";
  if (survivingDocument?.kind === "pdf") {
    if (
      legacyExpected &&
      survivingDocument.pdfStorageVersion !== 1 &&
      Array.isArray(survivingDocument.paragraphs)
    ) {
      return "legacy-restored";
    }
    if (survivingDocument.pdfStorageVersion === 1) return "resumable";
  }
  return pageOnePersisted ? "resumable" : "uncommitted";
}
