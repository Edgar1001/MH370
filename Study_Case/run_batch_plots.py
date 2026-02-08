#!/usr/bin/env python3
"""Batch-generate 2-minute WSPR plots (Richard-style)."""

from datetime import datetime, timedelta, timezone
from pathlib import Path
import argparse
import subprocess

ROOT = Path("/home/edgar/Desktop/other/MH370")
PLOTTER = ROOT / "Study_Case/plot_wspr_links.py"
DEFAULT_OUT_DIR = ROOT / "Study_Case/plots_2min"
OVERLAY = ROOT / "Study_Case/GDTAAA_V5_07032014_1642_UTC_N_Local_SDR.m"

parser = argparse.ArgumentParser()
parser.add_argument("--out-dir", default=None)
parser.add_argument("--no-overlay", action="store_true", default=False)
parser.add_argument("--start", default="2014-03-07 16:00:00")
parser.add_argument("--end", default="2014-03-08 01:00:00")
args = parser.parse_args()

start = datetime.fromisoformat(args.start).replace(tzinfo=timezone.utc)
end = datetime.fromisoformat(args.end).replace(tzinfo=timezone.utc)

if args.out_dir:
    out_dir = Path(args.out_dir)
else:
    start_label = start.strftime("%Y-%m-%d_%H%M")
    end_label = end.strftime("%Y-%m-%d_%H%M")
    out_dir = DEFAULT_OUT_DIR.parent / f"{DEFAULT_OUT_DIR.name}_{start_label}_to_{end_label}"
out_dir.mkdir(parents=True, exist_ok=True)
step = timedelta(minutes=2)

current = start
count = 0
while current <= end:
    ts = current.strftime("%Y-%m-%d_%H%M")
    out_path = out_dir / f"wspr_links_{ts}.png"
    cmd = [
        "python3",
        str(PLOTTER),
        "--utc",
        current.strftime("%Y-%m-%d %H:%M:%S"),
        "--window-min",
        "1",
        "--lat-min",
        "1",
        "--lat-max",
        "6",
        "--lon-min",
        "99",
        "--lon-max",
        "105",
        *([] if args.no_overlay else ["--overlay-matlab", str(OVERLAY)]),
        "--out",
        str(out_path),
    ]
    subprocess.run(cmd, check=True)
    count += 1
    current += step

print(f"Generated {count} plots in {out_dir}")
