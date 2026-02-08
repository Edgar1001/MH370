#!/usr/bin/env python3
import argparse
import csv
import sys
import math
import urllib.parse
import urllib.request

def parse_args():
    parser = argparse.ArgumentParser(
        description="Download WSPR CSV and filter by lat/lon bounding box."
    )
    parser.add_argument(
        "--url",
        help="WSPR CSV query URL (FORMAT CSV). If omitted, SQL is built from args."
    )
    parser.add_argument(
        "--in",
        dest="in_path",
        help="Path to an existing CSV (skips download when provided)."
    )
    parser.add_argument(
        "--start",
        default="2014-03-08 18:25:00",
        help="UTC start time (YYYY-MM-DD HH:MM:SS)"
    )
    parser.add_argument(
        "--end",
        default="2014-03-09 00:19:59",
        help="UTC end time (YYYY-MM-DD HH:MM:SS)"
    )
    parser.add_argument(
        "--bands",
        default="",
        help="Comma-separated band list (e.g. 7,10,14). Empty means all bands."
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=0,
        help="Optional LIMIT value (0 means no limit)."
    )
    parser.add_argument(
        "--out-raw",
        default="wspr_raw.csv",
        help="Path for raw CSV output"
    )
    parser.add_argument(
        "--out-filtered",
        default="wspr_filtered.csv",
        help="Path for filtered CSV output"
    )
    parser.add_argument("--lat-min", type=float, required=True)
    parser.add_argument("--lat-max", type=float, required=True)
    parser.add_argument("--lon-min", type=float, required=True)
    parser.add_argument("--lon-max", type=float, required=True)
    parser.add_argument(
        "--endpoint",
        choices=["tx", "rx", "either", "both"],
        default="either",
        help="Which endpoints must fall inside the bbox"
    )
    parser.add_argument(
        "--min-distance-km",
        type=float,
        default=0,
        help="Minimum tx-rx distance in km."
    )
    parser.add_argument(
        "--path-through-bbox",
        action="store_true",
        help="Include a row if the great-circle path crosses the bbox."
    )
    parser.add_argument(
        "--path-steps",
        type=int,
        default=96,
        help="Interpolation steps for path-through-bbox checks."
    )
    parser.add_argument(
        "--ionospheric-only",
        action="store_true",
        help="Keep only links that meet the ionospheric rules."
    )
    return parser.parse_args()

def is_ionospheric_link(band_mhz, distance_km):
    if band_mhz is None or distance_km is None:
        return False
    if distance_km <= 0:
        return False
    if band_mhz <= 30:
        return distance_km >= 200
    if 45 <= band_mhz <= 55:
        return 500 <= distance_km <= 2200
    if 140 <= band_mhz <= 148:
        return False
    return False


def in_bbox(lat, lon, lat_min, lat_max, lon_min, lon_max):
    return lat_min <= lat <= lat_max and lon_min <= lon <= lon_max


def row_in_bbox(row, args):
    try:
        tx_lat = float(row.get("tx_lat", ""))
        tx_lon = float(row.get("tx_lon", ""))
        rx_lat = float(row.get("rx_lat", ""))
        rx_lon = float(row.get("rx_lon", ""))
        distance_km = float(row.get("distance", "0") or 0)
        band_mhz = float(row.get("band", ""))
    except ValueError:
        return False

    if distance_km < args.min_distance_km:
        return False

    if args.ionospheric_only and not is_ionospheric_link(band_mhz, distance_km):
        return False

    tx_ok = in_bbox(tx_lat, tx_lon, args.lat_min, args.lat_max, args.lon_min, args.lon_max)
    rx_ok = in_bbox(rx_lat, rx_lon, args.lat_min, args.lat_max, args.lon_min, args.lon_max)

    if args.path_through_bbox and great_circle_hits_bbox(
        (tx_lat, tx_lon),
        (rx_lat, rx_lon),
        args.lat_min,
        args.lat_max,
        args.lon_min,
        args.lon_max,
        args.path_steps
    ):
        return True

    if args.endpoint == "tx":
        return tx_ok
    if args.endpoint == "rx":
        return rx_ok
    if args.endpoint == "both":
        return tx_ok and rx_ok
    return tx_ok or rx_ok


