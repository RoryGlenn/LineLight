#!/usr/bin/env node

import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import {
  access,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir, platform, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  analyzePcm16,
  buildVoiceReview,
  formatVoiceReview,
  parsePcm16Wav,
} from "./lib/voice-review.mjs";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const UTMOS_HELPER = join(SCRIPT_DIR, "utmos-score.py");
const PREPARE_COMMAND = "npm run review:voice -- --prepare";
const PREPARATION_SCHEMA_VERSION = 1;

const PYTHON_VERSION = "3.12";
const PYTHON_PACKAGES = [
  "huggingface-hub==1.26.0",
  "numpy==2.5.1",
  "torch==2.9.1",
  "utmos-pytorch==0.1.0",
];
const UTMOS_MODEL = {
  id: "Blinorot/UTMOS-PyTorch",
  revision: "4f2447e519df3b88567b45583d3500006729502b",
};
const UTMOS_CHECKPOINT_SHA256 =
  "21b98001a7d5164d562a40d76aff80ae996deeabe4473c3a6786d1c591c2cc47";
const WHISPER_MODEL = {
  dtype: "q8",
  id: "Xenova/whisper-tiny.en",
  revision: "79fb389fc764e7c395bd330e9531d9d32ada7049",
};

function usage() {
  return `LineLight offline narration voice reviewer

Prepare the pinned local models once:
  npm run review:voice -- --prepare

Review audio without network access:
  npm run review:voice -- sample.wav --text "The words that were spoken."
  npm run review:voice -- sample.mp3 --text-file passage.txt --json

Options:
  --prepare           Install the pinned Python runtime and download both models
  --text TEXT         Expected spoken text for local Whisper/WER analysis
  --text-file PATH    Read the expected spoken text from a UTF-8 file
  --json              Print machine-readable JSON
  --cache-dir PATH    Override the user-side model/runtime cache
  --offline           Accepted for clarity; reviews are always strictly offline
  -h, --help          Show this help

Requirements: Node.js 22+, ffmpeg, and uv (for --prepare only).
No review command uploads audio or permits model downloads.`;
}

function parseArgs(argv) {
  const options = {
    audioPath: null,
    cacheDir: null,
    expectedText: null,
    expectedTextFile: null,
    help: false,
    json: false,
    offline: false,
    prepare: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--prepare") {
      options.prepare = true;
    } else if (argument === "--json") {
      options.json = true;
    } else if (argument === "--offline") {
      options.offline = true;
    } else if (argument === "--help" || argument === "-h") {
      options.help = true;
    } else if (
      argument === "--text" ||
      argument === "--text-file" ||
      argument === "--cache-dir"
    ) {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error(`${argument} requires a value.`);
      }
      index += 1;
      if (argument === "--text") options.expectedText = value;
      if (argument === "--text-file") options.expectedTextFile = value;
      if (argument === "--cache-dir") options.cacheDir = value;
    } else if (argument.startsWith("-")) {
      throw new Error(`Unknown option: ${argument}`);
    } else if (options.audioPath) {
      throw new Error("Provide exactly one audio file.");
    } else {
      options.audioPath = argument;
    }
  }

  if (options.help) return options;
  if (options.expectedText && options.expectedTextFile) {
    throw new Error("Use either --text or --text-file, not both.");
  }
  if (options.prepare && options.audioPath) {
    throw new Error("Run --prepare separately from an audio review.");
  }
  if (options.prepare && (options.expectedText || options.expectedTextFile)) {
    throw new Error("Expected text is only used when reviewing an audio file.");
  }
  if (options.prepare && options.offline) {
    throw new Error(
      "Preparation needs network access. Remove --offline; completed reviews are always offline.",
    );
  }
  if (!options.prepare && !options.audioPath) {
    throw new Error("Provide an audio file, or run with --prepare.");
  }
  return options;
}

