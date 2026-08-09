/**
 * Apply the PDF.js filters that affect ordinary page and soft-mask rendering.
 * The returned pixels are consumed inside a dedicated worker, so this never
 * adds work to Window while preserving the alpha semantics of PDF soft masks.
 */
export function applyPdfWorkerFilter(pixels, filter) {
  if (!pixels || !filter) return pixels;
  const data = pixels.data ?? pixels;
  for (let offset = 0; offset < data.length; offset += 4) {
    if (filter.kind === "luminosity") {
      const alpha =
        0.3 * data[offset] +
        0.59 * data[offset + 1] +
        0.11 * data[offset + 2];
      // Assignment through Uint8ClampedArray matches the browser's
      // feColorMatrix output quantization, including half-to-even values.
      data[offset + 3] = alpha;
      if (filter.map) {
        data[offset + 3] = filter.map[data[offset + 3]];
      }
      continue;
    }
    if (filter.kind === "alpha") {
      data[offset + 3] = filter.map?.[data[offset + 3]] ?? data[offset + 3];
      continue;
    }
  }
  return pixels;
}

export function isPdfWorkerFilterSupported(filter) {
  return ["alpha", "luminosity"].includes(filter?.kind);
}
