import { readFile } from "node:fs/promises";
import vm from "node:vm";

const runtimePath = process.argv[2];
if (!runtimePath) {
  throw new Error("Pass the emitted phonemizer runtime path.");
}

const context = vm.createContext({
  ArrayBuffer,
  Blob,
  DataView,
  DecompressionStream,
  Error,
  Float32Array,
  Float64Array,
  Int8Array,
  Int16Array,
  Int32Array,
  Map,
  Math,
  Promise,
  Reflect,
  Set,
  Symbol,
  TextDecoder,
  TextEncoder,
  Uint8Array,
  Uint16Array,
  Uint32Array,
  URL,
  WebAssembly,
  atob,
  btoa,
  clearInterval,
  clearTimeout,
  console,
  crypto,
  importScripts() {},
  location: { pathname: runtimePath },
  performance,
  queueMicrotask,
  setInterval,
  setTimeout,
});
context.self = context;

const source = await readFile(runtimePath, "utf8");
const runtime = new vm.SourceTextModule(source, {
  context,
  identifier: runtimePath,
});
await runtime.link(() => {
  throw new Error("The emitted phonemizer runtime must be self-contained.");
});
await runtime.evaluate();

const voices = await runtime.namespace.list_voices();
const phonemes = await runtime.namespace.phonemize(
  "LineLight is ready.",
  "en-us",
);

console.log(
  JSON.stringify({
    voiceCount: voices.length,
    languageIdentifiers: voices.flatMap((voice) =>
      voice.languages.map((language) => language.name),
    ),
    phonemes,
  }),
);
