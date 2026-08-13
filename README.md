# LineLight

LineLight is a private-first read-along app for people who find conventional
reading difficult, including readers with dyslexia.

It reads a document aloud, keeps the current sentence or paragraph highlighted,
and keeps the exact spoken position available for navigation and seeking. The
current version runs as a progressive web app on iPhone, macOS, and Ubuntu.

## Current status

LineLight is an early personal alpha. The repository is public so its
development is transparent, but the app is not yet ready for a general public
release.

## Features

- Import PDF, EPUB, and plain-text files
- Choose a continuous sentence or paragraph highlight while exact word clicks
  still seek narration
- Choose a private device voice, downloaded offline neural voices, an attached
  DRM-free audiobook, or optional Azure neural narration
- Prepare a whole book for instant offline replay, or export bounded WAV parts
  with a text-sync timing sidecar
- Automatically follow the narration or return to the spoken position
- Switch between a reflowed focus view and the original PDF page
- Adjust font, text size, line spacing, colors, reading ruler, and speed
- Keep a searchable private library with per-document progress on the device
- Save named bookmarks and return through bounded long-distance jump history
- Install as a progressive web app

## How narration works

LineLight has four narration modes:

- **Offline natural** is the default for new readers. On first launch,
  LineLight automatically stores an included roughly 166 MB Kokoro model pack
  and five English voices in browser Cache Storage. Its fp16
  graph runs through WebGPU when supported and threaded WebAssembly otherwise.
  Interrupted model downloads resume from verified ranges. The pinned files are
  delivered through
  an allowlisted LineLight route rather than fetched by the browser from a
  third-party model host. Speech then runs in a dedicated browser worker using
  WebGPU when a compatible adapter is available and WebAssembly as a fallback.
  LineLight opts into cross-origin isolation so ONNX can use multiple CPU
  threads for WebAssembly on browsers that support them. A bundled, modified
  ONNX Runtime Web build lets that threaded fallback cooperatively cancel an
  obsolete inference without discarding its warm model session. The pack can
  be removed or restored from Narration settings.
- **Private device** uses the browser's Web Speech API. The operating system or
  browser supplies the voice, so no LineLight voice service is required.
- **Natural online** uses optional Azure AI Speech neural voices. LineLight
  exchanges the server-side subscription key for a short-lived token, requests
  audio for the current passage, and follows Azure's timed word boundaries.
  The key is never sent to the browser.
- **Audiobook** stores user-selected DRM-free audio files in the book's local
  IndexedDB records. A pinned Whisper Tiny English q8 model can transcribe
  bounded 30-second windows in a dedicated browser worker and align only
  confidence-supported phrases to the book. Manual sentence anchors can repair
  difficult regions. AA/AAX files are rejected; LineLight does not bypass DRM.

Offline natural narration prepares a short first passage, adapts later passage
sizes to measured generation speed, and keeps at most one passage ahead. Pause
suspends new lookahead; seek and document changes cancel obsolete requests. On
threaded WebAssembly, the page and speech worker coordinate through a
generation-scoped shared cancellation mailbox so active graph execution can
end cooperatively while the initialized worker and model session remain warm.
A bounded watchdog replaces the worker only if a canceled run never reaches a
terminal acknowledgment; the replacement may load prepared assets only from
the local browser cache. A small bounded memory cache avoids regenerating
recently heard passages. For saved books, a bounded recent set of completed
offline chunks and their timing boundaries is also stored in IndexedDB under
the exact model, voice, pace, token range, and source-text fingerprint, so a
later session can reuse matching audio without sending text anywhere or running
inference again.
The reader can also prepare every bounded passage in a saved book as a
resumable job. Each independently playable WAV chunk is compressed and committed
with its timing metadata before progress advances, so pause, cancellation,
reload, and quota errors preserve completed work. A ready profile can be
exported sequentially as duration- and size-bounded WAV parts plus a JSON
sidecar that binds word anchors to the exact book fingerprint, model, voice,
and generated pace; LineLight never builds one whole-book audio buffer.
Deleting a book deletes its retained narration. During an interrupted update,
an older stored q8 pack
remains usable offline until fp16 passes runtime validation; the Narration
panel offers that faster fp16 update when the device reconnects.
Kokoro also generates at the selected reading speed instead of relying on
browser audio time-stretching.
Online natural narration keeps one passage ahead. If Azure becomes unavailable,
LineLight can continue with a device voice. Offline natural remains selected and
asks the reader to retry, keeping the privacy choice explicit.