def download_csv(url):
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=60) as resp:
        return resp.read().decode("utf-8", "replace")

def great_circle_hits_bbox(start, end, lat_min, lat_max, lon_min, lon_max, steps):
    lat1 = math.radians(start[0])
    lon1 = math.radians(start[1])
    lat2 = math.radians(end[0])
    lon2 = math.radians(end[1])

    sin_lat1 = math.sin(lat1)
    cos_lat1 = math.cos(lat1)
    sin_lat2 = math.sin(lat2)
    cos_lat2 = math.cos(lat2)

    delta = math.acos(
        max(-1.0, min(1.0, sin_lat1 * sin_lat2 + cos_lat1 * cos_lat2 * math.cos(lon2 - lon1)))
    )
    if delta == 0:
        return in_bbox(start[0], start[1], lat_min, lat_max, lon_min, lon_max)

    sin_delta = math.sin(delta)
    for i in range(steps + 1):
        t = i / steps
        a = math.sin((1 - t) * delta) / sin_delta
        b = math.sin(t * delta) / sin_delta

        x = a * cos_lat1 * math.cos(lon1) + b * cos_lat2 * math.cos(lon2)
        y = a * cos_lat1 * math.sin(lon1) + b * cos_lat2 * math.sin(lon2)
        z = a * sin_lat1 + b * sin_lat2

        lat = math.degrees(math.atan2(z, math.sqrt(x * x + y * y)))
        lon = math.degrees(math.atan2(y, x))
        lon = ((lon + 540) % 360) - 180

        if in_bbox(lat, lon, lat_min, lat_max, lon_min, lon_max):
            return True
    return False

def build_query_url(args):
    base = "https://db1.wspr.live/?query="
    fields = (
        "time,band,tx_sign,tx_lat,tx_lon,rx_sign,rx_lat,rx_lon,"
        "frequency,snr,drift,power,distance"
    )
    where = [
        f"time >= toDateTime('{args.start}')",
        f"time <= toDateTime('{args.end}')"
    ]
    if args.bands.strip():
        bands = ",".join([b.strip() for b in args.bands.split(",") if b.strip()])
        where.append(f"band IN ({bands})")
    sql = (
        f"SELECT {fields} FROM wspr.rx "
        f"WHERE {' AND '.join(where)} "
        f"ORDER BY time ASC"
    )
    if args.limit and args.limit > 0:
        sql += f" LIMIT {args.limit}"
    sql += " FORMAT CSV"
    return base + urllib.parse.quote(sql, safe="")


def main():
    args = parse_args()

    if args.in_path:
        try:
            with open(args.in_path, "r", encoding="utf-8") as handle:
                raw_csv = handle.read()
        except Exception as exc:
            print(f"Failed to read input CSV: {exc}", file=sys.stderr)
            sys.exit(1)
    else:
        try:
            url = args.url or build_query_url(args)
            raw_csv = download_csv(url)
        except Exception as exc:
            print(f"Failed to download CSV: {exc}", file=sys.stderr)
            sys.exit(1)

    with open(args.out_raw, "w", newline="", encoding="utf-8") as out_raw:
        out_raw.write(raw_csv)

    rows = list(csv.reader(raw_csv.splitlines()))
    if not rows:
        print("No CSV rows found.", file=sys.stderr)
        sys.exit(1)

    default_fields = [
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
        "distance"
    ]
    header_row = rows[0]
    if "time" in header_row or "band" in header_row:
        fieldnames = header_row
        data_rows = rows[1:]
    else:
        fieldnames = default_fields
        data_rows = rows

    with open(args.out_filtered, "w", newline="", encoding="utf-8") as out_filtered:
        writer = csv.DictWriter(out_filtered, fieldnames=fieldnames)
        writer.writeheader()
        kept = 0
        for values in data_rows:
            row = dict(zip(fieldnames, values))
            if row_in_bbox(row, args):
                writer.writerow(row)
                kept += 1

    print(f"Wrote raw CSV to {args.out_raw}")
    print(f"Wrote filtered CSV to {args.out_filtered} ({kept} rows)")


if __name__ == "__main__":
    main()
