# LineLight

LineLight is a private-first read-along app for people who find conventional
reading difficult, including readers with dyslexia.

It reads a document aloud, highlights the current word, and keeps the spoken
position visible. The current version runs as a progressive web app on iPhone,
macOS, and Ubuntu.

## Current status

LineLight is an early personal alpha. The repository is public so its
development is transparent, but the app is not yet ready for a general public
release.

## Features

- Import PDF, EPUB, and plain-text files
- Highlight the current word and sentence during narration
- Choose a private device voice, downloaded offline neural voices, or optional
  Azure neural narration
- Automatically follow the narration or return to the spoken position
- Switch between a reflowed focus view and the original PDF page
- Adjust font, text size, line spacing, colors, reading ruler, and speed
- Keep a searchable private library with per-document progress on the device
- Save named bookmarks and return through bounded long-distance jump history
- Install as a progressive web app

## How narration works

LineLight has three narration modes:

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
  threads for WebAssembly on browsers that support them. The pack can be
  removed or restored from Narration settings.
- **Private device** uses the browser's Web Speech API. The operating system or
  browser supplies the voice, so no LineLight voice service is required.
- **Natural online** uses optional Azure AI Speech neural voices. LineLight
  exchanges the server-side subscription key for a short-lived token, requests
  audio for the current passage, and follows Azure's timed word boundaries.
  The key is never sent to the browser.

Offline natural narration prepares a short first passage, adapts later passage
sizes to measured generation speed, and keeps at most one passage ahead. Pause
suspends new lookahead; seek and document changes ignore obsolete queued
results, while a small bounded audio cache avoids regenerating recently heard
passages. During an interrupted update, an older stored q8 pack remains usable
offline until fp16 passes runtime validation; the Narration panel offers that
faster fp16 update when the device reconnects.
Kokoro also generates at the selected reading speed instead of relying on
browser audio time-stretching.
Online natural narration keeps one passage ahead. If Azure becomes unavailable,
LineLight can continue with a device voice. Offline natural remains selected and
asks the reader to retry, keeping the privacy choice explicit.

The offline model is
[Kokoro-82M v1.0 ONNX](https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX).
The model and
[kokoro-js](https://github.com/hexgrad/kokoro) are
available under the Apache 2.0 license. LineLight stores the fp16 model in
the browser's Cache Storage and asks the browser to make that storage
persistent. Browser storage can still be cleared or evicted; the settings panel
prepares the included voice again if any required file is missing. A fresh
preparation checks for up to roughly 216 MB of free site storage so the model,
five voices, bundled ONNX runtime, and cache metadata all fit without a
duplicate model copy. A resumed preparation needs less because verified ranges
and voices are counted before the storage check.
The distributed license text is available at
[`public/offline-voice-license.txt`](public/offline-voice-license.txt). The
browser keeps one durable model copy in Cache Storage; the first-party model
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
narration text. When Natural online is selected, only short narration passages
(including one prepared ahead) are sent to Azure AI Speech for synthesis.

## Known limitations

- Scanned or image-only PDFs need OCR, which is not implemented yet.
- Device-voice highlight timing depends on boundary events supplied by the
  selected system voice.
- Kokoro's public ONNX output contains audio but not exact word timestamps.
  Offline highlighting therefore uses the waveform's real duration, source-word
  lengths, and punctuation pauses to estimate word timing.
- Browser support and available voices differ across iPhone, macOS, and Ubuntu.
- Offline model loading and synthesis speed depend on device memory and WebGPU
  support. The WebAssembly fallback works on more browsers but is slower.
- On tested Chromium desktop builds, Pause stops audio and suspends future
  passages immediately, but WebAssembly inference already in progress may use
  CPU for about two seconds before the browser releases it. A seek can wait for
  that already-running inference rather than reload the model. Browser and
  device behavior can vary.
- The app has not yet completed a formal accessibility audit.

## Local development

Requirements:

- Node.js 22.13 or newer
- npm

```bash
npm ci
npm run dev
```

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
