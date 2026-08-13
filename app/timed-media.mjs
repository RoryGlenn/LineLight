export const TIMED_MEDIA_SCHEMA_VERSION = 1;
export const TIMED_MEDIA_CONFIDENT_THRESHOLD = 0.72;
export const TIMED_MEDIA_MAX_INTERPOLATION_TOKEN_SPAN = 120;
export const TIMED_MEDIA_MAX_INTERPOLATION_SECONDS = 45;

function isNonEmptyString(value) {
  return typeof value === "string" && Boolean(value.trim());
}

function isNonNegativeFiniteNumber(value) {
  return Number.isFinite(value) && value >= 0;
}

/**
 * Make a portable filename without allowing a document title to create paths
 * or browser/OS-reserved names.
 *
 * @param {unknown} value
 * @param {string} [fallback]
 */
export function sanitizeTimedMediaFilename(value, fallback = "linelight") {
  const normalized = String(value ?? "")
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .replace(/[<>:"/\\|?*]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .replace(/^[. ]+|[. ]+$/gu, "")
    .slice(0, 80)
    .trim();
  const safeFallback = String(fallback || "linelight")
    .replace(/[^\p{L}\p{N}._ -]+/gu, "")
    .trim() || "linelight";
  if (!normalized || /^(?:con|prn|aux|nul|com\d|lpt\d)$/iu.test(normalized)) {
    return safeFallback;
  }
  return normalized;
}

/** @param {unknown} value */
export function isTimedMediaAnchor(value) {
  if (!value || typeof value !== "object") return false;
  const anchor = /** @type {Record<string, any>} */ (value);
  return Boolean(
    isNonEmptyString(anchor.id) &&
      Number.isInteger(anchor.partIndex) &&
      anchor.partIndex >= 0 &&
      isNonNegativeFiniteNumber(anchor.timeSeconds) &&
      Number.isInteger(anchor.tokenIndex) &&
      anchor.tokenIndex >= 0 &&
      Number.isFinite(anchor.confidence) &&
      anchor.confidence >= 0 &&
      anchor.confidence <= 1 &&
      ["automatic", "manual", "imported", "prepared"].includes(
        anchor.source,
      ) &&
      ["phrase", "sentence", "word"].includes(anchor.granularity),
  );
}

/**
 * Keep anchors in playback order and let a manual correction replace an
 * automatic anchor at the same audio position.
 *
 * @param {unknown[]} anchors
 */
export function normalizeTimedMediaAnchors(anchors) {
  const byPosition = new Map();
  for (const value of anchors) {
    if (!isTimedMediaAnchor(value)) continue;
    const anchor = /** @type {Record<string, any>} */ (value);
    const key = `${anchor.partIndex}:${anchor.timeSeconds.toFixed(3)}`;
    const existing = byPosition.get(key);
    if (!existing || anchor.source === "manual") byPosition.set(key, anchor);
  }
  return Array.from(byPosition.values()).sort(
    (left, right) =>
      left.partIndex - right.partIndex ||
      left.timeSeconds - right.timeSeconds ||
      left.tokenIndex - right.tokenIndex,
  );
}

/**
 * Return the latest honest phrase/sentence anchor reached in one audio part.
 * Low-confidence guesses are deliberately ignored.
 *
 * @param {unknown[]} anchors
 * @param {number} partIndex
 * @param {number} timeSeconds
 * @param {number} [minimumConfidence]
 */
export function findTimedMediaAnchorAtTime(
  anchors,
  partIndex,
  timeSeconds,
  minimumConfidence = TIMED_MEDIA_CONFIDENT_THRESHOLD,
) {
  let found = null;
  for (const anchor of normalizeTimedMediaAnchors(anchors)) {
    if (anchor.partIndex < partIndex) continue;
    if (anchor.partIndex > partIndex || anchor.timeSeconds > timeSeconds) break;
    if (anchor.confidence >= minimumConfidence) found = anchor;
  }
  return found;
}

/**
 * Map a text token to a confidently aligned audio position. Interpolation is
 * allowed only between two nearby qualified anchors in the same audio part;
 * otherwise the nearest qualified phrase anchor is returned without inventing
 * timing across a long unmatched or abridged region.
 *
 * @param {unknown[]} anchors
 * @param {number} tokenIndex
 * @param {number} [minimumConfidence]
 */
export function findTimedMediaPositionForToken(
  anchors,
  tokenIndex,
  minimumConfidence = TIMED_MEDIA_CONFIDENT_THRESHOLD,
) {
  const qualified = normalizeTimedMediaAnchors(anchors).filter(
    (anchor) => anchor.confidence >= minimumConfidence,
  );
  if (!qualified.length) return null;

  let before = null;
  let after = null;
  for (const anchor of qualified) {
    if (anchor.tokenIndex === tokenIndex) {
      return { ...anchor, interpolated: false };
    }
    if (anchor.tokenIndex < tokenIndex) {
      if (!before || anchor.tokenIndex > before.tokenIndex) before = anchor;
    } else if (!after || anchor.tokenIndex < after.tokenIndex) {
      after = anchor;
    }
  }

  if (
    before &&
    after &&
    before.partIndex === after.partIndex &&
    after.tokenIndex - before.tokenIndex <=
      TIMED_MEDIA_MAX_INTERPOLATION_TOKEN_SPAN &&
    after.timeSeconds > before.timeSeconds &&
    after.timeSeconds - before.timeSeconds <=
      TIMED_MEDIA_MAX_INTERPOLATION_SECONDS
  ) {
    const tokenSpan = after.tokenIndex - before.tokenIndex;
    const fraction = (tokenIndex - before.tokenIndex) / tokenSpan;
    return {
      ...before,
      id: `${before.id}:${after.id}:${tokenIndex}`,
      timeSeconds:
        before.timeSeconds +
        fraction * (after.timeSeconds - before.timeSeconds),
      tokenIndex,
      confidence: Math.min(before.confidence, after.confidence) * 0.9,
      interpolated: true,
    };
  }

  const nearest = [before, after]
    .filter(Boolean)
    .sort(
      (left, right) =>
        Math.abs(left.tokenIndex - tokenIndex) -
        Math.abs(right.tokenIndex - tokenIndex),
    )[0];
  return nearest ? { ...nearest, interpolated: false } : null;
}

/**
 * Validate the format-neutral portion shared by generated narration exports
 * and attached audiobook alignment manifests.
 *
 * @param {unknown} value
 */
export function isTimedMediaManifest(value) {
  if (!value || typeof value !== "object") return false;
  const manifest = /** @type {Record<string, any>} */ (value);
  if (
    manifest.schemaVersion !== TIMED_MEDIA_SCHEMA_VERSION ||
    !["prepared-narration-export", "audiobook-alignment"].includes(
      manifest.kind,
    ) ||
    !isNonEmptyString(manifest.documentId) ||
    !/^[a-f0-9]{64}$/u.test(manifest.documentFingerprint) ||
    !isNonEmptyString(manifest.title) ||
    typeof manifest.author !== "string" ||
    !Number.isInteger(manifest.totalTokens) ||
    manifest.totalTokens < 0 ||
    !Array.isArray(manifest.parts) ||
    !Array.isArray(manifest.anchors) ||
    !manifest.anchors.every(isTimedMediaAnchor)
  ) {
    return false;
  }

  let previousPart = -1;
  for (const part of manifest.parts) {
    if (
      !part ||
      typeof part !== "object" ||
      !Number.isInteger(part.partIndex) ||
      part.partIndex !== previousPart + 1 ||
      !isNonEmptyString(part.filename) ||
      !isNonEmptyString(part.mimeType) ||
      !isNonNegativeFiniteNumber(part.durationSeconds) ||
      !Number.isInteger(part.startIndex) ||
      part.startIndex < 0 ||
      !Number.isInteger(part.nextIndex) ||
      part.nextIndex <= part.startIndex ||
      part.nextIndex > manifest.totalTokens
    ) {
      return false;
    }
    previousPart = part.partIndex;
  }
  for (const anchor of manifest.anchors) {
    const part = manifest.parts[anchor.partIndex];
    if (
      !part ||
      anchor.tokenIndex >= manifest.totalTokens ||
      anchor.timeSeconds > part.durationSeconds
    ) {
      return false;
    }
  }
  return true;
}

/**
 * A manifest can only be applied to the exact local book from which it was
 * exported. The caller computes the current fingerprint from local text.
 *
 * @param {unknown} value
 * @param {{ documentId: string, documentFingerprint: string, totalTokens: number }} expected
 */
export function matchesTimedMediaDocument(value, expected) {
  if (!isTimedMediaManifest(value)) return false;
  const manifest = /** @type {Record<string, any>} */ (value);
  return (
    manifest.documentId === expected.documentId &&
    manifest.documentFingerprint === expected.documentFingerprint &&
    manifest.totalTokens === expected.totalTokens
  );
}
