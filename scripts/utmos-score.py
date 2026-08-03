"""Run the pinned UTMOS naturalness model against normalized speech audio."""

from __future__ import annotations

import argparse
from array import array
import hashlib
import json
from pathlib import Path
import sys
import warnings
import wave

import torch
from huggingface_hub import hf_hub_download
from utmos_pytorch import UTMOSScoreTorch


MODEL_ID = "Blinorot/UTMOS-PyTorch"
MODEL_REVISION = "4f2447e519df3b88567b45583d3500006729502b"
MODEL_FILENAME = "utmos_state_dict.pt"
MODEL_SHA256 = "21b98001a7d5164d562a40d76aff80ae996deeabe4473c3a6786d1c591c2cc47"
TARGET_SAMPLE_RATE = 16_000


def parse_args() -> argparse.Namespace:
    """Parse command-line arguments.

    Returns
    -------
    argparse.Namespace
        Parsed preparation, offline, and audio-path options.
    """

    parser = argparse.ArgumentParser()
    parser.add_argument("--audio", type=Path)
    parser.add_argument("--offline", action="store_true")
    parser.add_argument("--prepare", action="store_true")
    args = parser.parse_args()
    if not args.prepare and args.audio is None:
        parser.error("--audio is required unless --prepare is supplied")
    return args


def checkpoint_path(*, offline: bool) -> Path:
    """Resolve the immutable model checkpoint and verify its digest.

    Parameters
    ----------
    offline
        Restrict resolution to the existing local Hugging Face cache.

    Returns
    -------
    pathlib.Path
        The verified local checkpoint path.
    """

    path = Path(
        hf_hub_download(
            repo_id=MODEL_ID,
            filename=MODEL_FILENAME,
            revision=MODEL_REVISION,
            repo_type="model",
            local_files_only=offline,
        )
    )
    checksum = hashlib.sha256()
    with path.open("rb") as checkpoint_file:
        for chunk in iter(lambda: checkpoint_file.read(1024 * 1024), b""):
            checksum.update(chunk)
    digest = checksum.hexdigest()
    if digest != MODEL_SHA256:
        raise RuntimeError(
            f"UTMOS checkpoint digest mismatch: expected {MODEL_SHA256}, got {digest}"
        )
    return path


def read_audio(path: Path) -> torch.Tensor:
    """Read a mono 16 kHz PCM-16 WAV into a float tensor.

    Parameters
    ----------
    path
        Path to the normalized WAV file.

    Returns
    -------
    torch.Tensor
        One normalized mono waveform with shape ``(1, samples)``.
    """

    with wave.open(str(path), "rb") as wav_file:
        if (
            wav_file.getnchannels() != 1
            or wav_file.getframerate() != TARGET_SAMPLE_RATE
            or wav_file.getsampwidth() != 2
            or wav_file.getcomptype() != "NONE"
        ):
            raise ValueError("audio must be mono 16 kHz PCM-16 WAV")
        samples = array("h")
        samples.frombytes(wav_file.readframes(wav_file.getnframes()))

    if sys.byteorder != "little":
        samples.byteswap()
    return torch.tensor(samples, dtype=torch.float32).div_(32768.0).unsqueeze(0)


def main() -> None:
    """Prepare the model or print one JSON score to stdout."""

    args = parse_args()
    warnings.filterwarnings(
        "ignore",
        message="`torch.nn.utils.weight_norm` is deprecated",
        category=FutureWarning,
    )
    checkpoint = checkpoint_path(offline=args.offline)
    model = UTMOSScoreTorch(ckpt_path=str(checkpoint), device="cpu")

    if args.prepare:
        print(
            json.dumps(
                {
                    "checkpoint": str(checkpoint),
                    "model": MODEL_ID,
                    "revision": MODEL_REVISION,
                    "sha256": MODEL_SHA256,
                    "torch": torch.__version__,
                }
            )
        )
        return

    audio = read_audio(args.audio)
    with torch.inference_mode():
        score = float(model.score(audio).item())
    print(
        json.dumps(
            {
                "model": MODEL_ID,
                "revision": MODEL_REVISION,
                "score": score,
            }
        )
    )


if __name__ == "__main__":
    main()