function defaultCacheDir() {
  if (process.env.LINELIGHT_VOICE_REVIEW_CACHE) {
    return resolve(process.env.LINELIGHT_VOICE_REVIEW_CACHE);
  }
  if (platform() === "darwin") {
    return join(homedir(), "Library", "Caches", "LineLight", "voice-review");
  }
  const cacheRoot = process.env.XDG_CACHE_HOME
    ? resolve(process.env.XDG_CACHE_HOME)
    : join(homedir(), ".cache");
  return join(cacheRoot, "linelight", "voice-review");
}

function cachePaths(cacheDir) {
  return {
    cacheDir,
    huggingFace: join(cacheDir, "huggingface"),
    manifest: join(cacheDir, "prepared.json"),
    python: join(cacheDir, "python", "bin", "python"),
    pythonEnvironment: join(cacheDir, "python"),
    transformers: join(cacheDir, "transformers"),
  };
}

function preparationManifest() {
  return {
    offlineVerified: true,
    python: {
      packages: PYTHON_PACKAGES,
      version: PYTHON_VERSION,
    },
    schemaVersion: PREPARATION_SCHEMA_VERSION,
    utmos: {
      ...UTMOS_MODEL,
      checkpointSha256: UTMOS_CHECKPOINT_SHA256,
    },
    whisper: WHISPER_MODEL,
  };
}

function matchesPreparation(manifest) {
  const expected = preparationManifest();
  return (
    manifest?.schemaVersion === expected.schemaVersion &&
    manifest.offlineVerified === true &&
    manifest.python?.version === expected.python.version &&
    JSON.stringify(manifest.python?.packages) ===
      JSON.stringify(expected.python.packages) &&
    manifest.utmos?.id === expected.utmos.id &&
    manifest.utmos?.revision === expected.utmos.revision &&
    manifest.utmos?.checkpointSha256 === expected.utmos.checkpointSha256 &&
    manifest.whisper?.id === expected.whisper.id &&
    manifest.whisper?.revision === expected.whisper.revision &&
    manifest.whisper?.dtype === expected.whisper.dtype
  );
}

function assertUtmosPreparation(result) {
  if (
    result?.model !== UTMOS_MODEL.id ||
    result.revision !== UTMOS_MODEL.revision ||
    result.sha256 !== UTMOS_CHECKPOINT_SHA256
  ) {
    throw new Error("UTMOS preparation returned unexpected model metadata.");
  }
}

async function assertPrepared(paths) {
  let manifest;
  try {
    manifest = JSON.parse(await readFile(paths.manifest, "utf8"));
  } catch {
    throw new Error(
      `Offline models are not prepared in ${paths.cacheDir}. Run: ${PREPARE_COMMAND}`,
    );
  }

  if (!matchesPreparation(manifest) || !(await pathExists(paths.python))) {
    throw new Error(
      `The offline model cache is incomplete or out of date. Run: ${PREPARE_COMMAND}`,
    );
  }
}

async function runOfflineModel(label, operation) {
  try {
    return await operation();
  } catch (error) {
    const detail =
      error instanceof Error
        ? error.message.split(/\r?\n/u)[0]
        : String(error);
    throw new Error(
      `${label} failed during the offline review. Run ${PREPARE_COMMAND} if the cache is incomplete. Details: ${detail}`,
      { cause: error },
    );
  }
}

async function pathExists(path) {
  try {
    await access(path, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function runCommand(command, args, { env = process.env } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", (error) => {
      if (error.code === "ENOENT") {
        reject(new Error(`Required command not found: ${command}`));
      } else {
        reject(error);
      }
    });
    child.on("close", (code, signal) => {
      const output = Buffer.concat(stdout).toString("utf8");
      const errors = Buffer.concat(stderr).toString("utf8");
      if (code === 0) {
        resolvePromise({ stderr: errors, stdout: output });
      } else {
        reject(
          new Error(
            `${command} failed${signal ? ` with signal ${signal}` : ` with exit code ${code}`}: ${errors.trim() || output.trim()}`,
          ),
        );
      }
    });
  });
}

async function requireCommand(command, args, guidance) {
  try {
    return await runCommand(command, args);
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === `Required command not found: ${command}`
    ) {
      throw new Error(`${command} is required. ${guidance}`, { cause: error });
    }
    throw error;
  }
}

