const fs = require('fs');

const INPUT = 'wspr_raw.csv';
const GRID_DEG = 1; // 1-degree grid
const CANDIDATE_COUNT = 50;
const C_KM_S = 299792.458;
const FLIGHT_PATHS_FILE = 'arcgis_flight_paths.geojson';

const CONSTRAINTS = {
  lonMin: 60,
  lonMax: 115,
  latMin: -45,
  latMax: 15,
  arcBandKm: 300,
  corridorKm: 300
};

const ARC_IDS = new Set(['ping-224121', 'ping-001059', 'ping-001929']);

const toRad = (deg) => (deg * Math.PI) / 180;
const toDeg = (rad) => (rad * 180) / Math.PI;
const EARTH_KM = 6371.0088;

const readJson = (filePath) => JSON.parse(fs.readFileSync(filePath, 'utf8'));

const haversineKm = (lat1, lon1, lat2, lon2) => {
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) *
      Math.cos(toRad(lat2)) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  return 2 * EARTH_KM * Math.asin(Math.min(1, Math.sqrt(a)));
};

const slantRangeToGroundKm = (slantKm, satAltKm) => {
  const rs = EARTH_KM + satAltKm;
  const re = EARTH_KM;
  const cosTheta = (rs * rs + re * re - slantKm * slantKm) / (2 * rs * re);
  const clamped = Math.min(1, Math.max(-1, cosTheta));
  return re * Math.acos(clamped);
};

