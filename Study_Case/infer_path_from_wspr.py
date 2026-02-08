#!/usr/bin/env python3
"""Infer a coarse path from anomaly-flagged WSPR links by density of link samples.

Heuristic:
- For each 2-minute timestamp, select WSPR rows in a +/- window (minutes).
- Keep only anomaly-flagged links (da/sa1/sa2/sa3/na).
- Sample short + long great-circle points for each link.
- Build a grid of counts within bounds; pick max cell as inferred point.
"""

from __future__ import annotations

import argparse
import csv
import math
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Iterable, List, Tuple

ROOT = Path("/home/edgar/Desktop/other/MH370")

CALL_RE = re.compile(r"WSPR_Link_GC6MIZ_DSDS_SDR_Function\(([^)]*)\)")


def to_rad(deg: float) -> float:
    return deg * math.pi / 180.0


def to_deg(rad: float) -> float:
    return rad * 180.0 / math.pi


def maidenhead_to_latlon(grid: str) -> Tuple[float, float] | None:
    if not isinstance(grid, str):
        return None
    g = grid.strip()
    if len(g) < 4:
        return None
    g = g.upper()
    if not g[0].isalpha() or not g[1].isalpha():
        return None
    lon = (ord(g[0]) - ord("A")) * 20 - 180
    lat = (ord(g[1]) - ord("A")) * 10 - 90
    size_lon = 20.0
    size_lat = 10.0

    if len(g) >= 4 and g[2].isdigit() and g[3].isdigit():
        lon += int(g[2]) * 2
        lat += int(g[3]) * 1
        size_lon = 2.0
        size_lat = 1.0
    else:
        return (lat + size_lat / 2.0, lon + size_lon / 2.0)

    if len(g) >= 6 and g[4].isalpha() and g[5].isalpha():
        lon += (ord(g[4]) - ord("A")) * (5.0 / 60.0)
        lat += (ord(g[5]) - ord("A")) * (2.5 / 60.0)
        size_lon = 5.0 / 60.0
        size_lat = 2.5 / 60.0

    return (lat + size_lat / 2.0, lon + size_lon / 2.0)


def latlon_to_vec(lat: float, lon: float) -> Tuple[float, float, float]:
    lat_r = to_rad(lat)
    lon_r = to_rad(lon)
    return (
        math.cos(lat_r) * math.cos(lon_r),
        math.cos(lat_r) * math.sin(lon_r),
        math.sin(lat_r),
    )


def vec_to_latlon(vec: Tuple[float, float, float]) -> Tuple[float, float]:
    x, y, z = vec
    lat = to_deg(math.atan2(z, math.sqrt(x * x + y * y)))
    lon = to_deg(math.atan2(y, x))
    return lat, lon


def cross(a: Tuple[float, float, float], b: Tuple[float, float, float]) -> Tuple[float, float, float]:
    return (a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0])


def dot(a: Tuple[float, float, float], b: Tuple[float, float, float]) -> float:
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]


def norm(v: Tuple[float, float, float]) -> float:
    return math.sqrt(dot(v, v))


def scale(v: Tuple[float, float, float], s: float) -> Tuple[float, float, float]:
    return (v[0] * s, v[1] * s, v[2] * s)


def add(a: Tuple[float, float, float], b: Tuple[float, float, float]) -> Tuple[float, float, float]:
    return (a[0] + b[0], a[1] + b[1], a[2] + b[2])


def rotate(vec: Tuple[float, float, float], axis: Tuple[float, float, float], angle: float) -> Tuple[float, float, float]:
    axis_len = norm(axis)
    if axis_len == 0:
        return vec
    axis = scale(axis, 1.0 / axis_len)
    cos_a = math.cos(angle)
    sin_a = math.sin(angle)
    return add(
        add(scale(vec, cos_a), scale(cross(axis, vec), sin_a)),
        scale(axis, dot(axis, vec) * (1 - cos_a)),
    )


def great_circle_points(
    start: Tuple[float, float],
    end: Tuple[float, float],
    steps: int,
    use_long: bool = False,
) -> List[Tuple[float, float]]:
    s = latlon_to_vec(*start)
    e = latlon_to_vec(*end)
    dotp = max(-1.0, min(1.0, dot(s, e)))
    theta = math.acos(dotp)
    if theta < 1e-12:
        return [start, end]
    axis = cross(s, e)
    if norm(axis) < 1e-12:
        return [start, end]
    if use_long:
        axis = scale(axis, -1.0)
        theta = 2 * math.pi - theta
    points = []
    for i in range(steps):
        frac = i / (steps - 1)
        vec = rotate(s, axis, theta * frac)
        points.append(vec_to_latlon(vec))
    return points


def parse_call(code: str):
    if not code:
        return None
    m = CALL_RE.search(code)
    if not m:
        return None
    args = re.findall(r"'([^']*)'", m.group(1))
    if len(args) < 18:
        return None
    flags = args[:6]
    src = "".join(args[6:12])
    dst = "".join(args[12:18])
    return flags, src, dst


