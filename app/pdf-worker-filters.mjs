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
      const alpha = Math.round(
        (0.3 * data[offset] +
          0.59 * data[offset + 1] +
          0.11 * data[offset + 2]) *
          (data[offset + 3] / 255),
      );
      data[offset + 3] = filter.map?.[alpha] ?? alpha;
      continue;
    }
    if (filter.kind === "alpha") {
      data[offset + 3] = filter.map?.[data[offset + 3]] ?? data[offset + 3];
      continue;
    }
    if (filter.kind === "transfer") {
      const maps = filter.maps;
      const red = maps?.[0];
      const green = maps?.[1] ?? red;
      const blue = maps?.[2] ?? red;
      data[offset] = red?.[data[offset]] ?? data[offset];
      data[offset + 1] = green?.[data[offset + 1]] ?? data[offset + 1];
      data[offset + 2] = blue?.[data[offset + 2]] ?? data[offset + 2];
    }
  }
  return pixels;
}

export function isPdfWorkerFilterSupported(filter) {
  return ["alpha", "luminosity", "transfer"].includes(filter?.kind);
}