function modelEnvironment(paths, offline) {
  return {
    ...process.env,
    HF_HUB_CACHE: paths.huggingFace,
    HF_HUB_DISABLE_TELEMETRY: "1",
    HF_HUB_OFFLINE: offline ? "1" : "0",
    PYTHONUNBUFFERED: "1",
  };
}

async function runUtmos(paths, args, { offline }) {
  const { stdout } = await runCommand(
    paths.python,
    [UTMOS_HELPER, ...args, ...(offline ? ["--offline"] : [])],
    { env: modelEnvironment(paths, offline) },
  );
  try {
    return JSON.parse(stdout.trim());
  } catch {
    throw new Error(`UTMOS returned invalid JSON: ${stdout.trim()}`);
  }
}

async function loadWhisper(paths, { offline }) {
  const { env, pipeline } = await import("@huggingface/transformers");
  env.cacheDir = paths.transformers;
  env.allowRemoteModels = !offline;
  return pipeline("automatic-speech-recognition", WHISPER_MODEL.id, {
    device: "cpu",
    dtype: WHISPER_MODEL.dtype,
    local_files_only: offline,
    revision: WHISPER_MODEL.revision,
  });
}

async function preparePython(paths) {
  const uv = process.env.UV_BIN || "uv";
  await requireCommand(
    uv,
    ["--version"],
    "Install it from https://docs.astral.sh/uv/getting-started/installation/.",
  );
  await mkdir(paths.cacheDir, { recursive: true });

  if (await pathExists(paths.python)) {
    let version = null;
    try {
      const result = await runCommand(paths.python, [
        "-c",
        "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')",
      ]);
      version = result.stdout.trim();
    } catch {
      // The actionable error below covers an unreadable cached runtime too.
    }
    if (version !== PYTHON_VERSION) {
      throw new Error(
        `The cached Python runtime is ${version ?? "unreadable"}, not ${PYTHON_VERSION}. Remove ${paths.pythonEnvironment}, then rerun ${PREPARE_COMMAND}.`,
      );
    }
  } else {
    await runCommand(uv, [
      "venv",
      "--python",
      PYTHON_VERSION,
      "--seed",
      paths.pythonEnvironment,
    ]);
  }

  await runCommand(uv, [
    "pip",
    "install",
    "--python",
    paths.python,
    ...PYTHON_PACKAGES,
  ]);
}

async function directorySize(path) {
  if (!(await pathExists(path))) return 0;
  let total = 0;
  const entries = await readdir(path, { withFileTypes: true });

  for (const entry of entries) {
    const entryPath = join(path, entry.name);
    if (entry.isDirectory()) {
      total += await directorySize(entryPath);
    } else if (entry.isFile()) {
      total += (await stat(entryPath)).size;
    }
  }
  return total;
}

function formatBytes(bytes) {
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
}

