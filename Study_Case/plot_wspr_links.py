#!/usr/bin/env python3
"""Plot WSPR links from CSV without MATLAB.

- Parses "Code Generator" calls to get flags + grids.
- Converts Maidenhead 6-char grids to lat/lon centers.
- Draws short + long great-circle paths.
"""

from __future__ import annotations

import argparse
import csv
import json
import math
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Iterable, List, Tuple

import matplotlib.pyplot as plt

ROOT = Path("/home/edgar/Desktop/other/MH370")
LAND_JSON = ROOT / "land-110m.json"

# Match WSPR_Link_GC6MIZ_DSDS_SDR_Function('0','1',...);
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


def great_circle_points(start: Tuple[float, float], end: Tuple[float, float], steps: int, use_long: bool = False) -> List[Tuple[float, float]]:
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


def color_for_flags(flags: List[str]) -> Tuple[float, float, float]:
    da, sa1, sa2, sa3, na, _rev = flags
    if da == "1":
        return (0.0, 0.0, 1.0)  # blue
    if sa1 == "1":
        return (1.0, 0.0, 0.0)  # red
    if sa2 == "1":
        return (1.0, 0.65, 0.0)  # orange
    if sa3 == "1":
        return (1.0, 1.0, 0.0)  # yellow
    if na == "1":
        return (0.0, 1.0, 0.0)  # green
    if sa3 == "0" and na == "0":
        return (0.65, 0.65, 0.65)  # gray
    return (0.0, 0.0, 0.0)


def linestyle_for_flags(flags: List[str]) -> str:
    # MATLAB uses dashed when rev == "1", solid otherwise.
    return "--" if len(flags) > 5 and flags[5] == "1" else "-"


def load_land_polygons() -> List[List[Tuple[float, float]]]:
    if not LAND_JSON.exists():
        return []
    data = json.loads(LAND_JSON.read_text())
    polygons = []
    for feat in data.get("features", []):
        geom = feat.get("geometry", {})
        gtype = geom.get("type")
        coords = geom.get("coordinates", [])
        if gtype == "Polygon":
            for ring in coords:
                polygons.append([(pt[0], pt[1]) for pt in ring])
        elif gtype == "MultiPolygon":
            for poly in coords:
                for ring in poly:
                    polygons.append([(pt[0], pt[1]) for pt in ring])
    return polygons


def parse_matlab_overlays(path: Path):
    text = path.read_text()
    markers = []
    labels = []
    routes = []
    titles = {}
    has_scaleruler = "scaleruler on" in text
    colors = {}
    text_vars = {}

    color_def_re = re.compile(r"^(\w+)\s*=\s*\[([0-9\.\s]+),([0-9\.\s]+),([0-9\.\s]+)\];", re.MULTILINE)
    for m in color_def_re.finditer(text):
        name = m.group(1)
        colors[name] = (float(m.group(2)), float(m.group(3)), float(m.group(4)))

    text_var_re = re.compile(r"^(\w+)\s*=\s*\{([^;]+)\};", re.MULTILINE | re.DOTALL)
    for m in text_var_re.finditer(text):
        name = m.group(1)
        body = m.group(2)
        parts = re.findall(r"'([^']*)'", body)
        if parts:
            text_vars[name] = "\n".join(parts)

    def parse_color(token: str):
        token = token.strip()
        if token in colors:
            return colors[token]
        if token.startswith("'") and token.endswith("'"):
            return token.strip("'")
        if token.startswith("[") and token.endswith("]"):
            parts = [p.strip() for p in token[1:-1].split(",")]
            if len(parts) == 3:
                try:
                    return (float(parts[0]), float(parts[1]), float(parts[2]))
                except ValueError:
                    return token
        return token

    marker_re = re.compile(
        r"geoshow\(([-\d\.]+),([-\d\.]+),\s*'Marker','([^']*)',\s*'color',([^,\)]+)(?:,\s*'MarkerSize',([-\d\.]+))?\);"
    )
    text_re = re.compile(r"textm\(([-\d\.]+),([-\d\.]+),\s*'([^']*)'")
    text_var_call_re = re.compile(r"textm\(([-\d\.]+),([-\d\.]+),\s*(\w+)\s*,")
    waypoint_re = re.compile(r"waypoints\s*=\s*\[([-\d\.]+),([-\d\.]+);([-\d\.]+),([-\d\.]+)\];")
    line_re = re.compile(r"geoshow\(lttrk,lntrk,'DisplayType','line','color',([^,]+),'LineWidth',([-\d\.]+)\);")
    title_re = re.compile(r"titstring(\d+)=\['(.*)'\];")

    for m in marker_re.finditer(text):
        lat = float(m.group(1))
        lon = float(m.group(2))
        marker = m.group(3)
        color = parse_color(m.group(4))
        size = float(m.group(5)) if m.group(5) else 6.0
        markers.append((lat, lon, marker, color, size))

    for m in text_re.finditer(text):
        lat = float(m.group(1))
        lon = float(m.group(2))
        label = m.group(3)
        labels.append((lat, lon, label))
    for m in text_var_call_re.finditer(text):
        lat = float(m.group(1))
        lon = float(m.group(2))
        var = m.group(3)
        if var in text_vars:
            labels.append((lat, lon, text_vars[var]))

    waypoints = []
    for m in waypoint_re.finditer(text):
        waypoints.append(((float(m.group(1)), float(m.group(2))), (float(m.group(3)), float(m.group(4)))))
    for m in line_re.finditer(text):
        color = parse_color(m.group(1))
        width = float(m.group(2))
        if waypoints:
            start, end = waypoints.pop(0)
            routes.append((start, end, color, width))

    for m in title_re.finditer(text):
        titles[int(m.group(1))] = m.group(2).strip()

    return {
        "markers": markers,
        "labels": labels,
        "routes": routes,
        "titles": titles,
        "has_scaleruler": has_scaleruler,
    }


