#!/usr/bin/env node

import { createHash } from "node:crypto";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { DEFAULT_PDF_HIGHLIGHT_FIXTURE } from "./generate-pdf-highlight-fixture.mjs";
import {
  CdpSession,
  delay,
  evaluate,
  importFixture,
  startBrowser,
  startDevelopmentServer,
  terminateProcessGroup,
  waitForExpression,
  waitForRenderedWindowStable,
} from "./run-pdf-highlight-browser-regression.mjs";

const REPOSITORY_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const DEFAULT_OUTPUT_DIRECTORY = path.join(
  REPOSITORY_ROOT,
  "outputs/highlight-scope-browser",
);
const RECORDED_OUTPUT_DIRECTORY = path.join(
  REPOSITORY_ROOT,
  "docs/evidence/issue-62",
);
const FOCUS_FIXTURE = path.join(
  REPOSITORY_ROOT,
  "tests/fixtures/highlight-scope/issue-62-focus.txt",
);
const MAX_LONG_TASK_MS = 50;

function parseArguments(argv) {
  const options = {
    appUrl: null,
    browser: process.env.LINELIGHT_BROWSER ?? "/usr/bin/brave-browser",
    headed: false,
    outputDirectory: DEFAULT_OUTPUT_DIRECTORY,
    record: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--headed") options.headed = true;
    else if (argument === "--record") options.record = true;
    else if (argument === "--url") options.appUrl = argv[++index];
    else if (argument === "--browser") options.browser = argv[++index];
    else if (argument === "--output") options.outputDirectory = argv[++index];
    else if (argument === "--help" || argument === "-h") {
      process.stdout.write(
        [
          "Usage: node scripts/run-highlight-scope-browser-regression.mjs [options]",
          "",
          "  --headed        Run visible Brave (required for recorded review evidence).",
          "  --record        Write JSON and screenshots to docs/evidence/issue-62/.",
          "  --url URL       Use an existing LineLight development server.",
          "  --browser PATH  Override Brave/Chromium executable.",
          "  --output DIR    Override transient evidence directory.",
          "",
        ].join("\n"),
      );
      return null;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  if (options.record) options.outputDirectory = RECORDED_OUTPUT_DIRECTORY;
  options.outputDirectory = path.resolve(options.outputDirectory);
  return options;
}

async function sha256File(filePath) {
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
}

async function sourceEvidence() {
  const sourceFiles = [
    "app/focus-document-view.tsx",
    "app/globals.css",
    "app/highlight-scope.mjs",
    "app/page.tsx",
    "app/pdf-page-view.tsx",
    "app/pdf-text-model.mjs",
    "app/reader-virtualization.mjs",
    "scripts/run-highlight-scope-browser-regression.mjs",
    "tests/highlight-scope.test.mjs",
    "tests/pdf-text-model.test.mjs",
    "tests/reader-virtualization.test.mjs",
  ];
  return Object.fromEntries(
    await Promise.all(
      sourceFiles.map(async (file) => [file, await sha256File(path.join(REPOSITORY_ROOT, file))]),
    ),
  );
}

const INSTRUMENTATION_SOURCE = `
(() => {
  if (!sessionStorage.getItem("linelight-issue-62-configured")) {
    localStorage.setItem("guided-reader-settings", JSON.stringify({
      narrationEngine: "device",
      narrationPreferenceVersion: 1,
      highlightMode: "word",
      follow: false,
      fontSize: 22,
      maxLineWidth: 48
    }));
    sessionStorage.setItem("linelight-issue-62-configured", "true");
  }

  const state = globalThis.__lineLightIssue62 = {
    errors: [],
    longTasks: [],
    spoken: [],
    speechTimers: [],
    mutation: null
  };
  addEventListener("error", (event) => {
    state.errors.push(event.error?.stack || event.message || "window error");
  });
  addEventListener("unhandledrejection", (event) => {
    state.errors.push(event.reason?.stack || String(event.reason));
  });
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        state.longTasks.push({
          startTime: entry.startTime,
          duration: entry.duration,
          name: entry.name
        });
      }
    }).observe({ type: "longtask", buffered: true });
  } catch (error) {
    state.errors.push("Long Task observer unavailable: " + error.message);
  }

  class FakeUtterance {
    constructor(text) {
      this.text = String(text);
      this.rate = 1;
      this.pitch = 1;
      this.voice = null;
      this.lang = "en-US";
      this.onstart = null;
      this.onboundary = null;
      this.onend = null;
      this.onerror = null;
    }
  }
  const fakeSpeech = {
    paused: false,
    speaking: false,
    current: null,
    getVoices() {
      return [{
        default: true,
        lang: "en-US",
        localService: true,
        name: "Issue 62 deterministic local voice",
        voiceURI: "issue-62-local"
      }];
    },
    addEventListener() {},
    removeEventListener() {},
    cancel() {
      for (const timer of state.speechTimers.splice(0)) clearTimeout(timer);
      this.current = null;
      this.paused = false;
      this.speaking = false;
    },
    pause() {
      this.paused = true;
    },
    resume() {
      this.paused = false;
    },
    speak(utterance) {
      this.cancel();
      this.current = utterance;
      this.speaking = true;
      state.spoken.push(utterance.text);
      const words = Array.from(utterance.text.matchAll(/[\\p{L}\\p{N}]+(?:[’'-][\\p{L}\\p{N}]+)*/gu));
      let cursor = 0;
      const advance = () => {
        if (this.current !== utterance) return;
        if (this.paused) {
          state.speechTimers.push(setTimeout(advance, 30));
          return;
        }
        if (cursor >= words.length) {
          this.current = null;
          this.speaking = false;
          utterance.onend?.({});
          return;
        }
        const word = words[cursor++];
        utterance.onboundary?.({ name: "word", charIndex: word.index, charLength: word[0].length });
        state.speechTimers.push(setTimeout(advance, 70));
      };
      state.speechTimers.push(setTimeout(() => {
        if (this.current !== utterance) return;
        utterance.onstart?.({});
        advance();
      }, 20));
    }
  };
  Object.defineProperty(globalThis, "SpeechSynthesisUtterance", {
    configurable: true,
    value: FakeUtterance
  });
  Object.defineProperty(globalThis, "speechSynthesis", {
    configurable: true,
    value: fakeSpeech
  });
})();
`;

async function configurePage(cdp, appUrl) {
  const consoleEntries = [];
  cdp.on("Runtime.consoleAPICalled", (event) => {
    consoleEntries.push({
      type: event.type,
      values: event.args.map((argument) => argument.value ?? argument.description),
    });
  });
  cdp.on("Log.entryAdded", ({ entry }) => {
    consoleEntries.push({ type: entry.level, values: [entry.text] });
  });
  await Promise.all([
    cdp.send("Page.enable"),
    cdp.send("Runtime.enable"),
    cdp.send("DOM.enable"),
    cdp.send("Log.enable"),
    cdp.send("Network.enable"),
    cdp.send("Performance.enable"),
  ]);
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 1440,
    height: 1000,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
    source: INSTRUMENTATION_SOURCE,
  });
  await cdp.send("Page.navigate", { url: appUrl });
  await waitForExpression(
    cdp,
    `Boolean(document.querySelector('.import-button'))`,
    "the LineLight reader shell",
  );
  return consoleEntries;
}

