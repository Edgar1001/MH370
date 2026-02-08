#!/usr/bin/env python3
"""Filter WSPR links near BTO arcs (Richard-style candidate shortlist).

Inputs:
- Study_Case/wsprspots-2014-03-07-1600-2014-03-08-0100.csv
- arcs.json (repo root)
Outputs:
- Study_Case/wspr_candidates_from_richard.csv
- Study_Case/candidate_windows.txt (2-min windows with any candidate)
- Study_Case/plots_candidates/ (optional copies of existing plots)
"""

from __future__ import annotations

import csv
import json
import math
import shutil
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Dict, Iterable, List, Tuple

ROOT = Path("/home/edgar/Desktop/other/MH370")
WSPR_CSV = ROOT / "Study_Case/wsprspots-2014-03-07-1600-2014-03-08-0100.csv"
ARCS_JSON = ROOT / "arcs.json"
OUT_CSV = ROOT / "Study_Case/wspr_candidates_from_richard.csv"
OUT_WINDOWS = ROOT / "Study_Case/candidate_windows.txt"
PLOTS_DIR = ROOT / "Study_Case/plots_2min"
PLOTS_OUT = ROOT / "Study_Case/plots_candidates"

C_KM_S = 299792.458
EARTH_RADIUS_KM = 6371.0
WGS84_AUTHALIC_RADIUS_KM = 6371.0088
ANOMALY_ARC_TIME_WINDOW_MIN = 20
ANOMALY_ARC_DISTANCE_KM = 250
ANOMALY_CURVE_STEPS = 64

ARC_TIMES_UTC = {
    "ping-182527": "2014-03-07T18:25:27Z",
    "ping-194102": "2014-03-07T19:41:02Z",
    "ping-204104": "2014-03-07T20:41:04Z",
    "ping-214126": "2014-03-07T21:41:26Z",
    "ping-224121": "2014-03-07T22:41:21Z",
    "ping-001059": "2014-03-08T00:10:59Z",
    "ping-001929": "2014-03-08T00:19:29Z",
}


def to_rad(deg: float) -> float:
    return deg * math.pi / 180.0


def to_deg(rad: float) -> float:
    return rad * 180.0 / math.pi


def haversine_km(lat1: float, lon1: float, lat2: float, lon2: float, radius_km: float) -> float:
    dlat = to_rad(lat2 - lat1)
    dlon = to_rad(lon2 - lon1)
    a = (
        math.sin(dlat / 2) ** 2
        + math.cos(to_rad(lat1)) * math.cos(to_rad(lat2)) * math.sin(dlon / 2) ** 2
    )
    return 2 * radius_km * math.asin(min(1.0, math.sqrt(a)))


def bto_to_slant_range_km(bto_us: float) -> float:
    return (bto_us * 1e-6 * C_KM_S) / 2.0


def slant_range_to_ground_km(slant_km: float, sat_alt_km: float, earth_radius_km: float) -> float:
    rs = earth_radius_km + sat_alt_km
    re = earth_radius_km
    cos_theta = (rs * rs + re * re - slant_km * slant_km) / (2 * rs * re)
    clamped = max(-1.0, min(1.0, cos_theta))
    return re * math.acos(clamped)


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


def parse_time(value: str) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(timezone.utc)
    except Exception:
        return None


def load_arcs() -> List[Dict[str, float]]:
    data = json.loads(ARCS_JSON.read_text())
    meta = data.get("meta", {})
    range_scale = float(meta.get("range_scale", 1))
    bto_bias_us = float(meta.get("bto_bias_us", 0))
    ground_range_offset_km = float(meta.get("ground_range_offset_km", 0))
    ground_range_scale = float(meta.get("ground_range_scale", 1))
    use_wgs84 = bool(meta.get("use_wgs84", True))
    earth_radius_km = WGS84_AUTHALIC_RADIUS_KM if use_wgs84 else EARTH_RADIUS_KM
    sat_alt_km = float(meta.get("sat_alt_km", 35786))
    centers_by_arc = meta.get("centers_by_arc", {})

    arcs = []
    for arc in data.get("arcs", []):
        arc_id = arc.get("id")
        if not arc_id:
            continue
        is_r600 = str(arc.get("channel", "")).upper() == "R600"
        base_bto = float(arc.get("bto_us", 0)) + bto_bias_us
        adjusted_bto = base_bto - 4600 if is_r600 else base_bto
        slant_km = bto_to_slant_range_km(adjusted_bto) * range_scale
        base_radius_km = arc.get("radius_km") or slant_range_to_ground_km(slant_km, sat_alt_km, earth_radius_km)
        radius_km = base_radius_km * ground_range_scale + ground_range_offset_km

        center = None
        if arc.get("center_override"):
            center = arc["center_override"]
        elif centers_by_arc.get(arc_id):
            center = centers_by_arc[arc_id]
        if not center:
            continue

        arc_time = parse_time(ARC_TIMES_UTC.get(arc_id, ""))
        arcs.append(
            {
                "id": arc_id,
                "time": arc_time,
                "lat": float(center["lat"]),
                "lon": float(center["lon"]),
                "radius_km": float(radius_km),
                "earth_radius_km": earth_radius_km,
            }
        )
    return arcs


