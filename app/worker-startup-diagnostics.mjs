const MAX_DIAGNOSTIC_VALUE_LENGTH = 500;

function boundedDiagnosticText(value) {
  if (typeof value !== "string") return "";
  return value
    .replace(/[\u0000-\u001f\u007f]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, MAX_DIAGNOSTIC_VALUE_LENGTH);
}

function safeUrl(value) {
  const text = boundedDiagnosticText(value);
  if (!text) return "";

  try {
    const url = new URL(text);
    url.username = "";
    url.password = "";
    url.hash = "";
    return boundedDiagnosticText(url.href);
  } catch {
    return text;
  }
}

function positiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function errorDescription(error) {
  if (error instanceof Error) {
    const name = boundedDiagnosticText(error.name);
    const message = boundedDiagnosticText(error.message);
    return [name, message].filter(Boolean).join(": ");
  }
  return boundedDiagnosticText(error);
}

/**
 * Format a useful local Worker failure without serializing an ErrorEvent,
 * stack, document text, narration text, or arbitrary event properties.
 *
 * @param {{
 *   workerUrl: string;
 *   message?: unknown;
 *   error?: unknown;
 *   filename?: unknown;
 *   lineno?: unknown;
 *   colno?: unknown;
 * }} details
 */
export function describeWorkerStartupFailure(details) {
  const diagnostics = [];
  const workerUrl = safeUrl(details.workerUrl);
  const message = boundedDiagnosticText(details.message);
  const error = errorDescription(details.error);
  const filename = safeUrl(details.filename);
  const line = positiveInteger(details.lineno);
  const column = positiveInteger(details.colno);

  if (workerUrl) diagnostics.push(`worker URL: ${workerUrl}`);
  if (message) diagnostics.push(`message: ${message}`);
  if (error && error !== message) diagnostics.push(`error: ${error}`);
  if (filename) diagnostics.push(`source: ${filename}`);
  if (line !== null) diagnostics.push(`line: ${line}`);
  if (column !== null) diagnostics.push(`column: ${column}`);

  const suffix = diagnostics.length
    ? ` Worker diagnostics: ${diagnostics.join("; ")}.`
    : "";
  return `The offline voice worker stopped unexpectedly.${suffix}`;
}