async function setFileInput(cdp, filePath) {
  await waitForExpression(
    cdp,
    `(() => {
      if (document.querySelector('input[type="file"]')) return true;
      document.querySelector('.import-button')?.click();
      return false;
    })()`,
    "the import file input",
  );
  const documentNode = await cdp.send("DOM.getDocument", { depth: -1 });
  const fileInput = await cdp.send("DOM.querySelector", {
    nodeId: documentNode.root.nodeId,
    selector: 'input[type="file"]',
  });
  if (!fileInput.nodeId) throw new Error("The import input was not found.");
  await cdp.send("DOM.setFileInputFiles", {
    files: [filePath],
    nodeId: fileInput.nodeId,
  });
}

async function chooseView(cdp, view) {
  await evaluate(
    cdp,
    `(() => {
      const button = Array.from(document.querySelectorAll('.view-switcher button'))
        .find((candidate) => candidate.textContent.trim().includes(${JSON.stringify(view === "focus" ? "Focus" : "Page")}));
      button?.click();
      return Boolean(button);
    })()`,
  );
  await waitForExpression(
    cdp,
    view === "focus"
      ? `Boolean(document.querySelector('.reading-page'))`
      : `Boolean(document.querySelector('.pdf-page-view'))`,
    `${view} view`,
  );
  if (view === "page") await waitForRenderedWindowStable(cdp);
  await delay(200);
}

