#!/usr/bin/env python3
"""Verify anomaly columns against Loss Algo baseline in WSPR CSV."""

import csv
import math
import sys

PATH = "Study_Case/wsprspots-2014-03-07-1600-2014-03-08-0100.csv"


def main() -> int:
    vals = []
    rows = []
    with open(PATH, newline="") as f:
        reader = csv.DictReader(f)
        for row in reader:
            v = float(row["Loss Algo"])
            vals.append(v)
            rows.append(row)

    if not vals:
        print("No rows found")
        return 1

    mean = sum(vals) / len(vals)
    sd = math.sqrt(sum((v - mean) ** 2 for v in vals) / len(vals))

    def flag(v: float, k: float) -> bool:
        return abs(v - mean) >= k * sd - 1e-12

    mismatches = {k: 0 for k in [
        "SNR 1.0 SD Anom+",
        "SNR 1.0 SD Anom-",
        "SNR 1.0 SD Anom",
        "SNR 0.5 SD Anom+",
        "SNR 0.5 SD Anom-",
        "SNR 0.5 SD Anom",
        "SNR 0.25 SD Anom+",
        "SNR 0.25 SD Anom-",
        "SNR 0.25 SD Anom",
        "Drift Anom",
        "Dual Anom",
    ]}

    for row in rows:
        v = float(row["Loss Algo"])
        drift_anom = float(row["Drift"]) != 0.0

        expected = {
            "SNR 1.0 SD Anom+": (v - mean) >= 1.0 * sd,
            "SNR 1.0 SD Anom-": (v - mean) <= -1.0 * sd,
            "SNR 1.0 SD Anom": flag(v, 1.0),
            "SNR 0.5 SD Anom+": (v - mean) >= 0.5 * sd,
            "SNR 0.5 SD Anom-": (v - mean) <= -0.5 * sd,
            "SNR 0.5 SD Anom": flag(v, 0.5),
            "SNR 0.25 SD Anom+": (v - mean) >= 0.25 * sd,
            "SNR 0.25 SD Anom-": (v - mean) <= -0.25 * sd,
            "SNR 0.25 SD Anom": flag(v, 0.25),
            "Drift Anom": drift_anom,
            "Dual Anom": drift_anom and flag(v, 0.25),
        }

        for key, exp in expected.items():
            actual = row[key].strip() == "1"
            if actual != exp:
                mismatches[key] += 1

    print(f"Rows: {len(rows)}")
    print(f"Mean Loss Algo: {mean}")
    print(f"SD Loss Algo: {sd}")
    for key in mismatches:
        print(f"{key}: {mismatches[key]} mismatches")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
