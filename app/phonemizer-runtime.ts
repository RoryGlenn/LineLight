type PhonemizerVoice = {
  name: string;
  identifier: string;
  languages: Array<{
    name: string;
    priority: number;
  }>;
};

type PhonemizerRuntime = {
  list_voices(language?: string): Promise<PhonemizerVoice[]>;
  phonemize(text: string, language?: string): Promise<string[]>;
};

let runtimePromise: Promise<PhonemizerRuntime> | null = null;
const runtimeUrl = new URL(
  "../node_modules/phonemizer/dist/phonemizer.js",
  import.meta.url,
).href;

function loadRuntime() {
  runtimePromise ??= import(
    /* @vite-ignore */ runtimeUrl
  ) as Promise<PhonemizerRuntime>;
  return runtimePromise;
}

export async function list_voices(language?: string) {
  return (await loadRuntime()).list_voices(language);
}

export async function phonemize(text: string, language = "en-us") {
  return (await loadRuntime()).phonemize(text, language);
}
