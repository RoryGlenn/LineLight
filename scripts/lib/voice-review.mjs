const WORD_PATTERN = /[\p{L}\p{N}]+/gu;

/**
 * Normalize text for a case- and punctuation-insensitive WER comparison.
 *
 * @param {string} text
 * @returns {string[]}
 */
export function normalizeTranscript(text) {
  return (
    text
      .normalize("NFKC")
      .toLocaleLowerCase("en-US")
      .replace(/[’']/gu, "")
      .replace(/[‐‑‒–—-]/gu, " ")
      .match(WORD_PATTERN) ?? []
  );
}

/**
 * Calculate word error rate with Levenshtein edit distance.
 *
 * @param {string} reference
 * @param {string} hypothesis
 */
export function calculateWordErrorRate(reference, hypothesis) {
  const referenceWords = normalizeTranscript(reference);
  const hypothesisWords = normalizeTranscript(hypothesis);

  if (!referenceWords.length) {
    throw new Error("Expected text must contain at least one word.");
  }

  let previous = Array.from(
    { length: hypothesisWords.length + 1 },
    (_, index) => index,
  );

  for (let referenceIndex = 1; referenceIndex <= referenceWords.length; referenceIndex += 1) {
    const current = [referenceIndex];

    for (
      let hypothesisIndex = 1;
      hypothesisIndex <= hypothesisWords.length;
      hypothesisIndex += 1
    ) {
      const substitutionCost =
        referenceWords[referenceIndex - 1] ===
        hypothesisWords[hypothesisIndex - 1]
          ? 0
          : 1;
      current[hypothesisIndex] = Math.min(
        previous[hypothesisIndex] + 1,
        current[hypothesisIndex - 1] + 1,
        previous[hypothesisIndex - 1] + substitutionCost,
      );
    }

    previous = current;
  }

  const errors = previous.at(-1);
  return {
    errors,
    hypothesisWords: hypothesisWords.length,
    referenceWords: referenceWords.length,
    wer: errors / referenceWords.length,
  };
}

function dbfs(amplitude) {
  return amplitude > 0 ? 20 * Math.log10(amplitude) : null;
}

function round(value, digits = 3) {
  if (value === null || value === undefined) return value;
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function findSilenceRegions(
  samples,
  sampleRate,
  { minimumSeconds = 0.12, thresholdDbfs = -40 } = {},
) {
  const frameSamples = Math.max(1, Math.round(sampleRate * 0.02));
  const threshold = 10 ** (thresholdDbfs / 20);
  const silentFrames = [];

  for (let start = 0; start < samples.length; start += frameSamples) {
    const end = Math.min(samples.length, start + frameSamples);
    let sumSquares = 0;

    for (let index = start; index < end; index += 1) {
      const normalized = samples[index] / 32768;
      sumSquares += normalized * normalized;
    }

    silentFrames.push({
      end,
      silent: Math.sqrt(sumSquares / (end - start)) <= threshold,
      start,
    });
  }

  const regions = [];
  let openRegion = null;

  for (const frame of silentFrames) {
    if (frame.silent && openRegion === null) openRegion = frame.start;
    if (!frame.silent && openRegion !== null) {
      regions.push({ end: frame.start, start: openRegion });
      openRegion = null;
    }
  }

  if (openRegion !== null) {
    regions.push({ end: samples.length, start: openRegion });
  }

  return regions
    .map(({ end, start }) => ({
      durationSeconds: (end - start) / sampleRate,
      endSeconds: end / sampleRate,
      startSeconds: start / sampleRate,
    }))
    .filter((region) => region.durationSeconds >= minimumSeconds)
    .map((region) => ({
      durationSeconds: round(region.durationSeconds),
      endSeconds: round(region.endSeconds),
      kind:
        region.startSeconds === 0
          ? "leading"
          : region.endSeconds >= samples.length / sampleRate
            ? "trailing"
            : "internal",
      startSeconds: round(region.startSeconds),
    }));
}

/**
 * Measure a normalized 16 kHz mono PCM waveform.
 *
 * @param {Int16Array} samples
 * @param {number} sampleRate
 */
export function analyzePcm16(samples, sampleRate) {
  if (!(samples instanceof Int16Array) || samples.length === 0) {
    throw new Error("Audio must contain PCM-16 samples.");
  }
  if (!Number.isInteger(sampleRate) || sampleRate <= 0) {
    throw new Error("Audio must have a positive sample rate.");
  }

  let clippedSamples = 0;
  let peak = 0;
  let sumSquares = 0;

  for (const sample of samples) {
    const magnitude = Math.abs(sample);
    peak = Math.max(peak, magnitude);
    if (magnitude >= 32767) clippedSamples += 1;
    const normalized = sample / 32768;
    sumSquares += normalized * normalized;
  }

  const silenceRegions = findSilenceRegions(samples, sampleRate);
  const meaningfulPauses = silenceRegions.filter(
    (region) => region.kind === "internal",
  );
  const leadingSilence = silenceRegions.find(
    (region) => region.kind === "leading",
  );
  const trailingSilence = silenceRegions.find(
    (region) => region.kind === "trailing",
  );

  return {
    clippedSamples,
    clippingPercent: round((clippedSamples / samples.length) * 100, 5),
    durationSeconds: round(samples.length / sampleRate),
    leadingSilenceSeconds: leadingSilence?.durationSeconds ?? 0,
    meaningfulPauses,
    peakDbfs: round(dbfs(peak / 32768), 2),
    rmsDbfs: round(
      dbfs(Math.sqrt(sumSquares / samples.length)),
      2,
    ),
    sampleRate,
    trailingSilenceSeconds: trailingSilence?.durationSeconds ?? 0,
  };
}

/**
 * Read the PCM-16 mono WAV emitted by the reviewer's ffmpeg normalization step.
 *
 * @param {Buffer} buffer
 */
export function parsePcm16Wav(buffer) {
  if (
    buffer.length < 44 ||
    buffer.toString("ascii", 0, 4) !== "RIFF" ||
    buffer.toString("ascii", 8, 12) !== "WAVE"
  ) {
    throw new Error("Normalized audio is not a valid RIFF/WAVE file.");
  }

  let audioFormat = null;
  let channels = null;
  let sampleRate = null;
  let bitsPerSample = null;
  let data = null;
  let offset = 12;

  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.toString("ascii", offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);
    const chunkStart = offset + 8;
    const chunkEnd = chunkStart + chunkSize;

    if (chunkEnd > buffer.length) {
      throw new Error(`WAV chunk ${chunkId} extends past the end of the file.`);
    }

    if (chunkId === "fmt " && chunkSize >= 16) {
      audioFormat = buffer.readUInt16LE(chunkStart);
      channels = buffer.readUInt16LE(chunkStart + 2);
      sampleRate = buffer.readUInt32LE(chunkStart + 4);
      bitsPerSample = buffer.readUInt16LE(chunkStart + 14);
    } else if (chunkId === "data") {
      data = buffer.subarray(chunkStart, chunkEnd);
    }

    offset = chunkEnd + (chunkSize % 2);
  }

  if (
    audioFormat !== 1 ||
    channels !== 1 ||
    bitsPerSample !== 16 ||
    sampleRate !== 16000 ||
    !data
  ) {
    throw new Error(
      "Normalized WAV must be mono 16 kHz, 16-bit integer PCM.",
    );
  }

  const samples = new Int16Array(data.length / 2);
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = data.readInt16LE(index * 2);
  }

  return { sampleRate, samples };
}

function naturalnessBand(score) {
  if (score >= 4) return "high";
  if (score >= 3.2) return "moderate";
  return "low";
}

/**
 * Combine model estimates and signal measurements into a screening result.
 *
 * @param {object} input
 * @param {string} input.audioPath
 * @param {string | null} input.expectedText
 * @param {object} input.models
 * @param {object} input.signal
 * @param {string | null} input.transcript
 * @param {number} input.utmosScore
 */
export function buildVoiceReview({
  audioPath,
  expectedText,
  models,
  signal,
  transcript,
  utmosScore,
}) {
  const intelligibility =
    expectedText && transcript
      ? calculateWordErrorRate(expectedText, transcript)
      : null;
  const referenceWordCount = expectedText
    ? normalizeTranscript(expectedText).length
    : null;
  const wordsPerMinute = referenceWordCount
    ? round((referenceWordCount / signal.durationSeconds) * 60, 1)
    : null;
  const concerns = [];

  if (utmosScore < 3.2) {
    concerns.push("Predicted naturalness is low.");
  } else if (utmosScore < 3.7) {
    concerns.push("Predicted naturalness is below the review target of 3.7.");
  }
  if (intelligibility?.wer > 0.1) {
    concerns.push(
      `Local transcription differs from the source (${round(intelligibility.wer * 100, 1)}% WER).`,
    );
  }
  if (signal.clippedSamples > 0) {
    concerns.push(
      `${signal.clippedSamples} full-scale sample${signal.clippedSamples === 1 ? "" : "s"} may be clipped.`,
    );
  }
  if (signal.rmsDbfs !== null && signal.rmsDbfs < -35) {
    concerns.push("The average level is very quiet (below -35 dBFS RMS).");
  }

  const needsAttention =
    utmosScore < 3 ||
    (intelligibility?.wer ?? 0) > 0.25 ||
    signal.clippingPercent > 0.1;
  const status = needsAttention
    ? "needs-attention"
    : concerns.length
      ? "review"
      : "looks-good";

  return {
    audioPath,
    concerns,
    intelligibility,
    models,
    naturalness: {
      band: naturalnessBand(utmosScore),
      predictedMos: round(utmosScore, 3),
      scale: "1-5",
    },
    privacy: {
      networkAccessDuringReview: false,
      uploadsAudio: false,
    },
    signal: {
      ...signal,
      wordsPerMinute,
    },
    status,
    transcript,
    warning:
      "Model scores are screening evidence, not a substitute for listening or an accessibility review.",
  };
}

function formatDbfs(value) {
  return value === null ? "silent" : `${value.toFixed(1)} dBFS`;
}

/**
 * Render the JSON review as a compact terminal report.
 *
 * @param {ReturnType<typeof buildVoiceReview>} review
 */
export function formatVoiceReview(review) {
  const statusLabels = {
    "looks-good": "Looks good",
    "needs-attention": "Needs attention",
    review: "Review recommended",
  };
  const lines = [
    `Voice review: ${review.audioPath}`,
    `Result: ${statusLabels[review.status]}`,
    `Naturalness: ${review.naturalness.predictedMos.toFixed(2)}/5 (${review.naturalness.band}, UTMOS estimate)`,
  ];

  if (review.intelligibility) {
    lines.push(
      `Intelligibility: ${(review.intelligibility.wer * 100).toFixed(1)}% WER (${review.intelligibility.errors} word error${review.intelligibility.errors === 1 ? "" : "s"})`,
      `Transcript: ${review.transcript}`,
    );
  } else {
    lines.push("Intelligibility: not measured (provide --text or --text-file)");
  }

  const pace = review.signal.wordsPerMinute
    ? `, ${review.signal.wordsPerMinute.toFixed(1)} WPM`
    : "";
  lines.push(
    `Audio: ${review.signal.durationSeconds.toFixed(2)}s${pace}, ${formatDbfs(review.signal.rmsDbfs)} RMS, ${formatDbfs(review.signal.peakDbfs)} peak`,
    `Clipping: ${review.signal.clippedSamples === 0 ? "none detected" : `${review.signal.clippedSamples} full-scale samples`}`,
    `Pauses: ${review.signal.meaningfulPauses.length} internal; ${review.signal.leadingSilenceSeconds.toFixed(2)}s leading, ${review.signal.trailingSilenceSeconds.toFixed(2)}s trailing`,
  );

  if (review.concerns.length) {
    lines.push("Concerns:", ...review.concerns.map((concern) => `- ${concern}`));
  }

  lines.push(`Note: ${review.warning}`);
  return lines.join("\n");
}