The offline model is
[Kokoro-82M v1.0 ONNX](https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX).
The model and
[kokoro-js](https://github.com/hexgrad/kokoro) are
available under the Apache 2.0 license. LineLight's hash-guarded Transformers.js
web queue-tail and cancellation-diagnostic modifications remain under Apache
2.0. The queue recovers after any rejected run while preserving that rejection
for its caller. The exact reviewed cooperative-cancellation error is rethrown
before Transformers formats or logs model inputs; ordinary inference errors
retain the upstream diagnostics and rejection behavior. The bundled modified
ONNX Runtime Web is provided under the MIT License. LineLight stores the fp16
model in the browser's Cache Storage and asks the browser to make that storage
persistent. Browser storage can still be cleared or evicted; the settings panel
prepares the included voice again if any required file is missing. A fresh
preparation checks for up to roughly 216 MB of free site storage so the model,
five voices, bundled ONNX runtime, and cache metadata all fit without a
duplicate model copy. A resumed preparation needs less because verified ranges
and voices are counted before the storage check.
The distributed license and modification text is available at
[`public/offline-voice-license.txt`](public/offline-voice-license.txt); the
modified runtime's complete upstream component notices are distributed
unchanged at
[`public/offline-voice-third-party-notices.txt`](public/offline-voice-third-party-notices.txt).
The bundled package also self-identifies its exact upstream commit and
LineLight patch in
[`vendor/onnxruntime-web/LINELIGHT-NOTICE.txt`](vendor/onnxruntime-web/LINELIGHT-NOTICE.txt).
The browser keeps one durable model copy in Cache Storage; the first-party model
route disables the browser's separate HTTP cache while retaining immutable CDN
caching. A separate, much smaller runtime cache retains the exact app, speech
worker, and WebAssembly hashes required by the current deployment and any open
older tab. Retired hashes and finite pre-v9 caches are reclaimed during an idle
client lifecycle event after their last reader closes; Narration settings report
the runtime bytes still retained.

## Privacy

Imported documents are parsed in the browser and stored locally on the device.
LineLight does not upload whole documents to an application server. Private
device narration may use processing supplied by the operating system or voice
provider. Offline natural narration performs synthesis entirely in the browser
after its included model files have been stored. The model route handles only
the pinned public model assets; it never receives imported documents or
narration text. Matching generated passages and timing data for saved books may
be retained in that book's local IndexedDB records for later playback. Attached
audiobook files, local speech-recognition transcripts, confidence scores, and
manual sync anchors also stay in book-scoped IndexedDB records. The alignment
model route receives only pinned public model-file requests, never book text,
audio, or transcripts. When Natural online is selected, only short narration passages
(including one prepared ahead) are sent to Azure AI Speech for synthesis.

## Large PDF loading

PDF import runs in an app-owned browser worker, with PDF.js parser work in a
nested worker. LineLight extracts, maps, stores, and posts page one first, making
its readable Focus text available before attempting the first page bitmap and
continuing with later pages. The source stays as one local IndexedDB `Blob`;
text, geometry, and semantic indices are persisted as independently keyed page
records so opening a saved book can stream page one and bounded batches instead
of cloning the whole document onto the browser main thread.

Supported browsers rasterize PDF pages with `OffscreenCanvas` and transfer
bounded `ImageBitmap` results back for lightweight composition. The worker
implements PDF.js-compatible Alpha/Luminosity soft masks, including their
alpha transfer maps. General drawing transfer functions and unknown soft-mask
types use a cooperative fallback that parses the same local source and renders
only visible pages on the main thread. PDF.js can yield between operator-list
chunks in this fallback, but an individual drawing operator cannot be
preempted; unusually complex fallback pages can therefore still pause longer
than worker-rendered pages.

Closing or replacing a PDF cancels its worker and rejects stale messages and
bitmaps by job and revision. If page one was already committed, the private
library intentionally retains that revision as a resumable local import;
uncommitted or validation-rejected staging is removed only after IndexedDB
confirms the cleanup transaction.

## Known limitations

- Scanned or image-only PDFs need OCR, which is not implemented yet.
- Device-voice highlight timing depends on boundary events supplied by the
  selected system voice.
- Kokoro's public ONNX output contains audio but not exact word timestamps.
  Offline highlighting therefore uses the waveform's real duration, source-word
  lengths, and punctuation pauses to estimate word timing.
- Audiobook alignment supports DRM-free formats the browser can decode. Local
  speech recognition is English-only, requires a one-time roughly 52 MB model,
  and asks users to split files longer than 20 minutes or 128 MB into ordered
  chapter files before alignment. Different editions and weak matches remain
  visibly unsynced rather than receiving guessed timing.
- Browser support and available voices differ across iPhone, macOS, and Ubuntu.
- Offline model loading and synthesis speed depend on device memory and WebGPU
  support. The WebAssembly fallback works on more browsers but is slower.
- Cooperative interruption inside already-running inference is limited to the
  threaded WebAssembly fallback. WebGPU and single-thread WebAssembly discard
  obsolete output at the request boundary instead, so release of inference
  resources can wait for the current runtime call to return. Browser and device
  behavior can vary.
- The app has not yet completed a formal accessibility audit.

## Local development

Requirements:

- Node.js 22.13 or newer
- npm

```bash
npm ci
npm run dev
```

To exercise the built production Worker and its static-asset headers locally,
build first and then start the local Wrangler artifact at
`http://localhost:3000`:

```bash
npm run build
npm start
```

`npm start -- --ip 127.0.0.1 --port 8787` can bind a different local address
or port. This production path applies the same document, worker-script, and
WebAssembly isolation headers as the deployed asset binding.

To enable Natural online narration locally, copy the example environment file
and add the key and region from an Azure AI Speech resource:

```bash
cp .env.example .env
```

```dotenv
AZURE_SPEECH_KEY=your-resource-key
AZURE_SPEECH_REGION=your-resource-region
```

Restart the development server after changing `.env`. For a deployed site, set
the same names as protected runtime environment variables. Do not expose the
key through a `NEXT_PUBLIC_` or `VITE_` variable.

Useful checks:

```bash
npm run index:check
npm run lint
npm test
```

The developer-facing module map, runtime boundaries, state ownership, and
verification links are maintained in
[`docs/codebase-index.md`](docs/codebase-index.md).
Dependency update policy, audited overrides, and production exposure notes are
recorded in
[`docs/dependency-security.md`](docs/dependency-security.md).
The pull-request workflow, protected-branch policy, and emergency procedure are
documented in [`CONTRIBUTING.md`](CONTRIBUTING.md).

The production build helpers currently target Linux and use `flock`, `curl`,
and GNU `timeout`.

## Offline narration voice review

Developers can screen a generated WAV or MP3 entirely on the local machine.
The reviewer combines a predicted naturalness score from UTMOS, optional
English transcription and word-error rate from Whisper, and deterministic
signal measurements for duration, pace, loudness, peak level, clipping, and
meaningful pauses. It does not upload the recording.

Install [ffmpeg](https://ffmpeg.org/download.html) and
[uv](https://docs.astral.sh/uv/getting-started/installation/), then prepare the
pinned models and Python runtime once while online:

```bash
npm run review:voice -- --prepare
```

Preparation is resumable and stores everything outside the repository. A first
run may take several minutes depending on the connection; allow about 1 GiB of
free space for the models and isolated Python runtime. The command pins both
model revisions, verifies the UTMOS checkpoint digest, proves that both models
can reload with remote access disabled, and only then records the cache as
ready. If the cache is missing, incomplete, or stale, a review stops with the
preparation command instead of attempting a download.
The [UTMOS-PyTorch](https://github.com/Blinorot/utmos-pytorch) implementation
and [pinned converted checkpoint](https://huggingface.co/Blinorot/UTMOS-PyTorch/tree/4f2447e519df3b88567b45583d3500006729502b)
are MIT-licensed; the pinned
[Whisper Tiny English ONNX model](https://huggingface.co/Xenova/whisper-tiny.en/tree/79fb389fc764e7c395bd330e9531d9d32ada7049)
is Apache-2.0 licensed.

After that, reviews are always strict offline runs, even if `--offline` is not
written explicitly:

```bash
npm run review:voice -- narration.wav \
  --text "Reading is not a race."
```

For longer passages, keep the source text in a UTF-8 file. Add `--json` for
machine-readable output:

```bash
npm run review:voice -- narration.mp3 \
  --text-file passage.txt \
  --json
```

Without expected text, the reviewer skips Whisper and reports naturalness and
signal measurements only. Models and the Python environment are cached in
`~/Library/Caches/LineLight/voice-review` on macOS and the XDG cache directory
under `linelight/voice-review` on Linux. Set
`LINELIGHT_VOICE_REVIEW_CACHE` to override that location. To reclaim the disk
space, remove the exact cache directory printed by `--prepare`; this does not
remove the separate voice pack stored by the browser app.

UTMOS and Whisper are automated screening tools, not human listeners. Their
scores can catch unnatural output, missing words, clipping, and timing
problems, but they cannot establish whether a voice is expressive,
context-appropriate, or accessible to a particular reader. Important voice
changes still need a human listening and accessibility review. The bundled
transcription check is English-only.

## Roadmap

- OCR for scanned PDFs
- Keyboard and screen-reader accessibility review
- Expanded automated tests

## License

A license has not been selected yet. Until one is added, the code is available
for inspection but is not granted for reuse or redistribution.
