#!/usr/bin/env python3
"""Generate synthetic flowing-water clips as YUV4MPEG2 (.y4m, I420) for the
Chromium fake camera used by the end-to-end tests.

Usage
-----
    python3 scripts/make-test-video.py --out tests/fixtures/video/flow-ne.y4m \
        --angle 45 --speed 1.5 --jitter 1.2 --seconds 5 --fps 15 --width 640 --height 480
    python3 scripts/make-test-video.py --out tests/fixtures/video/flow-s.y4m --angle 180 --speed 1.5 --jitter 1.2
    python3 scripts/make-test-video.py --out tests/fixtures/video/still.y4m --still
    python3 scripts/make-test-video.py --out tests/fixtures/video/blank.y4m --blank

Options
-------
    --angle DEG     direction the water moves on screen: 0 = up, 90 = right,
                    180 = down (clockwise, like a compass drawn on the screen)
    --speed PX      flow speed in pixels per frame AT THE APP'S ANALYSIS WIDTH
                    (config.ANALYSIS_WIDTH = 160 px). The generator multiplies it
                    by width/160, so "--speed 1.5" at 640x480 moves 6 px per
                    frame on the file and 1.5 px per frame after the app has
                    downscaled the camera image, exactly like the 160x120 clips
                    in tests/flow.test.mjs. The same scaling applies to --jitter
                    and to the texture, so the clip looks the same to the flow
                    estimator whatever the output size.
    --jitter PX     camera-shake amplitude (analysis px), an ellipse traced at
                    --jitter-hz (default 2 Hz); --jitter-ratio sets its y/x axis
                    ratio (1 = circle, 0 = horizontal line)
    --still         textured water that does not move (per-frame noise only)
    --blank         flat gray, no texture at all
    --seed N        deterministic texture and noise
    --noise STD     per-frame Gaussian sensor noise in gray levels (default 2)
    --contrast STD  texture standard deviation in gray levels (default 36)
    --glints N      number of bright specular spots (default 40)
    --png PATH      also write the first frame as a PNG (needs Pillow)
    --no-seamless   do not adjust the texture period for a seamless loop

The clip loops seamlessly: the texture tile's period is set to an integer
fraction of the total drift, the speed is nudged by well under 1% so the drift
is an exact multiple of that period, and the jitter frequency is rounded to a
whole number of cycles. The script prints the exact speed and angle it used.
Chromium loops the file for ever, so a 4 s capture never sees a jump.

Format: header "YUV4MPEG2 W640 H480 F15:1 Ip A1:1 C420mpeg2", then for each
frame "FRAME\\n" followed by the raw I420 planes (Y full size, then U and V at
half size). Gray is written as limited-range luma (16..235) with U = V = 128.
A 5 s clip at 15 fps and 640x480 is 34.6 MB; 6 s would be 41.5 MB. The file is
verified with ffprobe when it is installed.

Chromium flags for the e2e tests (absolute path required):
    --use-fake-device-for-media-stream
    --use-file-for-fake-video-capture=/abs/path/tests/fixtures/video/flow-ne.y4m
    --use-fake-ui-for-media-stream

Requires numpy. Pillow only for --png.
"""

import argparse
import math
import os
import re
import shutil
import subprocess
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_ANALYSIS_WIDTH = 160


def analysis_width():
    """Read ANALYSIS_WIDTH from docs/config.js so the two stay in sync."""
    try:
        with open(os.path.join(HERE, "..", "docs", "config.js"), encoding="utf-8") as fh:
            m = re.search(r"ANALYSIS_WIDTH\s*=\s*(\d+)", fh.read())
            if m:
                return int(m.group(1))
    except OSError:
        pass
    return DEFAULT_ANALYSIS_WIDTH


# ---------------------------------------------------------------------------
# Texture: the recipe of tests/helpers/synth.mjs in numpy