def row_in_time_window(row_time: datetime, arc_time: datetime) -> bool:
    window = timedelta(minutes=ANOMALY_ARC_TIME_WINDOW_MIN)
    return abs(row_time - arc_time) <= window


def min_distance_curve_to_arc(curve: Iterable[Tuple[float, float]], arc: Dict[str, float]) -> float:
    center_lat = arc["lat"]
    center_lon = arc["lon"]
    radius = arc["radius_km"]
    earth_radius = arc["earth_radius_km"]
    best = float("inf")
    for lat, lon in curve:
        dist = haversine_km(lat, lon, center_lat, center_lon, earth_radius)
        diff = abs(dist - radius)
        if diff < best:
            best = diff
    return best


def pick_grid(row: Dict[str, str], col6: str, col4: str) -> str | None:
    val6 = row.get(col6)
    if isinstance(val6, str) and val6.strip():
        return val6
    val4 = row.get(col4)
    if isinstance(val4, str) and val4.strip():
        return val4
    return None


def window_floor_2min(dt: datetime) -> datetime:
    minute = dt.minute - (dt.minute % 2)
    return dt.replace(minute=minute, second=0, microsecond=0)


def main() -> None:
    arcs = load_arcs()
    if not arcs:
        raise SystemExit("No arcs loaded. Check arcs.json.")

    candidates: List[Dict[str, str]] = []
    windows = set()

    with WSPR_CSV.open(newline="") as f:
        reader = csv.DictReader(f)
        for row in reader:
            tx_grid = pick_grid(row, "Tx Grid 6ch", "Tx Grid")
            rx_grid = pick_grid(row, "Rx Grid 6ch", "Rx Grid")
            if not tx_grid or not rx_grid:
                continue
            tx = maidenhead_to_latlon(tx_grid)
            rx = maidenhead_to_latlon(rx_grid)
            if not tx or not rx:
                continue

            utc_str = row.get("UTC")
            if not isinstance(utc_str, str) or not utc_str.strip():
                continue
            row_time = parse_time(utc_str.replace(" ", "T") + "Z")
            if not row_time:
                continue

            curve = great_circle_points(tx, rx, ANOMALY_CURVE_STEPS, use_long=False)
            curve_long = great_circle_points(tx, rx, ANOMALY_CURVE_STEPS, use_long=True)

            # anomaly filter: SNR 1.0 SD Anom == 1
            if str(row.get("SNR 1.0 SD Anom", "0")).strip() != "1":
                continue

            for arc in arcs:
                if not arc["time"]:
                    continue
                if not row_in_time_window(row_time, arc["time"]):
                    continue
                min_dist = min_distance_curve_to_arc(curve, arc)
                min_dist_long = min_distance_curve_to_arc(curve_long, arc)
                best_dist = min(min_dist, min_dist_long)
                if best_dist <= ANOMALY_ARC_DISTANCE_KM:
                    candidates.append(
                        {
                            "utc": utc_str,
                            "band": row.get("Band", ""),
                            "tx": row.get("Tx", ""),
                            "rx": row.get("Rx", ""),
                            "tx_grid": tx_grid,
                            "rx_grid": rx_grid,
                            "tx_lat": f"{tx[0]:.6f}",
                            "tx_lon": f"{tx[1]:.6f}",
                            "rx_lat": f"{rx[0]:.6f}",
                            "rx_lon": f"{rx[1]:.6f}",
                            "snr": row.get("SNR", ""),
                            "freq_mhz": row.get("Frequency", ""),
                            "drift": row.get("Drift", ""),
                            "distance_km": row.get("Distance", ""),
                            "arc_id": arc["id"],
                            "arc_time": arc["time"].isoformat(),
                            "arc_radius_km": f"{arc['radius_km']:.2f}",
                            "min_dist_to_arc_km": f"{best_dist:.2f}",
                            "path": "long" if min_dist_long < min_dist else "short",
                        }
                    )
                    win = window_floor_2min(row_time)
                    windows.add(win)
                    break

    if not candidates:
        print("No candidates found with current thresholds.")
        return

    with OUT_CSV.open("w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=candidates[0].keys())
        writer.writeheader()
        writer.writerows(candidates)

    with OUT_WINDOWS.open("w") as f:
        for dt in sorted(windows):
            f.write(dt.strftime("%Y-%m-%d %H:%M:%S") + "\n")

    # Optionally copy plots for those windows
    if PLOTS_DIR.exists():
        PLOTS_OUT.mkdir(parents=True, exist_ok=True)
        for dt in sorted(windows):
            ts = dt.strftime("%Y-%m-%d_%H%M")
            src = PLOTS_DIR / f"wspr_links_{ts}.png"
            if src.exists():
                shutil.copy2(src, PLOTS_OUT / src.name)

    print(f"Candidates: {len(candidates)}")
    print(f"Windows: {len(windows)}")
    print(f"Wrote: {OUT_CSV}")
    print(f"Wrote: {OUT_WINDOWS}")
    if PLOTS_OUT.exists():
        print(f"Copied plots to: {PLOTS_OUT}")


if __name__ == "__main__":
    main()