def is_anomaly(flags: List[str]) -> bool:
    da, sa1, sa2, sa3, na, _rev = flags
    return da == "1" or sa1 == "1" or sa2 == "1" or sa3 == "1" or na == "1"


def parse_time(value: str) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(timezone.utc)
    except Exception:
        return None


def window_floor_2min(dt: datetime) -> datetime:
    minute = dt.minute - (dt.minute % 2)
    return dt.replace(minute=minute, second=0, microsecond=0)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--csv", default="Study_Case/wsprspots-2014-03-07-1600-2014-03-08-0100.csv")
    parser.add_argument("--start", required=True, help="UTC start like '2014-03-07 18:00:00'")
    parser.add_argument("--end", required=True, help="UTC end like '2014-03-08 01:00:00'")
    parser.add_argument("--window-min", type=int, default=1)
    parser.add_argument("--steps", type=int, default=120)
    parser.add_argument("--grid-deg", type=float, default=0.05)
    parser.add_argument("--lat-min", type=float, required=True)
    parser.add_argument("--lat-max", type=float, required=True)
    parser.add_argument("--lon-min", type=float, required=True)
    parser.add_argument("--lon-max", type=float, required=True)
    parser.add_argument("--out", default="Study_Case/path_inferred_anomaly.csv")
    args = parser.parse_args()

    start = datetime.fromisoformat(args.start).replace(tzinfo=timezone.utc)
    end = datetime.fromisoformat(args.end).replace(tzinfo=timezone.utc)
    window = timedelta(minutes=args.window_min)
    step = timedelta(minutes=2)

    # Preload rows
    rows = []
    with open(args.csv, newline="") as f:
        reader = csv.DictReader(f)
        for row in reader:
            utc_str = row.get("UTC")
            if not isinstance(utc_str, str):
                continue
            row_time = parse_time(utc_str.replace(" ", "T") + "Z")
            if not row_time:
                continue
            call = parse_call(row.get("Code Generator", ""))
            if not call:
                continue
            flags, src, dst = call
            if not is_anomaly(flags):
                continue
            src_ll = maidenhead_to_latlon(src)
            dst_ll = maidenhead_to_latlon(dst)
            if not src_ll or not dst_ll:
                continue
            rows.append((row_time, src_ll, dst_ll))

    if not rows:
        print("No anomaly rows matched.")
        return 1

    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)

    lat_min = args.lat_min
    lat_max = args.lat_max
    lon_min = args.lon_min
    lon_max = args.lon_max
    grid = args.grid_deg

    def grid_index(lat: float, lon: float) -> Tuple[int, int]:
        return (int((lat - lat_min) / grid), int((lon - lon_min) / grid))

    def grid_center(i: int, j: int) -> Tuple[float, float]:
        return (lat_min + (i + 0.5) * grid, lon_min + (j + 0.5) * grid)

    current = start
    inferred = []
    while current <= end:
        t0 = current - window
        t1 = current + window
        counts = {}
        for row_time, src, dst in rows:
            if row_time < t0 or row_time > t1:
                continue
            short = great_circle_points(src, dst, args.steps, use_long=False)
            longp = great_circle_points(src, dst, args.steps, use_long=True)
            for lat, lon in short + longp:
                if lat < lat_min or lat > lat_max or lon < lon_min or lon > lon_max:
                    continue
                key = grid_index(lat, lon)
                counts[key] = counts.get(key, 0) + 1

        if counts:
            best_key = max(counts, key=counts.get)
            best_lat, best_lon = grid_center(*best_key)
            inferred.append((current, best_lat, best_lon, counts[best_key]))
        else:
            inferred.append((current, None, None, 0))

        current += step

    # simple smoothing (3-point moving average) for non-empty points
    smoothed = []
    for i, (t, lat, lon, score) in enumerate(inferred):
        if lat is None or lon is None:
            smoothed.append((t, None, None, score))
            continue
        lat_vals = []
        lon_vals = []
        for j in range(max(0, i - 1), min(len(inferred), i + 2)):
            _, lat_j, lon_j, _ = inferred[j]
            if lat_j is not None and lon_j is not None:
                lat_vals.append(lat_j)
                lon_vals.append(lon_j)
        if lat_vals:
            smoothed.append((t, sum(lat_vals) / len(lat_vals), sum(lon_vals) / len(lon_vals), score))
        else:
            smoothed.append((t, lat, lon, score))

    with out_path.open("w", newline="") as f:
        writer = csv.writer(f)
        writer.writerow(["utc", "lat", "lon", "score"])
        for t, lat, lon, score in smoothed:
            writer.writerow([t.strftime("%Y-%m-%d %H:%M:%S"), f"{lat:.6f}" if lat is not None else "", f"{lon:.6f}" if lon is not None else "", score])

    print(f"Wrote inferred path -> {out_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
