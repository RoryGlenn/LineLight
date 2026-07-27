export type AzureWordBoundary = {
  audioOffsetSeconds: number;
  durationSeconds: number;
  text: string;
  textOffset: number;
  wordLength: number;
};

export type AzureSpeechResult = {
  audioData: ArrayBuffer;
  boundaries: AzureWordBoundary[];
};

type SpeechToken = {
  token: string;
  region: string;
  expiresAt: number;
};

type SpeechErrorPayload = {
  code?: string;
  message?: string;
};

export class AzureSpeechError extends Error {
  code: string;

  constructor(message: string, code = "synthesis_failed") {
    super(message);
    this.name = "AzureSpeechError";
    this.code = code;
  }
}

let cachedSpeechToken: SpeechToken | null = null;

function abortError() {
  return new DOMException("Speech synthesis was canceled.", "AbortError");
}

async function getSpeechToken(signal?: AbortSignal) {
  if (
    cachedSpeechToken &&
    cachedSpeechToken.expiresAt > Date.now() + 30_000
  ) {
    return cachedSpeechToken;
  }

  const response = await fetch("/api/speech/token", {
    method: "GET",
    headers: { Accept: "application/json" },
    cache: "no-store",
    signal,
  });
  const payload = (await response.json().catch(() => ({}))) as
    | SpeechToken
    | SpeechErrorPayload;

  if (!response.ok) {
    const errorPayload = payload as SpeechErrorPayload;
    throw new AzureSpeechError(
      errorPayload.message ?? "Natural voice authorization failed.",
      errorPayload.code,
    );
  }

  const tokenPayload = payload as SpeechToken;
  if (
    !tokenPayload.token ||
    !tokenPayload.region ||
    !Number.isFinite(tokenPayload.expiresAt)
  ) {
    throw new AzureSpeechError(
      "Natural voice authorization returned an invalid response.",
      "invalid_token",
    );
  }

  cachedSpeechToken = tokenPayload;
  return tokenPayload;
}

export async function synthesizeAzureSpeech({
  text,
  voice,
  signal,
}: {
  text: string;
  voice: string;
  signal?: AbortSignal;
}): Promise<AzureSpeechResult> {
  if (signal?.aborted) throw abortError();

  const [{ token, region }, speechSdk] = await Promise.all([
    getSpeechToken(signal),
    import("microsoft-cognitiveservices-speech-sdk"),
  ]);

  if (signal?.aborted) throw abortError();

  const speechConfig = speechSdk.SpeechConfig.fromAuthorizationToken(
    token,
    region,
  );
  speechConfig.speechSynthesisVoiceName = voice;
  speechConfig.speechSynthesisOutputFormat =
    speechSdk.SpeechSynthesisOutputFormat.Audio24Khz48KBitRateMonoMp3;

  const synthesizer = new speechSdk.SpeechSynthesizer(speechConfig, null);
  const boundaries: AzureWordBoundary[] = [];

  return new Promise((resolve, reject) => {
    let settled = false;

    const finish = (
      callback: () => void,
      removeAbortListener = true,
    ) => {
      if (settled) return;
      settled = true;
      if (removeAbortListener) {
        signal?.removeEventListener("abort", handleAbort);
      }
      synthesizer.close();
      callback();
    };

    const handleAbort = () => {
      finish(() => reject(abortError()), false);
    };

    signal?.addEventListener("abort", handleAbort, { once: true });

    synthesizer.wordBoundary = (_sender, event) => {
      if (
        event.boundaryType !==
        speechSdk.SpeechSynthesisBoundaryType.Word
      ) {
        return;
      }

      boundaries.push({
        audioOffsetSeconds: event.audioOffset / 10_000_000,
        durationSeconds: event.duration / 10_000_000,
        text: event.text,
        textOffset: event.textOffset,
        wordLength: event.wordLength,
      });
    };

    synthesizer.speakTextAsync(
      text,
      (result) => {
        if (
          result.reason !==
            speechSdk.ResultReason.SynthesizingAudioCompleted ||
          !result.audioData.byteLength
        ) {
          finish(() =>
            reject(
              new AzureSpeechError(
                "Azure did not return narration audio.",
                "empty_audio",
              ),
            ),
          );
          return;
        }

        const audioData = result.audioData.slice(0);
        finish(() =>
          resolve({
            audioData,
            boundaries: boundaries.sort(
              (left, right) =>
                left.audioOffsetSeconds - right.audioOffsetSeconds,
            ),
          }),
        );
      },
      () => {
        finish(() =>
          reject(
            new AzureSpeechError(
              "Azure could not synthesize this passage.",
            ),
          ),
        );
      },
    );
  });
}