async function setScope(cdp, scope, close = true) {
  await evaluate(
    cdp,
    `(() => {
      if (!document.querySelector('#highlight-scope-description')) {
        Array.from(document.querySelectorAll('.top-actions button'))
          .find((button) => button.textContent.includes('Reading settings'))?.click();
      }
      return true;
    })()`,
  );
  await waitForExpression(
    cdp,
    `Boolean(document.querySelector('select[aria-describedby="highlight-scope-description"]'))`,
    "the highlight scope setting",
  );
  await evaluate(
    cdp,
    `(() => {
      const select = document.querySelector('select[aria-describedby="highlight-scope-description"]');
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
      setter.call(select, ${JSON.stringify(scope)});
      select.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`,
  );
  await waitForExpression(
    cdp,
    `document.querySelector('select[aria-describedby="highlight-scope-description"]')?.value === ${JSON.stringify(scope)}`,
    `${scope} scope`,
  );
  if (close) {
    await evaluate(
      cdp,
      `document.querySelector('.settings-panel button[aria-label="Close reading settings"]')?.click(); true`,
    );
    await waitForExpression(
      cdp,
      `!document.querySelector('.settings-layer')`,
      "settings to close",
    );
  }
  await delay(100);
}

async function clickWord(cdp, view, label) {
  const selector = view === "focus" ? ".spoken-word" : ".pdf-word-overlay";
  const property = view === "focus" ? "textContent" : "getAttribute('aria-label')";
  const expression = `(async () => {
    const word = Array.from(document.querySelectorAll(${JSON.stringify(selector)}))
      .find((element) => element.${property} === ${JSON.stringify(label)});
    if (!word) return false;
    word.scrollIntoView({ block: 'center', behavior: 'auto' });
    word.click();
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    return true;
  })()`;
  await waitForExpression(cdp, expression, `${view} word ${label}`);
  await waitForExpression(
    cdp,
    `document.querySelector('[data-active-token="true"]')?.${property} === ${JSON.stringify(label)}`,
    `the exact ${label} token marker`,
  );
}

async function captureScreenshot(cdp, outputPath) {
  const result = await cdp.send("Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: false,
    fromSurface: true,
  });
  await writeFile(outputPath, Buffer.from(result.data, "base64"));
}

async function collectVisual(cdp, view, scope, outputDirectory) {
  const regionSelector =
    view === "focus"
      ? `.focus-${scope}-region.scope-active`
      : `.pdf-${scope}-overlay.scope-active`;
  const screenshot = `${view}-${scope}.png`;
  const result = await evaluate(
    cdp,
    `(() => {
      const regions = Array.from(document.querySelectorAll(${JSON.stringify(regionSelector)}));
      const fragments = regions.flatMap((region) =>
        Array.from(region.getClientRects()).map((rectangle) => ({
          left: rectangle.left,
          top: rectangle.top,
          right: rectangle.right,
          bottom: rectangle.bottom,
          width: rectangle.width,
          height: rectangle.height
        }))
      ).filter((rectangle) => rectangle.width > 0 && rectangle.height > 0)
       .sort((left, right) => left.top - right.top || left.left - right.left);
      const exact = document.querySelector('[data-active-token="true"]');
      const exactStyle = exact ? getComputedStyle(exact) : null;
      return {
        regionCount: regions.length,
        fragmentCount: fragments.length,
        fragments,
        activeRegionIndices: regions.map((region) =>
          region.dataset.focusSentence ?? region.dataset.focusParagraph ??
          region.dataset.pdfSentence ?? region.dataset.pdfParagraph ?? null
        ),
        exactToken: exact?.textContent || exact?.getAttribute('aria-label') || null,
        exactTokenCount: document.querySelectorAll('[data-active-token="true"]').length,
        exactTokenVisual: exactStyle ? {
          backgroundColor: exactStyle.backgroundColor,
          boxShadow: exactStyle.boxShadow,
          transparent: exactStyle.backgroundColor === 'rgba(0, 0, 0, 0)' && exactStyle.boxShadow === 'none'
        } : null,
        overlayAriaHidden: ${view === "page"}
          ? Array.from(document.querySelectorAll('.pdf-highlight-layer > span')).every((element) => element.getAttribute('aria-hidden') === 'true')
          : null
      };
    })()`,
  );
  const screenshotPath = path.join(outputDirectory, screenshot);
  await captureScreenshot(cdp, screenshotPath);
  return {
    ...result,
    screenshot,
    screenshotSha256: await sha256File(screenshotPath),
  };
}

