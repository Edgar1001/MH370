#!/usr/bin/env python3
"""
Detect anomalous WSPR links from a raw CSV (no header) using robust stats.

Baseline is computed per (tx_sign, rx_sign, band). When a group is too small
or has zero MAD, it falls back to per-band baselines.
"""

from __future__ import annotations

import argparse
import csv
import math
from collections import defaultdict
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, Iterable, List, Tuple

# Raw WSPR column order used in this repo
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


@dataclass
class Baseline:
    count: int
    snr_med: float | None
    snr_mad: float | None
    freq_med: float | None
    freq_mad: float | None
    drift_med: float | None
    drift_mad: float | None


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
    # 1.4826 scales MAD to sigma for normal data
    return (value - med) / (1.4826 * mad_val)


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
        lambda: {"snr": [], "frequency": [], "drift": []}
    )

    for row in rows:
        key = (row["tx_sign"], row["rx_sign"], row["band"])
        snr = to_float(row["snr"])
        freq = to_float(row["frequency"])
        drift = to_float(row["drift"])
        if snr is not None:
            acc[key]["snr"].append(snr)
        if freq is not None:
            acc[key]["frequency"].append(freq)
        if drift is not None:
            acc[key]["drift"].append(drift)

    baselines: Dict[Tuple[str, str, str], Baseline] = {}
    for key, vals in acc.items():
        snr_med = median(vals["snr"])
        freq_med = median(vals["frequency"])
        drift_med = median(vals["drift"])
        baselines[key] = Baseline(
            count=max(len(vals["snr"]), len(vals["frequency"]), len(vals["drift"])),
            snr_med=snr_med,
            snr_mad=mad(vals["snr"], snr_med),
            freq_med=freq_med,
            freq_mad=mad(vals["frequency"], freq_med),
            drift_med=drift_med,
            drift_mad=mad(vals["drift"], drift_med),
        )
    return baselines


def build_band_baselines(rows: Iterable[Dict[str, str]]) -> Dict[str, Baseline]:
    acc: Dict[str, Dict[str, List[float]]] = defaultdict(
        lambda: {"snr": [], "frequency": [], "drift": []}
    )
    for row in rows:
        band = row["band"]
        snr = to_float(row["snr"])
        freq = to_float(row["frequency"])
        drift = to_float(row["drift"])
        if snr is not None:
            acc[band]["snr"].append(snr)
        if freq is not None:
            acc[band]["frequency"].append(freq)
        if drift is not None:
            acc[band]["drift"].append(drift)

    baselines: Dict[str, Baseline] = {}
    for band, vals in acc.items():
        snr_med = median(vals["snr"])
        freq_med = median(vals["frequency"])
        drift_med = median(vals["drift"])
        baselines[band] = Baseline(
            count=max(len(vals["snr"]), len(vals["frequency"]), len(vals["drift"])),
            snr_med=snr_med,
            snr_mad=mad(vals["snr"], snr_med),
            freq_med=freq_med,
            freq_mad=mad(vals["frequency"], freq_med),
            drift_med=drift_med,
            drift_mad=mad(vals["drift"], drift_med),
        )
    return baselines


def build_counts(rows: Iterable[Dict[str, str]]) -> Tuple[Dict[Tuple[str, str, str], int], Dict[str, int]]:
    group_counts: Dict[Tuple[str, str, str], int] = defaultdict(int)
    tx_counts: Dict[str, int] = defaultdict(int)
    for row in rows:
        key = (row["tx_sign"], row["rx_sign"], row["band"])
        group_counts[key] += 1
        tx_counts[row["tx_sign"]] += 1
    return group_counts, tx_counts


def pick_baseline(
    key: Tuple[str, str, str],
    group_baselines: Dict[Tuple[str, str, str], Baseline],
    band_baselines: Dict[str, Baseline],
    min_group_count: int,
) -> Tuple[Baseline | None, str]:
    group = group_baselines.get(key)
    if group and group.count >= min_group_count:
        return group, "group"
    band = band_baselines.get(key[2])
    if band:
        return band, "band"
    return None, "none"


