import assert from "node:assert/strict";
import test from "node:test";

import {
  SUPERTONIC_SAMPLE_RATE,
  createSupertonicRuntime,
  createSupertonicVoiceStyle,
  encodePcm16Wave,
  preprocessSupertonicText,
  splitSupertonicText,
} from "../app/supertonic-runtime.mjs";

class FakeTensor {
  constructor(type, data, dims) {
    this.type = type;
    this.data = data;
    this.dims = dims;
  }
}

test("normalizes bounded English prose for Supertonic", () => {
  assert.equal(
    preprocessSupertonicText("  Reading — quietly 🙂  "),
    "<en>Reading - quietly.</en>",
  );
  assert.equal(
    preprocessSupertonicText("Write me @ noon!"),
    "<en>Write me at noon!</en>",
  );
});

test("splits long passages without losing their normalized text", () => {
  const source = `${"A calm sentence with several useful words. ".repeat(8)}A final thought.`;
  const segments = splitSupertonicText(source, 120);

  assert.ok(segments.length > 1);
  assert.ok(segments.every((segment) => segment.length <= 120));
  assert.equal(segments.join(" "), source.replace(/\s+/gu, " ").trim());
});

test("validates pinned voice styles before creating tensors", () => {
  const style = createSupertonicVoiceStyle(
    {
      style_ttl: {
        dims: [1, 50, 256],
        data: [Array.from({ length: 50 }, () => new Array(256).fill(0.25))],
      },
      style_dp: {
        dims: [1, 8, 16],
        data: [Array.from({ length: 8 }, () => new Array(16).fill(-0.5))],
      },
    },
    FakeTensor,
  );

  assert.deepEqual(style.ttl.dims, [1, 50, 256]);
  assert.equal(style.ttl.data.length, 12_800);
  assert.deepEqual(style.dp.dims, [1, 8, 16]);
  assert.equal(style.dp.data.length, 128);
  assert.throws(
    () =>
      createSupertonicVoiceStyle(
        { style_ttl: { dims: [1], data: [0] } },
        FakeTensor,
      ),
    /unexpected shape/u,
  );
});

test("encodes native 44.1 kHz mono PCM-16 WAV", () => {
  const wav = encodePcm16Wave(
    new Float32Array([-2, -1, -0.5, 0, 0.5, 1, 2]),
  );
  const view = new DataView(wav);
  const ascii = (offset, length) =>
    new TextDecoder().decode(new Uint8Array(wav, offset, length));

  assert.equal(ascii(0, 4), "RIFF");
  assert.equal(ascii(8, 4), "WAVE");
  assert.equal(view.getUint16(20, true), 1);
  assert.equal(view.getUint16(22, true), 1);
  assert.equal(view.getUint32(24, true), SUPERTONIC_SAMPLE_RATE);
  assert.equal(view.getUint32(28, true), SUPERTONIC_SAMPLE_RATE * 2);
  assert.equal(view.getUint16(34, true), 16);
  assert.equal(view.getInt16(44, true), -32_768);
  assert.equal(view.getInt16(56, true), 32_767);
});

test("runs the four-session synthesis contract and releases every session", async () => {
  let vectorRuns = 0;
  let releases = 0;
  const releasable = (session) => ({
    ...session,
    release() {
      releases += 1;
    },
  });
  const sessions = {
    durationPredictor: releasable({
      async run() {
        return { duration: { data: new Float32Array([0.1]) } };
      },
    }),
    textEncoder: releasable({
      async run() {
        return { text_emb: new FakeTensor("float32", new Float32Array([1]), [1, 1]) };
      },
    }),
    vectorEstimator: releasable({
      async run(feeds) {
        vectorRuns += 1;
        return {
          denoised_latent: {
            data: new Float32Array(feeds.noisy_latent.data),
          },
        };
      },
    }),
    vocoder: releasable({
      async run() {
        return { wav_tts: { data: new Float32Array(5_000).fill(0.1) } };
      },
    }),
  };
  const runtime = createSupertonicRuntime({
    config: {
      ae: { sample_rate: 44_100, base_chunk_size: 512 },
      ttl: { chunk_compress_factor: 6, latent_dim: 24 },
    },
    indexer: new Array(1_000).fill(1),
    sessions,
    Tensor: FakeTensor,
    random: () => 0.5,
  });
  const style = {
    ttl: new FakeTensor("float32", new Float32Array(1), [1]),
    dp: new FakeTensor("float32", new Float32Array(1), [1]),
  };
  const progress = [];

  const audio = await runtime.generate("Ready.", {
    style,
    speed: 1,
    steps: 5,
    onProgress: (completed, total) => progress.push([completed, total]),
  });

  assert.equal(vectorRuns, 5);
  assert.deepEqual(progress.at(-1), [5, 5]);
  assert.equal(audio.sampling_rate, 44_100);
  assert.equal(audio.audio.length, 4_410);
  assert.equal(new DataView(audio.toWav()).getUint32(24, true), 44_100);

  await runtime.dispose();
  assert.equal(releases, 4);
});