const pointToSegmentKm = (point, a, b) => {
  const latRef = toRad((point[0] + a[0] + b[0]) / 3);
  const kmPerDegLat = 111.132;
  const kmPerDegLon = 111.320 * Math.cos(latRef);
  const ax = (a[1] - point[1]) * kmPerDegLon;
  const ay = (a[0] - point[0]) * kmPerDegLat;
  const bx = (b[1] - point[1]) * kmPerDegLon;
  const by = (b[0] - point[0]) * kmPerDegLat;
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (!len2) {
    return Math.sqrt(ax * ax + ay * ay);
  }
  let t = -(ax * dx + ay * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  return Math.sqrt(cx * cx + cy * cy);
};

const pointToLineKm = (point, line) => {
  if (!line || line.length < 2) {
    return Infinity;
  }
  let best = Infinity;
  for (let i = 1; i < line.length; i += 1) {
    const dist = pointToSegmentKm(point, line[i - 1], line[i]);
    if (dist < best) {
      best = dist;
    }
  }
  return best;
};

const pointNearLines = (point, lines, maxKm) => {
  if (!lines || !lines.length) {
    return true;
  }
  for (const line of lines) {
    if (pointToLineKm(point, line) <= maxKm) {
      return true;
    }
  }
  return false;
};

const parseCsvRow = (line) => {
  const parts = line.split(',').map((value) => value.trim());
  return parts.map((value) => value.replace(/^"|"$/g, ''));
};

const greatCirclePointAtFraction = (start, end, fraction) => {
  const lat1 = toRad(start[0]);
  const lon1 = toRad(start[1]);
  const lat2 = toRad(end[0]);
  const lon2 = toRad(end[1]);
  const sinLat1 = Math.sin(lat1);
  const cosLat1 = Math.cos(lat1);
  const sinLat2 = Math.sin(lat2);
  const cosLat2 = Math.cos(lat2);
  const delta = Math.acos(
    Math.min(
      1,
      Math.max(-1, sinLat1 * sinLat2 + cosLat1 * cosLat2 * Math.cos(lon2 - lon1))
    )
  );

  if (!Number.isFinite(delta) || delta === 0) {
    return [start[0], start[1]];
  }

  const sinDelta = Math.sin(delta);
  const a = Math.sin((1 - fraction) * delta) / sinDelta;
  const b = Math.sin(fraction * delta) / sinDelta;

  const x = a * cosLat1 * Math.cos(lon1) + b * cosLat2 * Math.cos(lon2);
  const y = a * cosLat1 * Math.sin(lon1) + b * cosLat2 * Math.sin(lon2);
  const z = a * sinLat1 + b * sinLat2;

  const lat = Math.atan2(z, Math.sqrt(x * x + y * y));
  const lon = Math.atan2(y, x);
  return [toDeg(lat), ((toDeg(lon) + 540) % 360) - 180];
};

const median = (values) => {
  if (!values.length) {
    return null;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

const lines = fs.readFileSync(INPUT, 'utf8')
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter((line) => line && !line.startsWith('#'));

if (!lines.length) {
  console.error('No WSPR rows found.');
  process.exit(1);
}

const header = parseCsvRow(lines[0]);
const hasHeader = header.includes('tx_lat') || header.includes('rx_lat');
const fields = hasHeader
  ? header
  : [
      'time',
      'band',
      'tx_sign',
      'tx_lat',
      'tx_lon',
      'rx_sign',
      'rx_lat',
      'rx_lon',
      'frequency',
      'snr',
      'drift',
      'power',
      'distance'
    ];
const startIndex = hasHeader ? 1 : 0;

const rows = [];
const snrByBand = new Map();

for (let i = startIndex; i < lines.length; i += 1) {
  const values = parseCsvRow(lines[i]);
  if (values.length < fields.length) {
    continue;
  }
  const row = {};
  fields.forEach((field, idx) => {
    row[field] = values[idx];
  });

  const txLat = Number(row.tx_lat);
  const txLon = Number(row.tx_lon);
  const rxLat = Number(row.rx_lat);
  const rxLon = Number(row.rx_lon);
  const snr = Number(row.snr);
  if (!Number.isFinite(txLat) || !Number.isFinite(txLon) || !Number.isFinite(rxLat) || !Number.isFinite(rxLon)) {
    continue;
  }
  if (!Number.isFinite(snr)) {
    continue;
  }

  rows.push({
    txLat,
    txLon,
    rxLat,
    rxLon,
    band: row.band,
    snr,
    distance: Number(row.distance)
  });

  const bandKey = row.band || 'unknown';
  if (!snrByBand.has(bandKey)) {
    snrByBand.set(bandKey, []);
  }
  snrByBand.get(bandKey).push(snr);
}

const bandMedians = new Map();
for (const [band, values] of snrByBand.entries()) {
  bandMedians.set(band, median(values));
}

const arcsData = readJson('arcs.json');
const satAltKm = Number(arcsData && arcsData.meta && arcsData.meta.sat_alt_km);
const btoBiasUs = Number(arcsData && arcsData.meta && arcsData.meta.bto_bias_us) || 0;
const groundRangeScale = Number(arcsData && arcsData.meta && arcsData.meta.ground_range_scale);
const groundRangeOffsetKm = Number(arcsData && arcsData.meta && arcsData.meta.ground_range_offset_km) || 0;
const rangeScale = Number(arcsData && arcsData.meta && arcsData.meta.range_scale) || 1;
const arcCenters = [];

if (Number.isFinite(satAltKm)) {
  (arcsData.arcs || [])
    .filter((arc) => ARC_IDS.has(arc.id))
    .forEach((arc) => {
      const center = arc.center_override || arc.center;
      if (!center) {
        return;
      }
      const bto = Number(arc.bto_us);
      if (!Number.isFinite(bto)) {
        return;
      }
      const slantKm = ((bto + btoBiasUs) * 1e-6 * C_KM_S) / 2;
      const groundKm = slantRangeToGroundKm(slantKm * rangeScale, satAltKm);
      const scaledKm = (Number.isFinite(groundRangeScale) ? groundKm * groundRangeScale : groundKm) + groundRangeOffsetKm;
      arcCenters.push({ lat: center.lat, lon: center.lon, radiusKm: scaledKm });
    });
}

const flightData = readJson(FLIGHT_PATHS_FILE);
const flightLines = [];
(flightData.features || []).forEach((feature) => {
  const geom = feature && feature.geometry;
  if (!geom || !geom.coordinates) {
    return;
  }
  if (geom.type === 'LineString') {
    flightLines.push(geom.coordinates.map((pt) => [pt[1], pt[0]]));
  } else if (geom.type === 'MultiLineString') {
    geom.coordinates.forEach((line) => {
      flightLines.push(line.map((pt) => [pt[1], pt[0]]));
    });
  }
});

const grid = new Map();

const addToGrid = (lat, lon, weight) => {
  if (lon < CONSTRAINTS.lonMin || lon > CONSTRAINTS.lonMax) {
    return;
  }
  if (lat < CONSTRAINTS.latMin || lat > CONSTRAINTS.latMax) {
    return;
  }
  if (arcCenters.length) {
    const minArcKm = arcCenters.reduce((best, center) => {
      const dist = haversineKm(lat, lon, center.lat, center.lon);
      return Math.min(best, Math.abs(dist - center.radiusKm));
    }, Infinity);
    if (minArcKm > CONSTRAINTS.arcBandKm) {
      return;
    }
  }
  if (!pointNearLines([lat, lon], flightLines, CONSTRAINTS.corridorKm)) {
    return;
  }
  const latIdx = Math.floor((lat + 90) / GRID_DEG);
  const lonIdx = Math.floor((lon + 180) / GRID_DEG);
  const key = `${latIdx},${lonIdx}`;
  const entry = grid.get(key) || { latSum: 0, lonSum: 0, weight: 0, count: 0 };
  entry.latSum += lat * weight;
  entry.lonSum += lon * weight;
  entry.weight += weight;
  entry.count += 1;
  grid.set(key, entry);
};

rows.forEach((row) => {
  const bandMedian = bandMedians.get(row.band || 'unknown');
  const deviation = bandMedian === null ? 0 : Math.abs(row.snr - bandMedian);
  const deviationWeight = 1 + Math.min(2, deviation / 10);
  const snrWeight = 1 + Math.max(0, -row.snr) / 15;
  const distanceKm = Number.isFinite(row.distance) && row.distance > 0 ? row.distance : null;
  const hopCount = distanceKm ? Math.max(1, Math.round(distanceKm / 2000)) : 1;
  const hopWeight = 1 / hopCount;
  const weight = snrWeight * deviationWeight * hopWeight;

  const start = [row.txLat, row.txLon];
  const end = [row.rxLat, row.rxLon];

  if (hopCount === 1) {
    const mid = greatCirclePointAtFraction(start, end, 0.5);
    addToGrid(mid[0], mid[1], weight);
    return;
  }

  for (let i = 1; i < hopCount; i += 1) {
    const fraction = i / hopCount;
    const point = greatCirclePointAtFraction(start, end, fraction);
    addToGrid(point[0], point[1], weight);
  }
});

const heatmapFeatures = [];
const candidateCells = [];

for (const entry of grid.values()) {
  const lat = entry.latSum / entry.weight;
  const lon = entry.lonSum / entry.weight;
  heatmapFeatures.push({
    type: 'Feature',
    geometry: {
      type: 'Point',
      coordinates: [lon, lat]
    },
    properties: {
      weight: Number(entry.weight.toFixed(4)),
      count: entry.count
    }
  });
  candidateCells.push({ lat, lon, weight: entry.weight, count: entry.count });
}

candidateCells.sort((a, b) => b.weight - a.weight);
const topCandidates = candidateCells.slice(0, CANDIDATE_COUNT);

const candidateFeatures = topCandidates.map((entry, idx) => ({
  type: 'Feature',
  geometry: {
    type: 'Point',
    coordinates: [entry.lon, entry.lat]
  },
  properties: {
    rank: idx + 1,
    weight: Number(entry.weight.toFixed(4)),
    count: entry.count
  }
}));

fs.writeFileSync(
  'wspr_heatmap.geojson',
  JSON.stringify({ type: 'FeatureCollection', features: heatmapFeatures })
);
fs.writeFileSync(
  'wspr_candidates.geojson',
  JSON.stringify({ type: 'FeatureCollection', features: candidateFeatures })
);

console.log(`Rows used: ${rows.length}`);
console.log(`Heatmap cells: ${heatmapFeatures.length}`);
console.log(`Candidates: ${candidateFeatures.length}`);
