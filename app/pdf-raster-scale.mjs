export const PDF_RASTER_SCALE_STEP = 0.25;
export const PDF_RASTER_MAX_PIXELS = 16_777_216;
export const PDF_RASTER_MAX_DIMENSION = 8_192;
export const PDF_RASTER_PREVIEW_SCALE = 1.25;

const SCALE_EPSILON = 1e-7;

function positiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function normalizedPageDistance(distance) {
  return Math.max(0, Math.trunc(Number(distance)) || 0);
}

function rasterDimensions(width, height, scale) {
  return {
    height: Math.max(1, Math.ceil(height * scale)),
    width: Math.max(1, Math.ceil(width * scale)),
  };
}

/**
 * Keep a requested full-page raster inside a bounded canvas allocation.
 * Extremely large PDF pages may need a scale below one to remain drawable.
 */
export function constrainPdfRasterScale({
  pageWidth,
  pageHeight,
  scale,
  maxPixels = PDF_RASTER_MAX_PIXELS,
  maxDimension = PDF_RASTER_MAX_DIMENSION,
}) {
  const width = positiveNumber(pageWidth, 1);
  const height = positiveNumber(pageHeight, 1);
  const requestedScale = positiveNumber(scale, 1);
  const pixelLimit = Math.max(
    1,
    Math.floor(positiveNumber(maxPixels, PDF_RASTER_MAX_PIXELS)),
  );
  const dimensionLimit = Math.max(
    1,
    Math.floor(
      positiveNumber(maxDimension, PDF_RASTER_MAX_DIMENSION),
    ),
  );
  const maximumScale = Math.max(
    Number.EPSILON,
    Math.min(
      dimensionLimit / width,
      dimensionLimit / height,
      Math.sqrt(pixelLimit / (width * height)),
    ),
  );
  let safeScale = Math.min(requestedScale, maximumScale);
  let dimensions = rasterDimensions(width, height, safeScale);
  const fits = (candidate) =>
    candidate.width <= dimensionLimit &&
    candidate.height <= dimensionLimit &&
    candidate.width * candidate.height <= pixelLimit;

  // Continuous scale limits can still overflow once the actual canvas width
  // and height are rounded upward. Find the largest scale whose integer
  // backing dimensions remain inside both limits.
  if (!fits(dimensions)) {
    let lower = 0;
    let upper = safeScale;
    for (let index = 0; index < 64; index += 1) {
      const middle = (lower + upper) / 2;
      if (fits(rasterDimensions(width, height, middle))) lower = middle;
      else upper = middle;
    }
    safeScale = lower;
    dimensions = rasterDimensions(width, height, safeScale);
  }

  return {
    capped: safeScale + SCALE_EPSILON < requestedScale,
    height: dimensions.height,
    scale: safeScale,
    width: dimensions.width,
  };
}

/**
 * Match PDF.js page units to the physical pixels occupied by the responsive
 * page. Quarter-step upward rounding prevents resize jitter and undersampling.
 */
export function resolvePdfRasterTarget({
  pageWidth,
  pageHeight,
  cssWidth,
  cssHeight,
  devicePixelRatio = 1,
  visualViewportScale = 1,
  maxPixels = PDF_RASTER_MAX_PIXELS,
  maxDimension = PDF_RASTER_MAX_DIMENSION,
}) {
  const width = positiveNumber(pageWidth, 1);
  const height = positiveNumber(pageHeight, 1);
  const renderedWidth = positiveNumber(cssWidth, width);
  const renderedHeight = positiveNumber(cssHeight, height);
  // devicePixelRatio includes desktop page zoom. visualViewport.scale stays
  // at one for that case and independently describes mobile/pinch magnification,
  // so multiplying covers both transforms without counting desktop zoom twice.
  const physicalPixelRatio =
    positiveNumber(devicePixelRatio, 1) *
    positiveNumber(visualViewportScale, 1);
  const requiredScale =
    Math.max(renderedWidth / width, renderedHeight / height) *
    physicalPixelRatio;
  const minimumScale = Math.max(1, requiredScale);
  const roundedScale =
    Math.ceil(
      (minimumScale - SCALE_EPSILON) / PDF_RASTER_SCALE_STEP,
    ) * PDF_RASTER_SCALE_STEP;

  return constrainPdfRasterScale({
    pageWidth: width,
    pageHeight: height,
    scale: roundedScale,
    maxPixels,
    maxDimension,
  });
}

export function isPdfRasterSufficient(bitmap, target) {
  return Boolean(
    bitmap &&
      Number(bitmap.width) >= Number(target.width) &&
      Number(bitmap.height) >= Number(target.height),
  );
}

/**
 * Keep sharp work tied to the real viewport. The immediately adjacent pages
 * may retain a cheap preview so scrolling reveals content before the physical-
 * pixel upgrade completes; distant mounted pages need no raster at all.
 */
export function resolvePdfPageRasterRequest({
  visible,
  distance,
  pageWidth,
  pageHeight,
  target,
}) {
  if (!target) return null;
  const normalizedDistance = normalizedPageDistance(distance);
  if (visible) {
    return { ...target, distance: 0, visible: true };
  }
  if (normalizedDistance !== 1) return null;
  return {
    ...constrainPdfRasterScale({
      pageWidth,
      pageHeight,
      scale: Math.min(Number(target.scale), PDF_RASTER_PREVIEW_SCALE),
    }),
    distance: normalizedDistance,
    visible: false,
  };
}

/** Publish one current desired state per mounted page to the worker queue. */
export function resolvePdfPageRasterDirective({
  bitmap,
  distance,
  fallbackActive = false,
  pageWidth,
  pageHeight,
  target,
  visible,
}) {
  if (!target) return null;
  const request = resolvePdfPageRasterRequest({
    visible,
    distance,
    pageWidth,
    pageHeight,
    target,
  });
  if (
    fallbackActive ||
    !request ||
    isPdfRasterSufficient(bitmap, request)
  ) {
    return {
      distance: normalizedPageDistance(distance),
      enabled: false,
      scale: request?.scale ?? 0,
      visible: Boolean(visible),
    };
  }
  return { ...request, enabled: true };
}

/** A stable key prevents prop churn or a late preview from duplicating work. */
export function pdfPageRasterDirectiveKey(directive) {
  if (!directive) return "";
  if (!directive.enabled) return "disabled";
  return [
    "enabled",
    Number(directive.scale).toFixed(6),
    directive.visible ? "visible" : "near",
    normalizedPageDistance(directive.distance),
  ].join(":");
}
