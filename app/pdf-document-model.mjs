import { buildDocumentModel } from "./document-model.mjs";

export const PDF_DOCUMENT_STORAGE_VERSION = 1;

export function createPdfModelCursor() {
  return {
    characterOffset: 0,
    paragraphIndex: 0,
    sentenceIndex: 0,
    wordIndex: 0,
  };
}

/**
 * Convert one extracted PDF page into an independently serializable slice of
 * the shared reader model. Global indices are assigned in the worker so the
 * browser never has to retokenize an expanding document.
 *
 * @param {string[]} paragraphs
 * @param {ReturnType<typeof createPdfModelCursor>} cursor
 */
export function buildPdfDocumentChunk(paragraphs, cursor) {
  const local = buildDocumentModel(paragraphs, {
    paragraphsStartSentences: true,
  });
  const separatorLength = cursor.paragraphIndex > 0 && paragraphs.length ? 2 : 0;
  const characterStart = cursor.characterOffset + separatorLength;
  const tokens = local.tokens.map((token) => ({
    ...token,
    index: token.index + cursor.wordIndex,
    start: token.start + characterStart,
    end: token.end + characterStart,
    paragraphIndex: token.paragraphIndex + cursor.paragraphIndex,
    sentenceIndex: token.sentenceIndex + cursor.sentenceIndex,
  }));
  const renderedParagraphs = local.paragraphs.map((paragraph) =>
    paragraph.map((segment) => {
      const shifted = {
        ...segment,
        focusTokenIndex: Number.isFinite(segment.focusTokenIndex)
          ? segment.focusTokenIndex + cursor.wordIndex
          : segment.focusTokenIndex,
        sentenceIndex: segment.sentenceIndex + cursor.sentenceIndex,
      };
      if (segment.tokenIndex !== undefined) {
        shifted.tokenIndex = segment.tokenIndex + cursor.wordIndex;
      }
      return shifted;
    }),
  );
  const tokenSentences = tokens.map((token) => token.sentenceIndex);
  const tokenParagraphs = tokens.map((token) => token.paragraphIndex);
  const sentenceStarts = [];
  let previousSentence = null;
  for (const token of tokens) {
    if (token.sentenceIndex === previousSentence) continue;
    sentenceStarts.push(token.index);
    previousSentence = token.sentenceIndex;
  }
  const lastToken = tokens.at(-1);
  const nextCursor = {
    characterOffset: characterStart + local.fullText.length,
    paragraphIndex: cursor.paragraphIndex + paragraphs.length,
    sentenceIndex: lastToken
      ? lastToken.sentenceIndex + 1
      : cursor.sentenceIndex,
    wordIndex: cursor.wordIndex + tokens.length,
  };

  return {
    characterStart,
    fullText: local.fullText,
    paragraphStart: cursor.paragraphIndex,
    paragraphs,
    renderedParagraphs,
    sentenceStarts,
    tokenParagraphs,
    tokenSentences,
    tokens,
    wordStart: cursor.wordIndex,
    nextCursor,
  };
}

/**
 * @returns {{
 *   fullText: string,
 *   paragraphs: Array<Array<{
 *     text: string,
 *     tokenIndex?: number,
 *     focusTokenIndex?: number,
 *     sentenceIndex: number,
 *   }>>,
 *   paragraphCharacterCounts: number[],
 *   sentenceStarts: number[],
 *   tokenParagraphs: number[],
 *   tokenSentences: number[],
 *   tokens: Array<{
 *     index: number,
 *     text: string,
 *     start: number,
 *     end: number,
 *     paragraphIndex: number,
 *     sentenceIndex: number,
 *   }>,
 * }}
 */
export function createProgressiveDocumentModel() {
  return {
    fullText: "",
    paragraphs: [],
    paragraphCharacterCounts: [],
    sentenceStarts: [],
    tokenParagraphs: [],
    tokenSentences: [],
    tokens: [],
  };
}

