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
- Choose a private device voice or optional Azure neural narration
- Automatically follow the narration or return to the spoken position
- Switch between a reflowed focus view and the original PDF page
- Adjust font, text size, line spacing, colors, reading ruler, and speed
- Save the active document, preferences, and reading position on the device
- Install as a progressive web app

## How narration works

LineLight has two narration modes:

- **Private device** uses the browser's Web Speech API. The operating system or
  browser supplies the voice, so no LineLight voice service is required.
- **Natural online** uses optional Azure AI Speech neural voices. LineLight
  exchanges the server-side subscription key for a short-lived token, requests
  audio for the current passage, and follows Azure's timed word boundaries.
  The key is never sent to the browser.

Natural narration prefetches one passage ahead for smooth playback. If Azure is
not configured or becomes unavailable, LineLight continues with the device
voice when one is available.

## Privacy

Imported documents are parsed in the browser and stored locally on the device.
LineLight does not upload whole documents to an application server. Private
device narration may use processing supplied by the operating system or voice
provider. When Natural online is selected, only short narration passages
(including one prepared ahead) are sent to Azure AI Speech for synthesis.

## Known limitations

- Scanned or image-only PDFs need OCR, which is not implemented yet.
- Highlight timing depends on the boundary events supplied by the selected
  system voice.
- Browser support and available voices differ across iPhone, macOS, and Ubuntu.
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
- Optional local neural narration

## License

A license has not been selected yet. Until one is added, the code is available
for inspection but is not granted for reuse or redistribution.
