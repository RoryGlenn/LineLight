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
- Install as a progressive web app

## How narration works

LineLight has three narration modes:

- **Offline natural** is the default for new readers. On first launch,
  LineLight automatically stores its included roughly 95 MB Kokoro model and
  five English voices in browser Cache Storage. The pinned files are delivered
  through an allowlisted LineLight route rather than fetched by the browser
  from a third-party model host. Speech then runs in a dedicated browser worker
  using WebGPU when available and WebAssembly as a compatibility fallback.
  LineLight opts into cross-origin isolation so ONNX can use multiple CPU
  threads for WebAssembly on browsers that support them. The pack can be
  removed or restored from Narration settings.
- **Private device** uses the browser's Web Speech API. The operating system or
  browser supplies the voice, so no LineLight voice service is required.
- **Natural online** uses optional Azure AI Speech neural voices. LineLight
  exchanges the server-side subscription key for a short-lived token, requests
  audio for the current passage, and follows Azure's timed word boundaries.
  The key is never sent to the browser.

Offline natural narration keeps three future passages in a bounded preparation
queue and preloads each generated WAV before it reaches playback. Kokoro also
generates at the selected reading speed instead of relying on browser audio
time-stretching. Online natural narration keeps one passage ahead. If an
offline or Azure voice becomes unavailable, LineLight continues with the device
voice when one is available.

The offline model is
[Kokoro-82M v1.0 ONNX](https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX).
The model and
[kokoro-js](https://github.com/hexgrad/kokoro) are
available under the Apache 2.0 license. LineLight stores the quantized model in
the browser's Cache Storage and asks the browser to make that storage
persistent. Browser storage can still be cleared or evicted; the settings panel
prepares the included voice again if any required file is missing.
The distributed license text is available at
[`public/offline-voice-license.txt`](public/offline-voice-license.txt).

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
  Offline highlighting therefore uses the waveform's real duration, per-word
  phoneme counts, and punctuation pauses to estimate word timing.
- Browser support and available voices differ across iPhone, macOS, and Ubuntu.
- Offline model loading and synthesis speed depend on device memory and WebGPU
  support. The WebAssembly fallback works on more browsers but is slower.
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
npm run lint
npm test
```

The production build helpers currently target Linux and use `flock`, `curl`,
and GNU `timeout`.

## Roadmap

- OCR for scanned PDFs
- Keyboard and screen-reader accessibility review
- Expanded automated tests

## License

A license has not been selected yet. Until one is added, the code is available
for inspection but is not granted for reuse or redistribution.