def smoothstep5(t):
    """Quintic smoothstep 6t^5 - 15t^4 + 10t^3 (C2 continuous)."""
    return t * t * t * (t * (t * 6 - 15) + 10)


def value_noise(period_y, period_x, cells_y, cells_x, rng):
    """One octave of tiling value noise over a period_y x period_x tile."""
    lattice = rng.random((cells_y, cells_x), dtype=np.float32)
    cy = np.arange(period_y, dtype=np.float32) * (cells_y / period_y)
    cx = np.arange(period_x, dtype=np.float32) * (cells_x / period_x)
    j0 = np.floor(cy).astype(np.int64)
    i0 = np.floor(cx).astype(np.int64)
    fy = smoothstep5(cy - j0)[:, None]
    fx = smoothstep5(cx - i0)[None, :]
    j0 %= cells_y
    i0 %= cells_x
    j1 = (j0 + 1) % cells_y
    i1 = (i0 + 1) % cells_x
    top = lattice[np.ix_(j0, i0)] + (lattice[np.ix_(j0, i1)] - lattice[np.ix_(j0, i0)]) * fx
    bottom = lattice[np.ix_(j1, i0)] + (lattice[np.ix_(j1, i1)] - lattice[np.ix_(j1, i0)]) * fx
    return top + (bottom - top) * fy


def make_water_texture(period_y, period_x, scale, rng, *, base_wavelength=24.0, octaves=4,
                       persistence=0.5, contrast=36.0, glints=40, glint_amplitude=90.0,
                       glint_radius=1.6):
    """Periodic water texture in gray levels [0, 255]. Lengths in analysis px
    are multiplied by `scale` so the texture looks the same after downscaling."""
    data = np.zeros((period_y, period_x), dtype=np.float32)
    for k in range(octaves):
        wavelength = base_wavelength * scale / (2 ** k)
        cells_x = max(1, round(period_x / wavelength))
        cells_y = max(1, round(period_y / wavelength))
        data += (persistence ** k) * value_noise(period_y, period_x, cells_y, cells_x, rng)
    std = float(data.std()) or 1.0
    data = 128.0 + contrast * (data - float(data.mean())) / std

    # Glints: Gaussian highlights that ride along with the water.
    ys = np.arange(period_y, dtype=np.float32)[:, None]
    xs = np.arange(period_x, dtype=np.float32)[None, :]
    for _ in range(glints):
        cx = rng.random() * period_x
        cy = rng.random() * period_y
        r = glint_radius * scale * (0.6 + 0.8 * rng.random())
        a = glint_amplitude * (0.5 + rng.random())
        # shortest wrapped distance on the torus
        dx = (xs - cx + period_x / 2) % period_x - period_x / 2
        dy = (ys - cy + period_y / 2) % period_y - period_y / 2
        data += a * np.exp(-(dx * dx + dy * dy) / (2 * r * r))
    return np.clip(data, 0, 255).astype(np.float32)


def render_frame(tex, width, height, ox, oy):
    """Bilinear sample of the wrapping texture translated by (ox, oy) px:
    pixel (x, y) shows texture point (x - ox, y - oy)."""
    period_y, period_x = tex.shape
    u = (np.arange(width, dtype=np.float64) - ox) % period_x
    v = (np.arange(height, dtype=np.float64) - oy) % period_y
    i0 = np.floor(u).astype(np.int64)
    j0 = np.floor(v).astype(np.int64)
    fx = (u - i0).astype(np.float32)[None, :]
    fy = (v - j0).astype(np.float32)[:, None]
    i0 %= period_x
    j0 %= period_y
    i1 = (i0 + 1) % period_x
    j1 = (j0 + 1) % period_y
    top = tex[np.ix_(j0, i0)] + (tex[np.ix_(j0, i1)] - tex[np.ix_(j0, i0)]) * fx
    bottom = tex[np.ix_(j1, i0)] + (tex[np.ix_(j1, i1)] - tex[np.ix_(j1, i0)]) * fx
    return top + (bottom - top) * fy


