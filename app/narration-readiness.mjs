/**
 * Normalize a narration-loading milestone for display in the player.
 * Keeping the previous percentage as a floor prevents a backend retry from
 * making the readiness bar move backwards.
 *
 * @param {number} progress
 * @param {string} label
 * @param {number} [minimumProgress]
 */
export function normalizeNarrationReadiness(
  progress,
  label,
  minimumProgress = 0,
) {
  const safeMinimum = Number.isFinite(minimumProgress)
    ? Math.min(100, Math.max(0, Math.round(minimumProgress)))
    : 0;
  const safeProgress = Number.isFinite(progress)
    ? Math.min(100, Math.max(0, Math.round(progress)))
    : safeMinimum;

  return {
    progress: Math.max(safeMinimum, safeProgress),
    label: label.trim() || "Preparing narration…",
  };
}
