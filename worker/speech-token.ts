export type SpeechEnvironment = {
  AZURE_SPEECH_KEY?: string;
  AZURE_SPEECH_REGION?: string;
};

type CachedSpeechToken = {
  token: string;
  region: string;
  expiresAt: number;
};

const TOKEN_CACHE_MILLISECONDS = 8 * 60 * 1_000;
const TOKEN_REQUEST_TIMEOUT_MILLISECONDS = 8_000;

let cachedToken: CachedSpeechToken | null = null;
let tokenRequest: Promise<CachedSpeechToken> | null = null;

function jsonResponse(body: object, status: number) {
  return Response.json(body, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/json; charset=utf-8",
    },
  });
}

async function requestSpeechToken(
  key: string,
  region: string,
): Promise<CachedSpeechToken> {
  const response = await fetch(
    `https://${region}.api.cognitive.microsoft.com/sts/v1.0/issueToken`,
    {
      method: "POST",
      headers: {
        "Ocp-Apim-Subscription-Key": key,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MILLISECONDS),
    },
  );

  if (!response.ok) {
    throw new Error(`Azure Speech authorization returned ${response.status}.`);
  }

  const token = (await response.text()).trim();
  if (!token) {
    throw new Error("Azure Speech authorization returned an empty token.");
  }

  return {
    token,
    region,
    expiresAt: Date.now() + TOKEN_CACHE_MILLISECONDS,
  };
}

export async function handleSpeechTokenRequest(
  request: Request,
  speechEnvironment: SpeechEnvironment,
) {
  if (request.method !== "GET") {
    return jsonResponse(
      { code: "method_not_allowed", message: "Use GET for speech authorization." },
      405,
    );
  }

  const fetchSite = request.headers.get("Sec-Fetch-Site");
  if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none") {
    return jsonResponse(
      {
        code: "forbidden",
        message: "Speech authorization must come from LineLight.",
      },
      403,
    );
  }

  const key = speechEnvironment.AZURE_SPEECH_KEY?.trim();
  const region = speechEnvironment.AZURE_SPEECH_REGION?.trim().toLowerCase();

  if (!key || !region) {
    return jsonResponse(
      {
        code: "not_configured",
        message:
          "Natural voice is not configured yet. Add Azure Speech credentials, or use the private device voice.",
      },
      503,
    );
  }

  if (!/^[a-z0-9-]+$/.test(region)) {
    return jsonResponse(
      {
        code: "invalid_region",
        message: "The configured Azure Speech region is invalid.",
      },
      500,
    );
  }

  if (
    cachedToken &&
    cachedToken.region === region &&
    cachedToken.expiresAt > Date.now() + 30_000
  ) {
    return jsonResponse(cachedToken, 200);
  }

  tokenRequest ??= requestSpeechToken(key, region);

  try {
    const speechToken = await tokenRequest;
    cachedToken = speechToken;
    return jsonResponse(speechToken, 200);
  } catch {
    cachedToken = null;
    return jsonResponse(
      {
        code: "authorization_failed",
        message:
          "LineLight could not connect to Azure Speech. Check the configured key and region.",
      },
      502,
    );
  } finally {
    tokenRequest = null;
  }
}