async function startMutationWindow(cdp, view) {
  const rootSelector = view === "focus" ? ".focus-paragraphs" : ".pdf-pages";
  const shellSelector =
    view === "focus" ? ".focus-paragraph-shell" : ".pdf-page-block";
  const mapCount =
    view === "focus" ? "focusShellMapRenderCount" : "pdfShellMapRenderCount";
  const shellCount =
    view === "focus" ? "focusShellRenderCount" : "pdfShellRenderCount";
  await evaluate(
    cdp,
    `(() => {
      const root = document.querySelector(${JSON.stringify(rootSelector)});
      const shells = Array.from(root.querySelectorAll(${JSON.stringify(shellSelector)}));
      const state = globalThis.__lineLightIssue62;
      state.mutation = {
        view: ${JSON.stringify(view)},
        root,
        shellSelector: ${JSON.stringify(shellSelector)},
        shells,
        mapBefore: Number(root.dataset.${mapCount}) || 0,
        shellCountsBefore: shells.map((shell) => Number(shell.dataset.${shellCount}) || 0),
        records: []
      };
      state.mutation.observer = new MutationObserver((records) => {
        for (const record of records) {
          state.mutation.records.push({
            type: record.type,
            attributeName: record.attributeName,
            targetClass: record.target.className,
            addedNodes: record.addedNodes?.length || 0,
            removedNodes: record.removedNodes?.length || 0
          });
        }
      });
      state.mutation.observer.observe(root, {
        subtree: true,
        childList: true,
        attributes: true
      });
      state.longTasks.length = 0;
      return true;
    })()`,
  );
}

async function finishMutationWindow(cdp, view) {
  const mapCount =
    view === "focus" ? "focusShellMapRenderCount" : "pdfShellMapRenderCount";
  const shellCount =
    view === "focus" ? "focusShellRenderCount" : "pdfShellRenderCount";
  return evaluate(
    cdp,
    `(() => {
      const state = globalThis.__lineLightIssue62;
      const mutation = state.mutation;
      mutation.observer.disconnect();
      const currentShells = Array.from(
        mutation.root.querySelectorAll(mutation.shellSelector)
      );
      const shellCountsAfter = mutation.shells.map((shell) => Number(shell.dataset.${shellCount}) || 0);
      const result = {
        rootIdentityPreserved: mutation.root === document.querySelector(${JSON.stringify(view === "focus" ? ".focus-paragraphs" : ".pdf-pages")}),
        shellIdentityPreserved: mutation.shells.length === currentShells.length && mutation.shells.every((shell, index) => shell === currentShells[index]),
        shellCount: mutation.shells.length,
        mapRenderCountBefore: mutation.mapBefore,
        mapRenderCountAfter: Number(mutation.root.dataset.${mapCount}) || 0,
        changedShellRenderCounts: shellCountsAfter.flatMap((count, index) =>
          count === mutation.shellCountsBefore[index]
            ? []
            : [{ index, before: mutation.shellCountsBefore[index], after: count }]
        ),
        mutations: {
          childList: mutation.records.filter((record) => record.type === 'childList').length,
          attributes: mutation.records.filter((record) => record.type === 'attributes').length,
          attributeNames: Array.from(new Set(mutation.records.map((record) => record.attributeName).filter(Boolean))).sort()
        },
        longTasks: state.longTasks.slice(),
        maximumLongTaskMs: state.longTasks.length ? Math.max(...state.longTasks.map((entry) => entry.duration)) : 0
      };
      state.mutation = null;
      return result;
    })()`,
  );
}

