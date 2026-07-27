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
- Automatically follow the narration or return to the spoken position
- Switch between a reflowed focus view and the original PDF page
- Adjust font, text size, line spacing, colors, reading ruler, and speed
- Save the active document, preferences, and reading position on the device
- Install as a progressive web app

## How narration works

LineLight currently uses the browser's Web Speech API. The operating system or
browser supplies the available voices. As the voice reports word boundaries,
LineLight moves the highlight to the matching word.

No paid voice API or LineLight account is required. Voice quality and exact
word-boundary support vary by browser, operating system, and selected voice.

## Privacy

Imported documents are parsed in the browser and stored locally on the device.
LineLight does not upload them to an application server. Some system voices may
use processing supplied by the operating system or voice provider.

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

Useful checks:

```bash
npm run lint
npm test
```

The production build helpers currently target Linux and use `flock`, `curl`,
and GNU `timeout`.

## Roadmap

- OCR for scanned PDFs
- More robust cross-browser word synchronization
- Keyboard and screen-reader accessibility review
- Expanded automated tests
- Optional higher-quality narration providers

## License

A license has not been selected yet. Until one is added, the code is available
for inspection but is not granted for reuse or redistribution.