# ---------------------------------------------------------------------------
# Seamless-loop arithmetic


def loop_period(drift, frame_dim, min_period=48):
    """Texture period along one axis for a seamless loop.

    drift is the total translation over the clip in px. Returns (period, drift')
    where drift' is the nearest value to drift that is an integer multiple of
    period, or (frame_dim, drift) when the axis does not move or the period
    would be too small to look like water."""
    if abs(drift) < 1e-6:
        return frame_dim, 0.0
    cycles = max(1, round(abs(drift) / frame_dim))
    period = int(round(abs(drift) / cycles))
    if period < min_period:
        print(f"  note: drift of {abs(drift):.1f} px is too short for a seamless loop on this axis; "
              f"the clip will jump once per loop (use a longer or faster clip)")
        return frame_dim, drift
    return period, math.copysign(cycles * period, drift)


# ---------------------------------------------------------------------------
# y4m output


def write_y4m(path, width, height, fps, frames):
    """frames: iterable of uint8 (height, width) luma planes, full range 0..255."""
    half = (height // 2) * (width // 2)
    chroma = np.full(half, 128, dtype=np.uint8).tobytes()
    header = f"YUV4MPEG2 W{width} H{height} F{fps}:1 Ip A1:1 C420mpeg2\n"
    count = 0
    with open(path, "wb") as fh:
        fh.write(header.encode("ascii"))
        for gray in frames:
            # full range gray -> limited range luma (BT.601 video levels)
            luma = np.clip(np.rint(16.0 + gray.astype(np.float32) * (219.0 / 255.0)), 16, 235).astype(np.uint8)
            fh.write(b"FRAME\n")
            fh.write(luma.tobytes())
            fh.write(chroma)
            fh.write(chroma)
            count += 1
    return count


def verify_with_ffprobe(path):
    exe = shutil.which("ffprobe")
    if not exe:
        print("ffprobe not found; skipping verification")
        return True
    cmd = [exe, "-v", "error", "-count_frames", "-select_streams", "v:0", "-show_entries",
           "stream=codec_name,width,height,pix_fmt,r_frame_rate,nb_read_frames",
           "-of", "default=noprint_wrappers=1", path]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        print("ffprobe failed:", proc.stderr.strip(), file=sys.stderr)
        return False
    info = dict(line.split("=", 1) for line in proc.stdout.strip().splitlines() if "=" in line)
    print("ffprobe: " + ", ".join(f"{k}={v}" for k, v in info.items()))
    return info.get("pix_fmt") == "yuv420p" and info.get("codec_name") == "rawvideo"


# ---------------------------------------------------------------------------


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0], formatter_class=argparse.RawDescriptionHelpFormatter,
                                 epilog=__doc__[__doc__.index("Options"):])
    ap.add_argument("--out", required=True, help="output .y4m path")
    ap.add_argument("--angle", type=float, default=45.0, help="flow direction, 0 = up, clockwise (default 45)")
    ap.add_argument("--speed", type=float, default=1.5, help="px/frame at the analysis width (default 1.5)")
    ap.add_argument("--jitter", type=float, default=0.0, help="camera jitter amplitude, analysis px (default 0)")
    ap.add_argument("--jitter-hz", type=float, default=2.0, help="jitter frequency in Hz (default 2)")
    ap.add_argument("--jitter-ratio", type=float, default=1.0, help="jitter ellipse y/x ratio (default 1 = circle)")
    ap.add_argument("--seconds", type=float, default=5.0, help="clip length (default 5)")
    ap.add_argument("--fps", type=int, default=15, help="frame rate (default 15)")
    ap.add_argument("--width", type=int, default=640)
    ap.add_argument("--height", type=int, default=480)
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--noise", type=float, default=2.0, help="per-frame noise std (default 2)")
    ap.add_argument("--contrast", type=float, default=36.0, help="texture std in gray levels (default 36)")
    ap.add_argument("--glints", type=int, default=40)
    ap.add_argument("--still", action="store_true", help="textured but motionless water")
    ap.add_argument("--blank", action="store_true", help="flat gray, no texture")
    ap.add_argument("--no-seamless", action="store_true", help="keep the exact speed, allow a seam at the loop")
    ap.add_argument("--png", help="write the first frame as PNG (needs Pillow)")
    args = ap.parse_args(argv)

    if args.width % 2 or args.height % 2:
        ap.error("--width and --height must be even for I420")
    n_frames = max(2, int(round(args.seconds * args.fps)))
    scale = args.width / analysis_width()
    rng = np.random.default_rng(args.seed)

    # Motion in output pixels per frame; angle 0 = up (-y), 90 = right (+x).
    speed = 0.0 if (args.still or args.blank) else args.speed * scale
    rad = math.radians(args.angle)
    vx = speed * math.sin(rad)
    vy = -speed * math.cos(rad)
    if abs(vx) < 1e-9:
        vx = 0.0
    if abs(vy) < 1e-9:
        vy = 0.0

    # Texture period per axis so the clip loops without a seam.
    if args.no_seamless:
        period_x, period_y = args.width, args.height
    else:
        period_x, drift_x = loop_period(vx * n_frames, args.width)
        period_y, drift_y = loop_period(vy * n_frames, args.height)
        vx = drift_x / n_frames
        vy = drift_y / n_frames
    actual_speed = math.hypot(vx, vy)
    actual_angle = (math.degrees(math.atan2(vx, -vy)) % 360.0) if actual_speed > 0 else args.angle

    # Jitter: whole cycles over the clip so it loops too.
    jitter_amp = 0.0 if args.blank else args.jitter * scale
    cycles = round(args.jitter_hz * n_frames / args.fps)
    if jitter_amp > 0 and cycles < 1:
        cycles = 1
    jitter_hz = cycles * args.fps / n_frames if jitter_amp > 0 else 0.0

    mode = "blank" if args.blank else ("still" if args.still else "flow")
    print(f"{mode}: {args.width}x{args.height} @ {args.fps} fps, {n_frames} frames ({n_frames / args.fps:.2f} s), seed {args.seed}")
    if mode == "flow":
        print(f"  motion: angle {actual_angle:.3f} deg, speed {actual_speed / scale:.4f} analysis px/frame "
              f"({actual_speed:.4f} px/frame on file; requested {args.angle} deg, {args.speed}); "
              f"texture period {period_x}x{period_y} px")
    if jitter_amp > 0:
        print(f"  jitter: {args.jitter} analysis px ({jitter_amp:.2f} px on file) at {jitter_hz:.3f} Hz, ratio {args.jitter_ratio}")

    if mode == "blank":
        tex = None
    else:
        tex = make_water_texture(period_y, period_x, scale, rng, contrast=args.contrast, glints=args.glints)

    def frames():
        for k in range(n_frames):
            if tex is None:
                gray = np.full((args.height, args.width), 128.0, dtype=np.float32)
            else:
                t = 2 * math.pi * jitter_hz * k / args.fps
                ox = k * vx + jitter_amp * math.sin(t)
                oy = k * vy + jitter_amp * args.jitter_ratio * math.cos(t)
                gray = render_frame(tex, args.width, args.height, ox, oy)
            if args.noise > 0:
                gray = gray + rng.normal(0.0, args.noise, gray.shape).astype(np.float32)
            gray = np.clip(np.rint(gray), 0, 255).astype(np.uint8)
            if k == 0 and args.png:
                from PIL import Image  # optional dependency
                Image.fromarray(gray, mode="L").save(args.png)
                print(f"  preview: {args.png}")
            yield gray

    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    count = write_y4m(args.out, args.width, args.height, args.fps, frames())
    size = os.path.getsize(args.out)
    print(f"wrote {args.out}: {count} frames, {size / 1e6:.1f} MB")
    if not verify_with_ffprobe(args.out):
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
