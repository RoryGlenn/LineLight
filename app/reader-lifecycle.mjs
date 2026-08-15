/**
 * Keep asynchronous startup restoration from replacing a newer user action.
 * The caller owns the monotonically increasing generation; this helper keeps
 * the cancellation and generation checks identical at every await boundary.
 */
export function isReaderLifecycleRestoreCurrent({
  cancelled = false,
  currentGeneration,
  restoreGeneration,
}) {
  return (
    cancelled !== true &&
    Number.isInteger(currentGeneration) &&
    Number.isInteger(restoreGeneration) &&
    currentGeneration === restoreGeneration
  );
}
