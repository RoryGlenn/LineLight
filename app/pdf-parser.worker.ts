import pdfJsWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

type ParserWorkerScope = {
  location: { href: string };
  postMessage(message: unknown): void;
};

const parserScope = globalThis as unknown as ParserWorkerScope;
const parserModuleUrl = new URL(
  pdfJsWorkerUrl,
  parserScope.location.href,
).href;

// Brave can reject the emitted `.mjs` file when it is used directly as a
// nested module-worker entry even though the same same-origin module imports
// correctly. This first-party `.js` worker bootstrap keeps the parser isolated
// and lets PDF.js install its own WorkerMessageHandler during the import.
void import(/* @vite-ignore */ parserModuleUrl).catch((error) => {
  parserScope.postMessage({
    sourceName: "linelight-parser-bootstrap",
    targetName: "main",
    action: "bootstrap-error",
    data: {
      message:
        error instanceof Error
          ? error.message
          : "The PDF.js parser module could not load.",
    },
  });
});