async function prepareModels(paths, jsonOutput) {
  const progress = (message) => console.error(message);
  await requireCommand(
    "ffmpeg",
    ["-version"],
    "Install it from https://ffmpeg.org/download.html.",
  );
  progress(
    `First-time preparation may take several minutes and download about 1 GiB into ${paths.cacheDir}; interrupted downloads can be resumed.`,
  );
  progress("Preparing pinned Python runtime and UTMOS dependencies...");
  await preparePython(paths);
  progress("Downloading and validating the pinned UTMOS checkpoint...");
  const utmos = await runUtmos(paths, ["--prepare"], { offline: false });
  assertUtmosPreparation(utmos);
  progress("Downloading the pinned quantized Whisper model...");
  const transcriber = await loadWhisper(paths, { offline: false });
  await transcriber.dispose();

  progress("Verifying both models reload with network access disabled...");
  const offlineUtmos = await runUtmos(paths, ["--prepare"], { offline: true });
  assertUtmosPreparation(offlineUtmos);
  const offlineTranscriber = await loadWhisper(paths, { offline: true });
  await offlineTranscriber.dispose();

  await writeFile(
    paths.manifest,
    `${JSON.stringify(preparationManifest(), null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  const bytes = await directorySize(paths.cacheDir);
  const result = {
    cacheBytes: bytes,
    cacheDir: paths.cacheDir,
    offlineVerified: true,
    python: {
      packages: PYTHON_PACKAGES,
      version: PYTHON_VERSION,
    },
    utmos,
    whisper: WHISPER_MODEL,
  };

  if (jsonOutput) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(
      [
        "Offline voice review is ready.",
        `Cache: ${paths.cacheDir} (${formatBytes(bytes)})`,
        `UTMOS: ${UTMOS_MODEL.id}@${UTMOS_MODEL.revision}`,
        `Whisper: ${WHISPER_MODEL.id}@${WHISPER_MODEL.revision}`,
        "Verified: both models reload with remote access disabled",
      ].join("\n"),
    );
  }
}

async function normalizeAudio(inputPath, outputPath) {
  await runCommand("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-i",
    inputPath,
    "-map",
    "0:a:0",
    "-ac",
    "1",
    "-ar",
    "16000",
    "-c:a",
    "pcm_s16le",
    outputPath,
  ]);
}

async function transcribe(samples, paths) {
  const audio = Float32Array.from(samples, (sample) => sample / 32768);
  const transcriber = await loadWhisper(paths, { offline: true });
  try {
    const result = await transcriber(audio);
    return result.text.trim();
  } finally {
    await transcriber.dispose();
  }
}

async function expectedText(options) {
  if (options.expectedTextFile) {
    const textPath = resolve(options.expectedTextFile);
    let text;
    try {
      text = await readFile(textPath, "utf8");
    } catch (error) {
      throw new Error(`Expected-text file is not readable: ${textPath}`, {
        cause: error,
      });
    }
    if (!text.trim()) throw new Error("Expected-text file is empty.");
    return text.trim();
  }
  if (options.expectedText && !options.expectedText.trim()) {
    throw new Error("Expected text is empty.");
  }
  return options.expectedText?.trim() ?? null;
}

async function reviewAudio(options, paths) {
  const sourcePath = resolve(options.audioPath);
  try {
    await access(sourcePath, fsConstants.R_OK);
  } catch (error) {
    throw new Error(`Audio file is not readable: ${sourcePath}`, {
      cause: error,
    });
  }
  const sourceText = await expectedText(options);
  await assertPrepared(paths);
  await requireCommand(
    "ffmpeg",
    ["-version"],
    "Install it from https://ffmpeg.org/download.html.",
  );
  const temporaryDirectory = await mkdtemp(
    join(tmpdir(), "linelight-voice-review-"),
  );
  const normalizedPath = join(temporaryDirectory, "normalized.wav");

  try {
    console.error(`Reviewing ${basename(sourcePath)} locally...`);
    await normalizeAudio(sourcePath, normalizedPath);
    const { sampleRate, samples } = parsePcm16Wav(
      await readFile(normalizedPath),
    );
    const signal = analyzePcm16(samples, sampleRate);
    const utmos = await runOfflineModel("UTMOS", () =>
      runUtmos(paths, ["--audio", normalizedPath], { offline: true }),
    );
    const transcript = sourceText
      ? await runOfflineModel("Whisper", () => transcribe(samples, paths))
      : null;
    const review = buildVoiceReview({
      audioPath: sourcePath,
      expectedText: sourceText,
      models: {
        utmos: UTMOS_MODEL,
        whisper: sourceText ? WHISPER_MODEL : null,
      },
      signal,
      transcript,
      utmosScore: utmos.score,
    });

    console.log(
      options.json
        ? JSON.stringify(review, null, 2)
        : formatVoiceReview(review),
    );
  } finally {
    await rm(temporaryDirectory, { force: true, recursive: true });
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }

  const paths = cachePaths(
    options.cacheDir ? resolve(options.cacheDir) : defaultCacheDir(),
  );
  if (options.prepare) {
    await prepareModels(paths, options.json);
  } else {
    await reviewAudio(options, paths);
  }
}

main().catch((error) => {
  console.error(`Voice review failed: ${error.message}`);
  process.exitCode = 1;
});