def build_title_lines(overlays, utc_label: str | None) -> List[str]:
    if overlays and overlays["titles"]:
        title_lines = [overlays["titles"][i] for i in sorted(overlays["titles"]) if overlays["titles"][i]]
        if utc_label:
            updated = []
            replaced = False
            for line in title_lines:
                if "WSPR Links" in line and "UTC" in line:
                    updated.append(f" WSPR Links {utc_label} UTC ")
                    replaced = True
                else:
                    updated.append(line)
            if not replaced:
                updated.insert(0, f" WSPR Links {utc_label} UTC ")
            title_lines = updated
        return title_lines

    if utc_label:
        return [f" WSPR Links {utc_label} UTC "]
    return ["WSPR Links"]


def is_adsb_label(label: str) -> bool:
    if " FL" in label:
        return True
    return re.search(r"\b[A-Z]{2,3}\d{2,4}\b", label) is not None


def draw_scale_rulers(ax, lat_min: float, lat_max: float, lon_min: float, lon_max: float) -> None:
    lat = lat_min + (lat_max - lat_min) * 0.08
    lon = lon_min + (lon_max - lon_min) * 0.05
    lat_mid = (lat_min + lat_max) / 2.0
    km_per_deg_lon = 111.32 * math.cos(to_rad(lat_mid))
    if km_per_deg_lon <= 0:
        return

    def draw_bar(length_km: float, ticks: int, color: str, y_offset: float):
        length_deg = length_km / km_per_deg_lon
        x0 = lon
        x1 = lon + length_deg
        y = lat + y_offset
        ax.plot([x0, x1], [y, y], color=color, linewidth=2.0)
        for i in range(ticks + 1):
            xi = x0 + (length_deg * i / ticks)
            ax.plot([xi, xi], [y, y + (lat_max - lat_min) * 0.01], color=color, linewidth=1.0)

    # approximate MATLAB ruler lengths: 100 nm and 50 km
    draw_bar(100 * 1.852, 5, "black", 0.0)
    draw_bar(50.0, 5, "black", (lat_max - lat_min) * 0.03)