async function collectExactTarget(cdp, view) {
  return evaluate(
    cdp,
    `(() => {
      const exact = document.querySelector('[data-active-token="true"]');
      const style = exact && getComputedStyle(exact);
      return {
        view: ${JSON.stringify(view)},
        count: document.querySelectorAll('[data-active-token="true"]').length,
        label: exact?.textContent || exact?.getAttribute('aria-label') || null,
        focusTokenIndex: exact?.dataset.focusToken ?? null,
        pdfWordIndex: exact?.dataset.pdfWord ?? null,
        id: exact?.id ?? null,
        transparent: Boolean(style) && style.backgroundColor === 'rgba(0, 0, 0, 0)' && style.boxShadow === 'none',
        clickable: Boolean(exact) && getComputedStyle(exact).cursor === 'pointer'
      };
    })()`,
  );
}

async function collectNarrationInteractions(cdp) {
  const before = await collectExactTarget(cdp, "focus");
  await evaluate(cdp, `document.querySelector('.play-button')?.click(); true`);
  await waitForExpression(
    cdp,
    `document.querySelector('.play-button')?.getAttribute('aria-label') === 'Pause narration'`,
    "narration playback",
  );
  await waitForExpression(
    cdp,
    `document.querySelector('[data-active-token="true"]')?.textContent !== ${JSON.stringify(before.label)}`,
    "a narrated exact-token transition",
  );
  const playing = await collectExactTarget(cdp, "focus");
  await evaluate(cdp, `document.querySelector('.play-button')?.click(); true`);
  await waitForExpression(
    cdp,
    `document.querySelector('.play-button')?.getAttribute('aria-label') === 'Play narration'`,
    "paused narration",
  );
  const pausedBefore = await collectExactTarget(cdp, "focus");
  await delay(250);
  const pausedAfter = await collectExactTarget(cdp, "focus");

  await evaluate(
    cdp,
    `document.querySelector('button[aria-label="Next sentence"]')?.click(); true`,
  );
  await waitForExpression(
    cdp,
    `document.querySelector('[data-active-token="true"]')?.textContent === 'another'`,
    "the next sentence exact token",
  );
  const nextSentence = await collectExactTarget(cdp, "focus");

  await setScope(cdp, "paragraph", false);
  const replayStarted = await evaluate(
    cdp,
    `(() => {
      const button = Array.from(document.querySelectorAll('.replay-grid button'))
        .find((candidate) => candidate.textContent.includes('Replay sentence'));
      button?.click();
      return Boolean(button);
    })()`,
  );
  await waitForExpression(
    cdp,
    `document.querySelector('.play-button')?.getAttribute('aria-label') === 'Pause narration'`,
    "sentence replay",
  );
  await delay(120);
  await evaluate(
    cdp,
    `document.querySelector('.settings-panel button[aria-label="Close reading settings"]')?.click(); true`,
  );
  await clickWord(cdp, "focus", "definition");
  const sought = await collectExactTarget(cdp, "focus");
  return {
    before,
    playing,
    pauseStable: pausedBefore.label === pausedAfter.label,
    pausedBefore,
    pausedAfter,
    nextSentence,
    replayStarted,
    sought,
    passed:
      before.count === 1 &&
      playing.count === 1 &&
      playing.label !== before.label &&
      pausedBefore.label === pausedAfter.label &&
      nextSentence.label === "another" &&
      replayStarted &&
      sought.label === "definition",
  };
}

async function collectSettingsContract(cdp) {
  await setScope(cdp, "sentence", false);
  const result = await evaluate(
    cdp,
    `(() => {
      const select = document.querySelector('select[aria-describedby="highlight-scope-description"]');
      return {
        label: select?.closest('label')?.querySelector('span')?.textContent ?? null,
        options: Array.from(select?.options ?? []).map((option) => ({ value: option.value, label: option.textContent })),
        description: document.querySelector('#highlight-scope-description')?.textContent.trim() ?? null,
        value: select?.value ?? null
      };
    })()`,
  );
  await evaluate(
    cdp,
    `document.querySelector('.settings-panel button[aria-label="Close reading settings"]')?.click(); true`,
  );
  return result;
}