/**
 * Mutate one stable in-memory model with a bounded worker chunk. Keeping the
 * large token arrays stable avoids an O(total document) clone for every page.
 *
 * @param {ReturnType<typeof createProgressiveDocumentModel>} model
 * @param {ReturnType<typeof buildPdfDocumentChunk>} chunk
 */
export function appendPdfDocumentChunk(model, chunk) {
  if (model.fullText && chunk.fullText) model.fullText += "\n\n";
  model.fullText += chunk.fullText;
  model.paragraphs.push(...chunk.renderedParagraphs);
  model.paragraphCharacterCounts.push(
    ...chunk.paragraphs.map((paragraph) => paragraph.length),
  );
  model.tokens.push(...chunk.tokens);
  model.tokenSentences.push(...chunk.tokenSentences);
  model.tokenParagraphs.push(...chunk.tokenParagraphs);
  model.sentenceStarts.push(...chunk.sentenceStarts);
  return model;
}

export function pdfRenderRequestKey({ documentId, revision, pageNumber, scale }) {
  return `${documentId}:${revision}:${pageNumber}:${Number(scale).toFixed(3)}`;
}

export function prioritizePdfRenderRequests(requests) {
  return [...requests].sort(
    (left, right) =>
      Number(Boolean(right.visible)) - Number(Boolean(left.visible)) ||
      Number(left.distance ?? 0) - Number(right.distance ?? 0) ||
      Number(left.sequence ?? 0) - Number(right.sequence ?? 0),
  );
}

/** Keep one current pending state per page; disabled pages leave the queue. */
export function coalescePdfRenderRequests(requests, incoming) {
  const remaining = requests.filter(
    (request) => request.pageNumber !== incoming.pageNumber,
  );
  if (incoming.enabled === false) return remaining;
  return [...remaining, incoming];
}

export function updatePdfRenderQueue(
  requests,
  incoming,
  { fallbackActive = false } = {},
) {
  if (fallbackActive) return [];
  return coalescePdfRenderRequests(requests, incoming);
}

export function resolvePdfRenderFallbackQueueActivation(
  activeRequest,
) {
  return {
    cancelSequence: activeRequest?.sequence ?? null,
    fallbackActive: true,
    requests: [],
  };
}

/**
 * Decide whether current page state replaces, follows, or cancels an active
 * raster. A same-scale priority update never enqueues duplicate work.
 */
export function reconcilePdfActiveRenderRequest(
  activeRequest,
  incoming,
  { activeCancelled = false } = {},
) {
  if (!activeRequest || activeRequest.pageNumber !== incoming.pageNumber) {
    return {
      cancelActive: false,
      enqueue: incoming.enabled !== false,
      updatedActive: activeRequest,
    };
  }
  if (incoming.enabled === false) {
    return {
      cancelActive: !activeCancelled,
      enqueue: false,
      updatedActive: activeRequest,
    };
  }
  if (activeCancelled) {
    return {
      cancelActive: false,
      enqueue: true,
      updatedActive: activeRequest,
    };
  }
  const activeScale = Number(activeRequest.scale);
  const incomingScale = Number(incoming.scale);
  if (incomingScale < activeScale) {
    return {
      cancelActive: true,
      enqueue: true,
      updatedActive: activeRequest,
    };
  }
  if (incomingScale === activeScale) {
    return {
      cancelActive: false,
      enqueue: false,
      updatedActive: {
        ...activeRequest,
        distance: incoming.distance,
        visible: incoming.visible,
      },
    };
  }
  return {
    cancelActive: false,
    enqueue: true,
    updatedActive: activeRequest,
  };
}

/** Drop duplicate previews while retaining a queued sharper page raster. */
export function retainPdfRenderUpgrades(requests, pageNumber, renderedScale) {
  const completedScale = Number(renderedScale);
  return requests.filter(
    (request) =>
      request.pageNumber !== pageNumber ||
      Number(request.scale) > completedScale,
  );
}