def parse_time(value: str) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(timezone.utc)
    except Exception:
        return None


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--csv", default="Study_Case/wsprspots-2014-03-07-1600-2014-03-08-0100.csv")
    parser.add_argument("--utc", help="UTC time like '2014-03-07 16:42:00'")
    parser.add_argument("--window-min", type=int, default=1)
    parser.add_argument("--steps", type=int, default=100)
    parser.add_argument("--short-width", type=float, default=2.0)
    parser.add_argument("--long-width", type=float, default=1.0)
    parser.add_argument("--tx-marker-size", type=float, default=16.0)
    parser.add_argument("--rx-marker-size", type=float, default=16.0)
    parser.add_argument("--overlay-matlab", type=str, default=None)
    parser.add_argument("--title-from-overlay", action="store_true", default=True)
    parser.add_argument("--no-title-from-overlay", action="store_false", dest="title_from_overlay")
    parser.add_argument("--out", default="Study_Case/wspr_links_plot.png")
    parser.add_argument("--lat-min", type=float, default=None)
    parser.add_argument("--lat-max", type=float, default=None)
    parser.add_argument("--lon-min", type=float, default=None)
    parser.add_argument("--lon-max", type=float, default=None)
    args = parser.parse_args()

    target_time = None
    if args.utc:
        target_time = parse_time(args.utc.replace(" ", "T") + "Z")
        if not target_time:
            raise SystemExit("Invalid --utc format")
        window = timedelta(minutes=args.window_min)

    rows = []
    with open(args.csv, newline="") as f:
        reader = csv.DictReader(f)
        for row in reader:
            if target_time:
                utc_str = row.get("UTC")
                if not isinstance(utc_str, str):
                    continue
                row_time = parse_time(utc_str.replace(" ", "T") + "Z")
                if not row_time or abs(row_time - target_time) > window:
                    continue
            call = parse_call(row.get("Code Generator", ""))
            if not call:
                continue
            flags, src, dst = call
            src_ll = maidenhead_to_latlon(src)
            dst_ll = maidenhead_to_latlon(dst)
            if not src_ll or not dst_ll:
                continue
            rows.append((flags, src_ll, dst_ll))

    if not rows:
        print("No rows matched.")
        return 1

    polygons = load_land_polygons()
    fig, ax = plt.subplots(figsize=(10, 6), dpi=150)
    ax.set_facecolor("#e8f1f8")

    for ring in polygons:
        lons = [p[0] for p in ring]
        lats = [p[1] for p in ring]
        ax.fill(lons, lats, color="#e6e6e6", edgecolor="#999999", linewidth=0.2)

    for flags, src, dst in rows:
        color = color_for_flags(flags)
        line_style = linestyle_for_flags(flags)
        short = great_circle_points(src, dst, args.steps, use_long=False)
        longp = great_circle_points(src, dst, args.steps, use_long=True)
        ax.plot(
            [p[1] for p in short],
            [p[0] for p in short],
            color=color,
            linewidth=args.short_width,
            linestyle=line_style,
        )
        ax.plot(
            [p[1] for p in longp],
            [p[0] for p in longp],
            color=color,
            linewidth=args.long_width,
            linestyle=line_style,
        )
        ax.plot([src[1]], [src[0]], marker=".", color="black", markersize=args.tx_marker_size)
        ax.plot([dst[1]], [dst[0]], marker=".", color="magenta", markersize=args.rx_marker_size)

    overlays = None
    if args.overlay_matlab:
        overlays = parse_matlab_overlays(Path(args.overlay_matlab))
        waypoint_labels = {
            "KUL 32R",
            "IGARI",
            "BITOD",
            "IBUKU",
            "GUNIP",
            "VAMPI",
            "VPG",
            "GIVAL",
        }
        skip_positions = []
        for (lat, lon, label) in overlays["labels"]:
            if label in waypoint_labels:
                continue
            if label.startswith(" 2.784") or label.startswith("2.784"):
                continue
            if is_adsb_label(label):
                skip_positions.append((lat, lon))

        def is_skipped(lat: float, lon: float) -> bool:
            for (slat, slon) in skip_positions:
                if abs(lat - slat) < 1e-6 and abs(lon - slon) < 1e-6:
                    return True
            return False

        for (lat, lon, marker, color, size) in overlays["markers"]:
            if is_skipped(lat, lon):
                continue
            ax.plot([lon], [lat], marker=marker, color=color, markersize=size)
        for (lat, lon, label) in overlays["labels"]:
            if is_adsb_label(label) and label not in waypoint_labels:
                continue
            ax.text(lon, lat, label, fontsize=9)
        for (start, end, color, width) in overlays["routes"]:
            points = great_circle_points(start, end, args.steps, use_long=False)
            ax.plot([p[1] for p in points], [p[0] for p in points], color=color, linewidth=width)
        if overlays["has_scaleruler"] and args.lat_min is not None and args.lat_max is not None:
            if args.lon_min is not None and args.lon_max is not None:
                draw_scale_rulers(ax, args.lat_min, args.lat_max, args.lon_min, args.lon_max)

    if args.lat_min is not None and args.lat_max is not None:
        ax.set_ylim(args.lat_min, args.lat_max)
    if args.lon_min is not None and args.lon_max is not None:
        ax.set_xlim(args.lon_min, args.lon_max)

    ax.set_xlabel("Longitude")
    ax.set_ylabel("Latitude")
    utc_label = None
    if args.utc:
        utc_label = args.utc
    if args.title_from_overlay:
        title_lines = build_title_lines(overlays, utc_label)
    else:
        title_lines = build_title_lines(None, utc_label)
    ax.set_title("\n".join(title_lines), fontsize=12, fontweight="bold")
    ax.grid(True, linewidth=0.2, alpha=0.4)

    fig.tight_layout()
    fig.savefig(args.out)
    print(f"Plotted {len(rows)} links -> {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
