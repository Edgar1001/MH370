#!/usr/bin/env python3
"""Filter WSPR links using Richard-style rules:
1) 2-minute bins
2) SNR + drift anomalies (robust z-score thresholds)
3) Arc proximity filter (time window + distance to arc)
"""

from __future__ import annotations

import argparse
import csv
import json
import math
from collections import defaultdict
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Dict, Iterable, List, Tuple

ROOT = Path("/home/edgar/Desktop/other/MH370")

FIELDS = [
    "time",
    "band",
    "tx_sign",
    "tx_lat",
    "tx_lon",
    "rx_sign",
    "rx_lat",
    "rx_lon",
    "frequency",
    "snr",
    "drift",
    "power",
    "distance",
]

C_KM_S = 299792.458
EARTH_RADIUS_KM = 6371.0
WGS84_AUTHALIC_RADIUS_KM = 6371.0088

ARC_TIMES_UTC = {
    "ping-182527": "2014-03-07T18:25:27Z",
    "ping-194102": "2014-03-07T19:41:02Z",
    "ping-204104": "2014-03-07T20:41:04Z",
    "ping-214126": "2014-03-07T21:41:26Z",
    "ping-224121": "2014-03-07T22:41:21Z",
    "ping-001059": "2014-03-08T00:10:59Z",
    "ping-001929": "2014-03-08T00:19:29Z",
}


@dataclass
class Baseline:
    count: int
    snr_med: float | None
    snr_mad: float | None
    drift_med: float | None
    drift_mad: float | None


def to_rad(deg: float) -> float:
    return deg * math.pi / 180.0


def to_deg(rad: float) -> float:
    return rad * 180.0 / math.pi


def to_float(value: str) -> float | None:
    try:
        return float(value)
    except Exception:
        return None


def median(values: List[float]) -> float | None:
    if not values:
        return None
    vals = sorted(values)
    n = len(vals)
    mid = n // 2
    if n % 2:
        return vals[mid]
    return 0.5 * (vals[mid - 1] + vals[mid])


def mad(values: List[float], med: float | None) -> float | None:
    if med is None or not values:
        return None
    deviations = [abs(v - med) for v in values]
    return median(deviations)


def robust_z(value: float | None, med: float | None, mad_val: float | None) -> float | None:
    if value is None or med is None or mad_val is None or mad_val == 0:
        return None
    return (value - med) / (1.4826 * mad_val)


def parse_time(value: str) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(timezone.utc)
    except Exception:
        return None


def load_rows(path: Path) -> List[Dict[str, str]]:
    rows: List[Dict[str, str]] = []
    with path.open(newline="") as handle:
        reader = csv.reader(handle)
        for raw in reader:
            if len(raw) < len(FIELDS):
                continue
            row = {FIELDS[i]: raw[i].strip().strip('"') for i in range(len(FIELDS))}
            rows.append(row)
    return rows


def build_group_baselines(rows: Iterable[Dict[str, str]]) -> Dict[Tuple[str, str, str], Baseline]:
    acc: Dict[Tuple[str, str, str], Dict[str, List[float]]] = defaultdict(
        lambda: {"snr": [], "drift": []}
    )
    for row in rows:
        key = (row["tx_sign"], row["rx_sign"], row["band"])
        snr = to_float(row["snr"])
        drift = to_float(row["drift"])
        if snr is not None:
            acc[key]["snr"].append(snr)
        if drift is not None:
            acc[key]["drift"].append(drift)

    baselines: Dict[Tuple[str, str, str], Baseline] = {}
    for key, vals in acc.items():
        snr_med = median(vals["snr"])
        drift_med = median(vals["drift"])
        baselines[key] = Baseline(
            count=max(len(vals["snr"]), len(vals["drift"])),
            snr_med=snr_med,
            snr_mad=mad(vals["snr"], snr_med),
            drift_med=drift_med,
            drift_mad=mad(vals["drift"], drift_med),
        )
    return baselines


def build_band_baselines(rows: Iterable[Dict[str, str]]) -> Dict[str, Baseline]:
    acc: Dict[str, Dict[str, List[float]]] = defaultdict(
        lambda: {"snr": [], "drift": []}
    )
    for row in rows:
        band = row["band"]
        snr = to_float(row["snr"])
        drift = to_float(row["drift"])
        if snr is not None:
            acc[band]["snr"].append(snr)
        if drift is not None:
            acc[band]["drift"].append(drift)

    baselines: Dict[str, Baseline] = {}
    for band, vals in acc.items():
        snr_med = median(vals["snr"])
        drift_med = median(vals["drift"])
        baselines[band] = Baseline(
            count=max(len(vals["snr"]), len(vals["drift"])),
            snr_med=snr_med,
            snr_mad=mad(vals["snr"], snr_med),
            drift_med=drift_med,
            drift_mad=mad(vals["drift"], drift_med),
        )
    return baselines


def pick_baseline(
    key: Tuple[str, str, str],
    group_baselines: Dict[Tuple[str, str, str], Baseline],
    band_baselines: Dict[str, Baseline],
    min_group_count: int,
) -> Baseline | None:
    group = group_baselines.get(key)
    if group and group.count >= min_group_count:
        return group
    band = band_baselines.get(key[2])
    return band


