import { resolveStoredPosition } from "./reader-navigation.mjs";

/**
 * A ready manifest can still be streaming its page records into the active
 * tab. Treat either incomplete storage or incomplete semantic text as
 * hydrating so navigation never clamps a late destination to the prefix.
 */
export function isProgressivePdfHydrating(
  manifest,
  loadedPageCount,
  loadedTokenCount,
) {
  if (!manifest) return false;
  return (
    manifest.pdfImportStatus !== "ready" ||
    Math.max(0, loadedPageCount) < Math.max(0, manifest.pdfPageCount) ||
    Math.max(0, loadedTokenCount) < Math.max(0, manifest.wordCount)
  );
}

export function requiredPdfPositionTokenCount(position) {
  const tokenIndex = Math.max(0, Math.trunc(position?.tokenIndex ?? 0));
  const contextAfter = Array.isArray(position?.contextAfter)
    ? position.contextAfter.length
    : 0;
  return tokenIndex + Math.max(1, contextAfter + 1);
}

/**
 * Resolve only against a complete-enough prefix. Contextual positions wait
 * until their original anchor and trailing context are present; exact outline
 * indices wait until that index exists. Only restored progress may clamp when
 * a changed document completes with fewer words.
 */
export function resolveProgressivePdfTarget({
  clampOnComplete = false,
  complete = false,
  position,
  requestedIndex,
  tokens,
}) {
  const safeRequestedIndex = Math.max(0, Math.trunc(requestedIndex ?? 0));
  if (position) {
    if (
      !complete &&
      tokens.length < requiredPdfPositionTokenCount(position)
    ) {
      return { status: "waiting", index: null };
    }
    const index = resolveStoredPosition(position, tokens);
    return index === null
      ? { status: complete ? "unavailable" : "waiting", index: null }
      : { status: "resolved", index };
  }
  if (safeRequestedIndex < tokens.length) {
    return { status: "resolved", index: safeRequestedIndex };
  }
  if (complete && clampOnComplete && tokens.length) {
    return { status: "resolved", index: tokens.length - 1 };
  }
  return { status: complete ? "unavailable" : "waiting", index: null };
}

export function loadedPdfPageNumber(summaries, targetIndex, preferredPage) {
  if (Number.isInteger(preferredPage) && preferredPage > 0) {
    return preferredPage;
  }
  if (!summaries.length) return null;
  let pageNumber = summaries[0].pageNumber;
  for (const summary of summaries) {
    if (summary.wordStart > targetIndex) break;
    pageNumber = summary.pageNumber;
  }
  return pageNumber;
}

export function shouldDeferPdfProgressWrite(
  pendingRestore,
  documentId,
  activeWord,
) {
  return Boolean(
    pendingRestore &&
      pendingRestore.documentId === documentId &&
      pendingRestore.targetIndex !== activeWord,
  );
}

/** Explicit playback/navigation from the visible position supersedes a restore. */
export function acceptCurrentPdfPosition(
  pendingTarget,
  pendingRestore,
  documentId,
  activeWord,
) {
  const targetIsCurrent = pendingTarget?.documentId === documentId;
  const restoreIsCurrent = pendingRestore?.documentId === documentId;
  return {
    accepted: Boolean(targetIsCurrent || restoreIsCurrent),
    pendingRestore: restoreIsCurrent ? null : pendingRestore,
    pendingTarget: targetIsCurrent ? null : pendingTarget,
    progressIndex:
      targetIsCurrent || restoreIsCurrent
        ? Math.max(0, Math.trunc(activeWord))
        : null,
  };
}