def main() -> None:
    parser = argparse.ArgumentParser(description="Detect anomalous WSPR links using robust z-scores.")
    parser.add_argument(
        "--in",
        dest="in_path",
        default="full_wspr_handshake_window.csv",
        help="Input raw WSPR CSV (no header).",
    )
    parser.add_argument(
        "--out-anomalies",
        default="wspr_anomalies.csv",
        help="Output anomalies CSV.",
    )
    parser.add_argument(
        "--out-baselines",
        default="wspr_baselines_tx_rx_band.csv",
        help="Output baselines CSV (per tx/rx/band).",
    )
    parser.add_argument(
        "--z-threshold",
        type=float,
        default=3.5,
        help="Robust z-score threshold for anomaly flagging.",
    )
    parser.add_argument(
        "--min-group-count",
        type=int,
        default=5,
        help="Minimum samples to use per-link baseline; otherwise per-band fallback.",
    )
    parser.add_argument(
        "--include-rare",
        action="store_true",
        help="Include rare tx or tx/rx/band singletons even when no robust z-score is available.",
    )
    parser.add_argument(
        "--rare-group-max-count",
        type=int,
        default=1,
        help="Max count for (tx,rx,band) group to be considered rare when --include-rare is set.",
    )
    parser.add_argument(
        "--rare-tx-max-count",
        type=int,
        default=1,
        help="Max count for tx_sign to be considered rare when --include-rare is set.",
    )
    args = parser.parse_args()

    in_path = Path(args.in_path)
    rows = load_rows(in_path)
    if not rows:
        raise SystemExit(f"No rows loaded from {in_path}")

    group_baselines = build_group_baselines(rows)
    band_baselines = build_band_baselines(rows)
    group_counts, tx_counts = build_counts(rows)

    # Write baselines (group level) for inspection/reuse
    baseline_fields = [
        "tx_sign",
        "rx_sign",
        "band",
        "count",
        "snr_med",
        "snr_mad",
        "freq_med",
        "freq_mad",
        "drift_med",
        "drift_mad",
    ]
    with Path(args.out_baselines).open("w", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=baseline_fields)
        writer.writeheader()
        for (tx, rx, band), base in sorted(group_baselines.items()):
            writer.writerow(
                {
                    "tx_sign": tx,
                    "rx_sign": rx,
                    "band": band,
                    "count": base.count,
                    "snr_med": base.snr_med,
                    "snr_mad": base.snr_mad,
                    "freq_med": base.freq_med,
                    "freq_mad": base.freq_mad,
                    "drift_med": base.drift_med,
                    "drift_mad": base.drift_mad,
                }
            )

    anomaly_fields = FIELDS + [
        "baseline_level",
        "snr_med",
        "snr_mad",
        "snr_z",
        "freq_med",
        "freq_mad",
        "freq_z",
        "drift_med",
        "drift_mad",
        "drift_z",
        "anomaly_score",
        "anomaly_reason",
    ]

    anomalies: List[Dict[str, str | float]] = []
    threshold = float(args.z_threshold)

    for row in rows:
        key = (row["tx_sign"], row["rx_sign"], row["band"])
        group_count = group_counts.get(key, 0)
        tx_count = tx_counts.get(row["tx_sign"], 0)
        base, level = pick_baseline(key, group_baselines, band_baselines, args.min_group_count)
        if base is None:
            if not args.include_rare:
                continue
            if group_count > args.rare_group_max_count and tx_count > args.rare_tx_max_count:
                continue

        snr = to_float(row["snr"])
        freq = to_float(row["frequency"])
        drift = to_float(row["drift"])

        if base is None:
            snr_z = None
            freq_z = None
            drift_z = None
            snr_med = None
            snr_mad = None
            freq_med = None
            freq_mad = None
            drift_med = None
            drift_mad = None
        else:
            snr_med = base.snr_med
            snr_mad = base.snr_mad
            freq_med = base.freq_med
            freq_mad = base.freq_mad
            drift_med = base.drift_med
            drift_mad = base.drift_mad
            snr_z = robust_z(snr, snr_med, snr_mad)
            freq_z = robust_z(freq, freq_med, freq_mad)
            drift_z = robust_z(drift, drift_med, drift_mad)

        z_vals = [abs(z) for z in (snr_z, freq_z, drift_z) if z is not None]
        score = max(z_vals) if z_vals else None
        if score is not None and score < threshold:
            score = None

        reasons = []
        if snr_z is not None and abs(snr_z) >= threshold:
            reasons.append("snr")
        if freq_z is not None and abs(freq_z) >= threshold:
            reasons.append("frequency")
        if drift_z is not None and abs(drift_z) >= threshold:
            reasons.append("drift")
        if not reasons and args.include_rare:
            if group_count <= args.rare_group_max_count:
                reasons.append("rare_group")
            if tx_count <= args.rare_tx_max_count:
                reasons.append("rare_tx")
        if not reasons:
            continue

        out_row: Dict[str, str | float] = {k: row[k] for k in FIELDS}
        out_row.update(
            {
                "baseline_level": level if base is not None else "none",
                "snr_med": snr_med,
                "snr_mad": snr_mad,
                "snr_z": snr_z,
                "freq_med": freq_med,
                "freq_mad": freq_mad,
                "freq_z": freq_z,
                "drift_med": drift_med,
                "drift_mad": drift_mad,
                "drift_z": drift_z,
                "anomaly_score": score,
                "anomaly_reason": "+".join(reasons) if reasons else "score",
            }
        )
        anomalies.append(out_row)

    anomalies.sort(key=lambda r: (str(r["time"]), str(r["tx_sign"]), str(r["rx_sign"])))

    with Path(args.out_anomalies).open("w", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=anomaly_fields)
        writer.writeheader()
        writer.writerows(anomalies)

    print(
        f"Loaded {len(rows)} rows | baselines {len(group_baselines)} | anomalies {len(anomalies)}"
    )
    print(
        f"Outputs: {args.out_baselines} and {args.out_anomalies} | z-threshold={threshold}"
    )


if __name__ == "__main__":
    main()
