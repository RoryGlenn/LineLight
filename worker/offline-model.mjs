import { resolveOfflineModelRequest } from "../app/offline-model-manifest.mjs";

const IMMUTABLE_CACHE_CONTROL = "public, max-age=31536000, immutable";
const FORWARDED_REQUEST_HEADERS = [
  "if-modified-since",
  "if-none-match",
  "range",
];
const FORWARDED_RESPONSE_HEADERS = [
  "accept-ranges",
  "content-length",
  "content-range",
  "content-type",
  "etag",
  "last-modified",
];

function textResponse(request, message, status) {
  return new Response(request.method === "HEAD" ? null : message, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "text/plain; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

/**
 * Stream one pinned, allowlisted Kokoro asset through the LineLight origin.
 * The injected fetch argument keeps route policy testable without network I/O.
 *
 * @param {Request} request
 * @param {(request: Request) => Promise<Response>} [fetchUpstream]
 */
export async function handleOfflineModelRequest(
  request,
  fetchUpstream = fetch,
) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    const response = textResponse(request, "Method not allowed.", 405);
    response.headers.set("Allow", "GET, HEAD");
    return response;
  }

  const resolved = resolveOfflineModelRequest(new URL(request.url).pathname);
  if (!resolved) {
    return textResponse(request, "Offline model asset not found.", 404);
  }

  const upstreamHeaders = new Headers();
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = request.headers.get(name);
    if (value) upstreamHeaders.set(name, value);
  }

  let upstreamResponse;
  try {
    upstreamResponse = await fetchUpstream(
      new Request(resolved.upstreamUrl, {
        method: request.method,
        headers: upstreamHeaders,
        redirect: "follow",
      }),
    );
  } catch {
    return textResponse(
      request,
      "The included offline model is temporarily unavailable.",
      502,
    );
  }

  if (!upstreamResponse.ok && upstreamResponse.status !== 304) {
    return textResponse(
      request,
      "The included offline model could not be loaded.",
      502,
    );
  }

  const headers = new Headers();
  for (const name of FORWARDED_RESPONSE_HEADERS) {
    const value = upstreamResponse.headers.get(name);
    if (value) headers.set(name, value);
  }
  headers.set("Cache-Control", IMMUTABLE_CACHE_CONTROL);
  headers.set("CDN-Cache-Control", IMMUTABLE_CACHE_CONTROL);
  headers.set("Cross-Origin-Resource-Policy", "same-origin");
  headers.set("X-Content-Type-Options", "nosniff");

  return new Response(upstreamResponse.body, {
    status: upstreamResponse.status,
    statusText: upstreamResponse.statusText,
    headers,
  });
}