async function collectPersistence(cdp, appUrl, pdfTitle) {
  await setScope(cdp, "paragraph");
  await clickWord(cdp, "page", "definition");
  await waitForExpression(
    cdp,
    `(() => {
      const settings = JSON.parse(localStorage.getItem('guided-reader-settings') || '{}');
      return settings.highlightScope === 'paragraph' && !('highlightMode' in settings);
    })()`,
    "canonical saved paragraph scope",
  );
  const beforeReload = await evaluate(
    cdp,
    `JSON.parse(localStorage.getItem('guided-reader-settings') || '{}')`,
  );
  await cdp.send("Page.reload", { ignoreCache: true });
  await waitForExpression(
    cdp,
    `document.querySelector('h1')?.textContent === ${JSON.stringify(pdfTitle)} &&
      Boolean(document.querySelector('.pdf-page-view')) &&
      document.querySelectorAll('.pdf-word-overlay').length > 20`,
    "the private PDF to restore after reload",
    60_000,
  );
  await waitForExpression(
    cdp,
    `document.querySelector('.pdf-paragraph-overlay.scope-active') &&
      document.querySelectorAll('[data-active-token="true"]').length === 1`,
    "restored paragraph scope and exact token",
  );
  const afterReload = {
    settings: await evaluate(
      cdp,
      `JSON.parse(localStorage.getItem('guided-reader-settings') || '{}')`,
    ),
    exact: await collectExactTarget(cdp, "page"),
    activeParagraphRegions: await evaluate(
      cdp,
      `document.querySelectorAll('.pdf-paragraph-overlay.scope-active').length`,
    ),
  };

  await setFileInput(cdp, FOCUS_FIXTURE);
  await waitForExpression(
    cdp,
    `document.querySelector('h1')?.textContent === 'issue-62-focus' && Boolean(document.querySelector('.reading-page'))`,
    "the Focus text fixture",
    30_000,
  );
  await clickWord(cdp, "focus", "Sentence");
  const textDocument = {
    title: await evaluate(cdp, `document.querySelector('h1')?.textContent`),
    scope: await evaluate(
      cdp,
      `document.querySelector('.reading-page')?.classList.contains('highlight-paragraph') ? 'paragraph' : 'sentence'`,
    ),
    exact: await collectExactTarget(cdp, "focus"),
  };
  await evaluate(
    cdp,
    `(() => {
      const button = Array.from(document.querySelectorAll('.library-book-open'))
        .find((candidate) => candidate.textContent.includes(${JSON.stringify(pdfTitle)}));
      button?.click();
      return Boolean(button);
    })()`,
  );
  await waitForExpression(
    cdp,
    `document.querySelector('h1')?.textContent === ${JSON.stringify(pdfTitle)} &&
      Boolean(document.querySelector('.pdf-page-view')) &&
      document.querySelectorAll('.pdf-word-overlay').length > 20`,
    "the PDF after document switch",
    60_000,
  );
  await waitForExpression(
    cdp,
    `document.querySelector('.pdf-paragraph-overlay.scope-active') &&
      document.querySelectorAll('[data-active-token="true"]').length === 1`,
    "paragraph scope after document switch",
  );
  const switchedBack = {
    title: await evaluate(cdp, `document.querySelector('h1')?.textContent`),
    scope: await evaluate(
      cdp,
      `document.querySelector('.pdf-page-view')?.classList.contains('highlight-paragraph') ? 'paragraph' : 'sentence'`,
    ),
    exact: await collectExactTarget(cdp, "page"),
  };
  return {
    appUrl,
    beforeReload,
    afterReload,
    textDocument,
    switchedBack,
    passed:
      beforeReload.highlightScope === "paragraph" &&
      !("highlightMode" in beforeReload) &&
      afterReload.settings.highlightScope === "paragraph" &&
      afterReload.exact.count === 1 &&
      textDocument.scope === "paragraph" &&
      textDocument.exact.count === 1 &&
      switchedBack.scope === "paragraph" &&
      switchedBack.exact.count === 1,
  };
}

function maximumLongTask(interactions) {
  return Math.max(
    0,
    ...Object.values(interactions).flatMap((interaction) =>
      (interaction.longTasks ?? []).map((entry) => entry.duration),
    ),
  );
}