def bto_to_slant_range_km(bto_us: float) -> float:
    return (bto_us * 1e-6 * C_KM_S) / 2.0


def slant_range_to_ground_km(slant_km: float, sat_alt_km: float, earth_radius_km: float) -> float:
    rs = earth_radius_km + sat_alt_km
    re = earth_radius_km
    cos_theta = (rs * rs + re * re - slant_km * slant_km) / (2 * rs * re)
    clamped = max(-1.0, min(1.0, cos_theta))
    return re * math.acos(clamped)


def haversine_km(lat1: float, lon1: float, lat2: float, lon2: float, radius_km: float) -> float:
    dlat = to_rad(lat2 - lat1)
    dlon = to_rad(lon2 - lon1)
    a = (
        math.sin(dlat / 2) ** 2
        + math.cos(to_rad(lat1)) * math.cos(to_rad(lat2)) * math.sin(dlon / 2) ** 2
    )
    return 2 * radius_km * math.asin(min(1.0, math.sqrt(a)))


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


def load_arcs(arcs_path: Path) -> List[Dict[str, float]]:
    data = json.loads(arcs_path.read_text())
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


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--in", dest="in_path", default="full_wspr_handshake_window.csv")
    parser.add_argument("--out", default="Study_Case/wspr_richard_filtered.csv")
    parser.add_argument("--arcs", default="arcs.json")
    parser.add_argument("--snr-z", type=float, default=1.0)
    parser.add_argument("--drift-z", type=float, default=1.0)
    parser.add_argument("--min-group-count", type=int, default=5)
    parser.add_argument("--arc-distance-km", type=float, default=250.0)
    parser.add_argument("--arc-window-min", type=int, default=20)
    parser.add_argument("--start", default=None)
    parser.add_argument("--end", default=None)
    parser.add_argument("--steps", type=int, default=96)
    args = parser.parse_args()

    rows = load_rows(ROOT / args.in_path)
    if not rows:
        raise SystemExit("No rows loaded.")

    group_baselines = build_group_baselines(rows)
    band_baselines = build_band_baselines(rows)
    arcs = load_arcs(ROOT / args.arcs)

    start = parse_time(args.start) if args.start else None
    end = parse_time(args.end) if args.end else None
    window = timedelta(minutes=args.arc_window_min)

    output_rows: List[Dict[str, str | float]] = []
    for row in rows:
        row_time = parse_time(row["time"].replace(" ", "T") + "Z")
        if not row_time:
            continue
        if start and row_time < start:
            continue
        if end and row_time > end:
            continue
        if row_time.second != 0 or row_time.minute % 2 != 0:
            continue

        key = (row["tx_sign"], row["rx_sign"], row["band"])
        base = pick_baseline(key, group_baselines, band_baselines, args.min_group_count)
        if base is None:
            continue

        snr = to_float(row["snr"])
        drift = to_float(row["drift"])
        snr_z = robust_z(snr, base.snr_med, base.snr_mad)
        drift_z = robust_z(drift, base.drift_med, base.drift_mad)
        if snr_z is None and drift_z is None:
            continue
        if (snr_z is None or abs(snr_z) < args.snr_z) and (
            drift_z is None or abs(drift_z) < args.drift_z
        ):
            continue

        tx_lat = to_float(row["tx_lat"])
        tx_lon = to_float(row["tx_lon"])
        rx_lat = to_float(row["rx_lat"])
        rx_lon = to_float(row["rx_lon"])
        if tx_lat is None or tx_lon is None or rx_lat is None or rx_lon is None:
            continue

        curve = great_circle_points((tx_lat, tx_lon), (rx_lat, rx_lon), args.steps, use_long=False)
        curve_long = great_circle_points((tx_lat, tx_lon), (rx_lat, rx_lon), args.steps, use_long=True)

        passes_arc = False
        matched_arc = ""
        for arc in arcs:
            if not arc["time"]:
                continue
            if abs(row_time - arc["time"]) > window:
                continue
            min_dist = min_distance_curve_to_arc(curve, arc)
            min_dist_long = min_distance_curve_to_arc(curve_long, arc)
            if min(min_dist, min_dist_long) <= args.arc_distance_km:
                passes_arc = True
                matched_arc = arc["id"]
                break
        if not passes_arc:
            continue

        out_row = dict(row)
        out_row.update(
            {
                "snr_z": f"{snr_z:.3f}" if snr_z is not None else "",
                "drift_z": f"{drift_z:.3f}" if drift_z is not None else "",
                "arc_id": matched_arc,
            }
        )
        output_rows.append(out_row)

    out_path = ROOT / args.out
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_fields = FIELDS + ["snr_z", "drift_z", "arc_id"]
    with out_path.open("w", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=out_fields)
        writer.writeheader()
        writer.writerows(output_rows)

    print(f"Wrote {len(output_rows)} rows -> {out_path}")


if __name__ == "__main__":
    main()
