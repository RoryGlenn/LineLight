const WORD_PATTERN =
  /[\p{L}\p{N}]+(?:[’'-][\p{L}\p{N}]+)*|[^\s]/gu;
const IS_WORD = /^[\p{L}\p{N}]/u;

/**
 * Build the token/segment model shared by Focus view and narration. Paragraph
 * starts remain part of the same sentence by default, preserving TXT and EPUB
 * navigation. PDF extraction can opt into structural paragraph boundaries for
 * punctuation-free covers, titles, and headings.
 *
 * @param {string[]} paragraphs
 * @param {{ paragraphsStartSentences?: boolean }} [options]
 */
export function buildDocumentModel(paragraphs, options = {}) {
  const fullText = paragraphs.join("\n\n");
  const tokens = [];
  const renderedParagraphs = [];
  let documentOffset = 0;
  let sentenceIndex = 0;

  paragraphs.forEach((paragraph, paragraphIndex) => {
    if (
      options.paragraphsStartSentences === true &&
      paragraphIndex > 0 &&
      tokens.length > 0 &&
      tokens.at(-1)?.sentenceIndex === sentenceIndex
    ) {
      sentenceIndex += 1;
    }
    const segments = [];
    let previousEnd = 0;

    for (const match of paragraph.matchAll(WORD_PATTERN)) {
      const localStart = match.index ?? 0;
      const text = match[0];
      const isWord = IS_WORD.test(text);
      const nearbyTokenIndex = isWord
        ? tokens.length
        : Math.max(0, tokens.length - 1);
      if (localStart > previousEnd) {
        segments.push({
          text: paragraph.slice(previousEnd, localStart),
          focusTokenIndex: nearbyTokenIndex,
          sentenceIndex,
        });
      }

      if (isWord) {
        const tokenIndex = tokens.length;
        const start = documentOffset + localStart;
        tokens.push({
          index: tokenIndex,
          text,
          start,
          end: start + text.length,
          paragraphIndex,
          sentenceIndex,
        });
        segments.push({
          text,
          tokenIndex,
          focusTokenIndex: tokenIndex,
          sentenceIndex,
        });
      } else {
        segments.push({
          text,
          focusTokenIndex: nearbyTokenIndex,
          sentenceIndex,
        });
      }

      if (/[.!?]/.test(text)) sentenceIndex += 1;
      previousEnd = localStart + text.length;
    }

    if (previousEnd < paragraph.length) {
      segments.push({
        text: paragraph.slice(previousEnd),
        focusTokenIndex: Math.max(0, tokens.length - 1),
        sentenceIndex,
      });
    }

    renderedParagraphs.push(segments);
    documentOffset +=
      paragraph.length + (paragraphIndex < paragraphs.length - 1 ? 2 : 0);
  });

  return { fullText, tokens, paragraphs: renderedParagraphs };
}