export function validateHighlightScopeEvidence(evidence) {
  const failures = [];
  if (evidence.schemaVersion !== 1 || evidence.issue !== 62) {
    failures.push("Evidence must use the Issue #62 schema.");
  }
  if (!evidence.legacyMigration?.passed) {
    failures.push("Legacy highlight settings did not migrate to sentence scope.");
  }
  if (
    JSON.stringify(evidence.settings?.options?.map((option) => option.value)) !==
    JSON.stringify(["sentence", "paragraph"])
  ) {
    failures.push("The settings UI did not expose exactly Sentence and Paragraph.");
  }
  for (const view of ["focus", "page"]) {
    for (const scope of ["sentence", "paragraph"]) {
      const visual = evidence.visuals?.[view]?.[scope];
      if (!visual || visual.fragmentCount < 2) {
        failures.push(`${view} ${scope} did not produce a wrapped continuous region.`);
      }
      if (!visual?.screenshot || !visual?.screenshotSha256) {
        failures.push(`${view} ${scope} is missing committed screenshot integrity data.`);
      }
      if (
        visual?.exactTokenCount !== 1 ||
        !visual?.exactTokenVisual?.transparent
      ) {
        failures.push(`${view} ${scope} exposed a visible exact-word box or duplicate marker.`);
      }
      if (view === "page" && visual?.overlayAriaHidden !== true) {
        failures.push(`PDF ${scope} overlays were not aria-hidden.`);
      }
    }
    const sentence = evidence.visuals?.[view]?.sentence;
    const paragraph = evidence.visuals?.[view]?.paragraph;
    if (
      sentence?.activeRegionIndices?.[0] !==
        paragraph?.activeRegionIndices?.[0] ||
      !(paragraph?.fragmentCount > sentence?.fragmentCount)
    ) {
      failures.push(`${view} did not switch registries when both scopes shared an index.`);
    }
    const interaction = evidence.interactions?.[view];
    if (
      !interaction?.rootIdentityPreserved ||
      !interaction?.shellIdentityPreserved ||
      interaction.mapRenderCountBefore !== interaction.mapRenderCountAfter ||
      interaction.changedShellRenderCounts?.length !== 0 ||
      interaction.mutations?.childList !== 0
    ) {
      failures.push(`${view} interactions reconciled the stable shell list.`);
    }
  }
  if (!evidence.navigation?.passed) {
    failures.push("Play, pause, sentence movement, replay, or exact seek changed scope behavior.");
  }
  if (!evidence.persistence?.passed) {
    failures.push("Scope or exact-token state did not survive reload/document switching.");
  }
  if ((evidence.performance?.maximumLongTaskMs ?? Infinity) > MAX_LONG_TASK_MS) {
    failures.push(`An interaction Long Task exceeded ${MAX_LONG_TASK_MS}ms.`);
  }
  if (evidence.browserDiagnostics?.errors?.length) {
    failures.push("The browser recorded runtime errors.");
  }
  return failures;
}

