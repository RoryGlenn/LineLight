/**
 * Reconcile a terminal worker outcome without allowing delayed IndexedDB reads
 * to replace a document the reader opened in the meantime.
 */
export async function reconcilePdfTerminalOutcome({
  documentId,
  generation,
  getDocument,
  getGeneration,
  loadLibrary,
  onDiscarded,
  onLibrary,
  onRecovered,
  outcome,
}) {
  const isCurrent = () => getGeneration() === generation;
  if (!isCurrent()) return "stale";

  const snapshot = await loadLibrary().catch(() => null);
  if (!isCurrent()) return "stale";
  if (snapshot) onLibrary(snapshot);

  if (outcome === "legacy-restored") {
    const recovered = await getDocument(documentId).catch(() => null);
    if (!isCurrent()) return "stale";
    if (recovered) {
      onRecovered(recovered);
      return "recovered";
    }
  }

  if (!isCurrent()) return "stale";
  onDiscarded();
  return "discarded";
}