async function run(options) {
  await Promise.all([
    access(DEFAULT_PDF_HIGHLIGHT_FIXTURE),
    access(FOCUS_FIXTURE),
    mkdir(options.outputDirectory, { recursive: true }),
  ]);
  let server;
  let browser;
  let cdp;
  try {
    if (!options.appUrl) server = await startDevelopmentServer();
    const appUrl = options.appUrl ?? server.appUrl;
    browser = await startBrowser(options.browser, options.headed);
    cdp = await CdpSession.connect(browser.webSocketDebuggerUrl);
    const consoleEntries = await configurePage(cdp, appUrl);

    await waitForExpression(
      cdp,
      `(() => {
        const settings = JSON.parse(localStorage.getItem('guided-reader-settings') || '{}');
        return settings.highlightScope === 'sentence' && !('highlightMode' in settings);
      })()`,
      "legacy settings migration",
    );
    const legacyMigration = await evaluate(
      cdp,
      `(() => {
        const settings = JSON.parse(localStorage.getItem('guided-reader-settings') || '{}');
        return {
          stored: settings,
          passed: settings.highlightScope === 'sentence' && !('highlightMode' in settings)
        };
      })()`,
    );
    const settings = await collectSettingsContract(cdp);

    await importFixture(cdp, DEFAULT_PDF_HIGHLIGHT_FIXTURE);
    const pdfTitle = await evaluate(cdp, `document.querySelector('h1')?.textContent`);

    await chooseView(cdp, "focus");
    await setScope(cdp, "sentence");
    await clickWord(cdp, "focus", "like");
    const focusSentence = await collectVisual(
      cdp,
      "focus",
      "sentence",
      options.outputDirectory,
    );
    await startMutationWindow(cdp, "focus");
    await setScope(cdp, "paragraph");
    const focusParagraph = await collectVisual(
      cdp,
      "focus",
      "paragraph",
      options.outputDirectory,
    );
    await setScope(cdp, "sentence");
    await clickWord(cdp, "focus", "definition");
    const focusInteraction = await finishMutationWindow(cdp, "focus");
    const focusExact = await collectExactTarget(cdp, "focus");

    const navigation = await collectNarrationInteractions(cdp);

    await chooseView(cdp, "page");
    await setScope(cdp, "sentence");
    await clickWord(cdp, "page", "like");
    const pageSentence = await collectVisual(
      cdp,
      "page",
      "sentence",
      options.outputDirectory,
    );
    await startMutationWindow(cdp, "page");
    await setScope(cdp, "paragraph");
    const pageParagraph = await collectVisual(
      cdp,
      "page",
      "paragraph",
      options.outputDirectory,
    );
    await setScope(cdp, "sentence");
    await clickWord(cdp, "page", "definition");
    const pageInteraction = await finishMutationWindow(cdp, "page");
    const pageExact = await collectExactTarget(cdp, "page");

    const persistence = await collectPersistence(cdp, appUrl, pdfTitle);
    const interactions = { focus: focusInteraction, page: pageInteraction };
    const evidence = {
      schemaVersion: 1,
      issue: 62,
      recordedAt: new Date().toISOString(),
      source: {
        branch: "agent/issue-62-highlight-scope",
        files: await sourceEvidence(),
      },
      browser: {
        executable: options.browser,
        headed: options.headed,
        userAgent: await evaluate(cdp, `navigator.userAgent`),
        viewport: await evaluate(cdp, `({ width: innerWidth, height: innerHeight, dpr: devicePixelRatio })`),
      },
      fixtures: {
        pdf: {
          path: path.relative(REPOSITORY_ROOT, DEFAULT_PDF_HIGHLIGHT_FIXTURE),
          sha256: await sha256File(DEFAULT_PDF_HIGHLIGHT_FIXTURE),
        },
        focus: {
          path: path.relative(REPOSITORY_ROOT, FOCUS_FIXTURE),
          sha256: await sha256File(FOCUS_FIXTURE),
        },
      },
      thresholds: { maximumLongTaskMs: MAX_LONG_TASK_MS },
      legacyMigration,
      settings,
      visuals: {
        focus: { sentence: focusSentence, paragraph: focusParagraph },
        page: { sentence: pageSentence, paragraph: pageParagraph },
      },
      exactTargets: { focus: focusExact, page: pageExact },
      interactions,
      navigation,
      persistence,
      performance: {
        maximumLongTaskMs: maximumLongTask(interactions),
        interactionLongTasks: Object.fromEntries(
          Object.entries(interactions).map(([view, interaction]) => [view, interaction.longTasks]),
        ),
      },
      browserDiagnostics: {
        errors: await evaluate(cdp, `globalThis.__lineLightIssue62?.errors ?? []`),
        console: consoleEntries.filter((entry) =>
          ["error", "warning"].includes(entry.type),
        ),
        browserStderr: browser.log(),
        serverLogTail: server?.log() ?? null,
      },
    };
    evidence.failures = validateHighlightScopeEvidence(evidence);
    evidence.passed = evidence.failures.length === 0;
    const evidencePath = path.join(
      options.outputDirectory,
      "highlight-scope-browser.json",
    );
    await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
    process.stdout.write(
      `${JSON.stringify({ evidence: evidencePath, passed: evidence.passed, failures: evidence.failures })}\n`,
    );
    if (!evidence.passed) process.exitCode = 1;
  } finally {
    cdp?.close();
    terminateProcessGroup(browser?.child);
    terminateProcessGroup(server?.child);
    if (browser?.profileDirectory) {
      await delay(200);
      await rm(browser.profileDirectory, { recursive: true, force: true });
    }
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options) await run(options);
}

if (
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
) {
  await main();
}
