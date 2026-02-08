const C_KM_S = 299792.458;
const EARTH_RADIUS_KM = 6371;
const WGS84_A_KM = 6378.137;
const WGS84_F = 1 / 298.257223563;
const WGS84_B_KM = WGS84_A_KM * (1 - WGS84_F);
const WGS84_AUTHALIC_RADIUS_KM = 6371.0088;
const FRESNEL_HALF_WIDTH_KM = 200;
const ANOMALY_ARC_TIME_WINDOW_MIN = 20;
const ANOMALY_ARC_DISTANCE_KM = 250;
const ANOMALY_CURVE_STEPS = 64;
const ARC_TIMES_UTC = {
  "ping-182527": "2014-03-07T18:25:27Z",
  "ping-194102": "2014-03-07T19:41:02Z",
  "ping-204104": "2014-03-07T20:41:04Z",
  "ping-214126": "2014-03-07T21:41:26Z",
  "ping-224121": "2014-03-07T22:41:21Z",
  "ping-001059": "2014-03-08T00:10:59Z",
  "ping-001929": "2014-03-08T00:19:29Z"
};

const palette = [
  "#d45d3f",
  "#357edd",
  "#f2a65a",
  "#6a994e",
  "#577590",
  "#c44536",
  "#3d5a80",
  "#1b998b"
];

const SAT_SUBPOINTS = [
  { time: "18:25", lat: 1.56, lon: 64.528, quality: "extrap" },
  { time: "19:41", lat: 1.64, lon: 64.514, quality: "plot" },
  { time: "20:41", lat: 1.58, lon: 64.504, quality: "plot" },
  { time: "21:41", lat: 1.41, lon: 64.494, quality: "plot" },
  { time: "22:41", lat: 1.14, lon: 64.482, quality: "plot" },
  { time: "00:11", lat: 0.58, lon: 64.466, quality: "interp" },
  { time: "00:19", lat: 0.53, lon: 64.464, quality: "plot" }
];

const normalizeTimeMinutes = (timeStr) => {
  if (!timeStr) {
    return null;
  }
  const match = timeStr.match(/(\d{2}):(\d{2})/);
  if (!match) {
    return null;
  }
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) {
    return null;
  }
  let total = hours * 60 + minutes;
  if (hours < 12) {
    total += 24 * 60;
  }
  return total;
};

const SAT_SUBPOINTS_MIN = SAT_SUBPOINTS.map((point) => ({
  ...point,
  minutes: normalizeTimeMinutes(point.time)
}))
  .filter((point) => Number.isFinite(point.minutes))
  .sort((a, b) => a.minutes - b.minutes);

const getSubpointForTime = (timeStr) => {
  const targetMinutes = normalizeTimeMinutes(timeStr);
  if (!Number.isFinite(targetMinutes) || !SAT_SUBPOINTS_MIN.length) {
    return null;
  }

  const exact = SAT_SUBPOINTS_MIN.find((point) => point.time === timeStr);
  if (exact) {
    return { lat: exact.lat, lon: exact.lon, quality: exact.quality };
  }

  if (targetMinutes <= SAT_SUBPOINTS_MIN[0].minutes) {
    const first = SAT_SUBPOINTS_MIN[0];
    return { lat: first.lat, lon: first.lon, quality: "extrap" };
  }

  const last = SAT_SUBPOINTS_MIN[SAT_SUBPOINTS_MIN.length - 1];
  if (targetMinutes >= last.minutes) {
    return { lat: last.lat, lon: last.lon, quality: "extrap" };
  }

  let prev = SAT_SUBPOINTS_MIN[0];
  let next = SAT_SUBPOINTS_MIN[1];
  for (let i = 1; i < SAT_SUBPOINTS_MIN.length; i += 1) {
    if (SAT_SUBPOINTS_MIN[i].minutes >= targetMinutes) {
      next = SAT_SUBPOINTS_MIN[i];
      prev = SAT_SUBPOINTS_MIN[i - 1];
      break;
    }
  }

  const span = next.minutes - prev.minutes;
  const t = span ? (targetMinutes - prev.minutes) / span : 0;
  const lat = prev.lat + (next.lat - prev.lat) * t;
  const lon = prev.lon + (next.lon - prev.lon) * t;
  return { lat, lon, quality: "interp" };
};

const formatBto = (arc) => `${arc.bto_us} us ${arc.channel}`;
const formatArcTime = (arc) => {
  const time = arc.time_utc || arc.time || "";
  return time ? `${time} UTC` : "—";
};

const formatArcTitle = (arc, idx) => {
  const time = arc.time_utc || arc.time || "";
  const hhmm = time ? time.slice(0, 5) : "—";
  return `Arc ${idx + 1} · ${hhmm}`;
};

const addArcItem = (arc, color, listEl, idx, onToggle) => {
  const item = document.createElement("div");
  item.className = "arc-item";

  const info = document.createElement("div");
  info.className = "arc-info";

  const title = document.createElement("div");
  title.className = "arc-time";
  title.textContent = formatArcTitle(arc, idx);

  const meta = document.createElement("div");
  meta.className = "arc-meta";
  const metaCore = `${formatArcTime(arc)} · ${formatBto(arc)}`;
  meta.textContent = arc.note ? `${metaCore} · ${arc.note}` : metaCore;

  info.appendChild(title);
  info.appendChild(meta);

  const toggle = document.createElement("label");
  toggle.className = "arc-toggle";

  const input = document.createElement("input");
  input.type = "checkbox";
  input.checked = true;

  const swatch = document.createElement("span");
  swatch.className = "arc-swatch";
  swatch.style.background = color;

  toggle.appendChild(swatch);
  toggle.appendChild(input);

  item.appendChild(info);
  item.appendChild(toggle);

  input.addEventListener("change", () => {
    onToggle(input.checked);
  });

  listEl.appendChild(item);
};

const canvas = document.getElementById("map");
const ctx = canvas.getContext("2d");
const mapWrap = canvas.parentElement;

const toRad = (deg) => (deg * Math.PI) / 180;
const toDeg = (rad) => (rad * 180) / Math.PI;

const btoToSlantRangeKm = (btoUs) => (btoUs * 1e-6 * C_KM_S) / 2;

const haversineDistanceKm = (lat1, lon1, lat2, lon2, radiusKm = EARTH_RADIUS_KM) => {
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) *
      Math.cos(toRad(lat2)) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  return 2 * radiusKm * Math.asin(Math.min(1, Math.sqrt(a)));
};

const parseUtcMs = (value) => {
  if (!value) {
    return null;
  }
  const iso = String(value).replace(" ", "T");
  const withZone = iso.endsWith("Z") ? iso : `${iso}Z`;
  const ms = Date.parse(withZone);
  return Number.isFinite(ms) ? ms : null;
};

const getArcUtcMs = (arc) => {
  if (!arc || !arc.id) {
    return null;
  }
  const mapped = ARC_TIMES_UTC[arc.id];
  return mapped ? parseUtcMs(mapped) : null;
};

const minDistanceCurveToRingKm = (curve, ringPoints) => {
  if (!curve || !curve.length || !ringPoints || !ringPoints.length) {
    return Number.POSITIVE_INFINITY;
  }
  let best = Number.POSITIVE_INFINITY;
  const ringStep = Math.max(1, Math.floor(ringPoints.length / 90));
  for (let i = 0; i < curve.length; i += 1) {
    const [lat, lon] = curve[i];
    for (let j = 0; j < ringPoints.length; j += ringStep) {
      const ring = ringPoints[j];
      if (!ring) {
        continue;
      }
      const dist = haversineDistanceKm(lat, lon, ring[0], ring[1]);
      if (dist < best) {
        best = dist;
      }
    }
  }
  return best;
};

const anomalyNearVisibleArc = (row, visibleArcs) => {
  if (!row || !visibleArcs.length) {
    return false;
  }
  const timeMs = parseUtcMs(row.time);
  const txLat = Number(row.tx_lat);
  const txLon = Number(row.tx_lon);
  const rxLat = Number(row.rx_lat);
  const rxLon = Number(row.rx_lon);
  const hasTx = Number.isFinite(txLat) && Number.isFinite(txLon);
  const hasRx = Number.isFinite(rxLat) && Number.isFinite(rxLon);
  if (!Number.isFinite(timeMs) || !hasTx || !hasRx) {
    return false;
  }
  const curve = interpolateGreatCircle([txLat, txLon], [rxLat, rxLon], ANOMALY_CURVE_STEPS);
  const windowMs = ANOMALY_ARC_TIME_WINDOW_MIN * 60 * 1000;
  for (let i = 0; i < visibleArcs.length; i += 1) {
    const arc = visibleArcs[i];
    const arcMs = getArcUtcMs(arc);
    if (!Number.isFinite(arcMs) || !arc.ringPoints) {
      continue;
    }
    if (Math.abs(timeMs - arcMs) > windowMs) {
      continue;
    }
    const minDist = minDistanceCurveToRingKm(curve, arc.ringPoints);
    if (minDist <= ANOMALY_ARC_DISTANCE_KM) {
      return true;
    }
  }
  return false;
};

const longPathNearRegion = (row, visibleArcs) => {
  const txLat = Number(row.tx_lat);
  const txLon = Number(row.tx_lon);
  const rxLat = Number(row.rx_lat);
  const rxLon = Number(row.rx_lon);
  const hasTx = Number.isFinite(txLat) && Number.isFinite(txLon);
  const hasRx = Number.isFinite(rxLat) && Number.isFinite(rxLon);
  if (!hasTx || !hasRx) {
    return false;
  }
  const longCurve = interpolateGreatCircleLong([txLat, txLon], [rxLat, rxLon], 96);
  const hitsBounds = longCurve.some((point) => inMatlabBounds(point[0], point[1]));
  if (hitsBounds) {
    return true;
  }
  if (!visibleArcs || !visibleArcs.length) {
    return false;
  }
  for (let i = 0; i < visibleArcs.length; i += 1) {
    const arc = visibleArcs[i];
    if (!arc || !arc.ringPoints) {
      continue;
    }
    const minDist = minDistanceCurveToRingKm(longCurve, arc.ringPoints);
    if (minDist <= ANOMALY_ARC_DISTANCE_KM) {
      return true;
    }
  }
  return false;
};

const slantRangeToGroundKm = (slantKm, satAltKm, earthRadiusKm = EARTH_RADIUS_KM) => {
  const rs = earthRadiusKm + satAltKm;
  const re = earthRadiusKm;
  const cosTheta = (rs * rs + re * re - slantKm * slantKm) / (2 * rs * re);
  const clamped = Math.min(1, Math.max(-1, cosTheta));
  return re * Math.acos(clamped);
};

const resizeCanvas = () => {
  canvas.width = mapWrap.clientWidth;
  canvas.height = mapWrap.clientHeight;
};

const projectOrthographic = (center, lat, lon, scale, translate, flipX) => {
  const phi = toRad(lat);
  const lambda = toRad(lon);
  const phi0 = toRad(center.lat);
  const lambda0 = toRad(center.lon);

  const cosC =
    Math.sin(phi0) * Math.sin(phi) +
    Math.cos(phi0) * Math.cos(phi) * Math.cos(lambda - lambda0);

  if (cosC < 0) {
    return null;
  }

  let x = Math.cos(phi) * Math.sin(lambda - lambda0) * scale;
  const y =
    -(Math.cos(phi0) * Math.sin(phi) -
      Math.sin(phi0) * Math.cos(phi) * Math.cos(lambda - lambda0)) *
    scale;

  if (flipX) {
    x *= -1;
  }

  return [x + translate[0], y + translate[1]];
};

const drawSphere = (radius, translate) => {
  const [cx, cy] = translate;
  const highlightX = cx - radius * 0.35;
  const highlightY = cy - radius * 0.35;
  const gradient = ctx.createRadialGradient(
    highlightX,
    highlightY,
    radius * 0.2,
    cx,
    cy,
    radius
  );
  gradient.addColorStop(0, "#f4fbff");
  gradient.addColorStop(0.5, "#cfe7ef");
  gradient.addColorStop(1, "#87a9b5");
  ctx.fillStyle = gradient;
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.fill();

  ctx.strokeStyle = "rgba(14, 26, 36, 0.3)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.stroke();
};

 

const drawProjectedLine = (
  points,
  projection,
  strokeStyle,
  lineWidth,
  opacity,
  lineDash
) => {
  ctx.strokeStyle = strokeStyle;
  ctx.lineWidth = lineWidth;
  ctx.globalAlpha = opacity;
  ctx.setLineDash(Array.isArray(lineDash) ? lineDash : []);
  ctx.beginPath();
  let hasSegment = false;

  points.forEach((point) => {
    const projected = projection(point[0], point[1]);
    if (!projected) {
      if (hasSegment) {
        ctx.stroke();
        ctx.beginPath();
        hasSegment = false;
      }
      return;
    }
    if (!hasSegment) {
      ctx.moveTo(projected[0], projected[1]);
      hasSegment = true;
    } else {
      ctx.lineTo(projected[0], projected[1]);
    }
  });

  if (hasSegment) {
    ctx.stroke();
  }
  ctx.setLineDash([]);
  ctx.globalAlpha = 1;
};

const drawProjectedPoints = (
  points,
  projection,
  fillStyle,
  radius,
  opacity
) => {
  ctx.fillStyle = fillStyle;
  ctx.globalAlpha = opacity;
  points.forEach((point) => {
    const projected = projection(point[0], point[1]);
    if (!projected) {
      return;
    }
    ctx.beginPath();
    ctx.arc(projected[0], projected[1], radius, 0, Math.PI * 2);
    ctx.fill();
  });
  ctx.globalAlpha = 1;
};

const drawMapLabel = (text, point, projection, fillStyle, offset) => {
  if (!text || !point) {
    return;
  }
  const projected = projection(point[0], point[1]);
  if (!projected) {
    return;
  }
  const [ox, oy] = offset || [0, 0];
  ctx.font = "12px Space Grotesk, sans-serif";
  ctx.globalAlpha = 0.9;
  ctx.strokeStyle = "rgba(255, 255, 255, 0.9)";
  ctx.lineWidth = 3;
  ctx.strokeText(text, projected[0] + 6 + ox, projected[1] - 6 + oy);
  ctx.fillStyle = fillStyle;
  ctx.fillText(text, projected[0] + 6 + ox, projected[1] - 6 + oy);
  ctx.globalAlpha = 1;
};

const drawLabelLeader = (fromPoint, toPoint, strokeStyle) => {
  if (!fromPoint || !toPoint) {
    return;
  }
  ctx.strokeStyle = strokeStyle;
  ctx.lineWidth = 1;
  ctx.globalAlpha = 0.8;
  ctx.setLineDash([2, 4]);
  ctx.beginPath();
  ctx.moveTo(fromPoint[0], fromPoint[1]);
  ctx.lineTo(toPoint[0], toPoint[1]);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.globalAlpha = 1;
};

const placeLabel = (projection, point, occupied, minDist = 18) => {
  const projected = projection(point[0], point[1]);
  if (!projected) {
    return null;
  }
  const offsets = [
    [0, 0],
    [14, -12],
    [-14, -12],
    [14, 12],
    [-14, 12],
    [0, -18],
    [0, 18],
    [22, 0],
    [-22, 0]
  ];
  for (const [ox, oy] of offsets) {
    const x = projected[0] + ox;
    const y = projected[1] + oy;
    let ok = true;
    for (const p of occupied) {
      const dx = x - p[0];
      const dy = y - p[1];
      if (Math.hypot(dx, dy) < minDist) {
        ok = false;
        break;
      }
    }
    if (ok) {
      occupied.push([x, y]);
      return [ox, oy];
    }
  }
  occupied.push(projected);
  return [0, 0];
};

const drawProjectedPolygon = (
  points,
  projection,
  fillStyle,
  opacity,
  strokeStyle,
  lineWidth
) => {
  ctx.beginPath();
  let started = false;
  points.forEach((point) => {
    const projected = projection(point[0], point[1]);
    if (!projected) {
      return;
    }
    if (!started) {
      ctx.moveTo(projected[0], projected[1]);
      started = true;
    } else {
      ctx.lineTo(projected[0], projected[1]);
    }
  });
  if (!started) {
    return;
  }
  ctx.closePath();
  ctx.globalAlpha = opacity;
  ctx.fillStyle = fillStyle;
  ctx.fill();
  if (strokeStyle) {
    ctx.strokeStyle = strokeStyle;
    ctx.lineWidth = lineWidth || 1;
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
};

const bearingDeg = (lat1, lon1, lat2, lon2) => {
  const phi1 = toRad(lat1);
  const phi2 = toRad(lat2);
  const dLon = toRad(lon2 - lon1);
  const y = Math.sin(dLon) * Math.cos(phi2);
  const x =
    Math.cos(phi1) * Math.sin(phi2) -
    Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLon);
  const brng = Math.atan2(y, x);
  return (toDeg(brng) + 360) % 360;
};

const kmToLatDeg = (km) => km / 110.574;

const kmToLonDeg = (km, latDeg) => km / (111.320 * Math.cos(toRad(latDeg)));

const brokenRidgeBox = (center, lengthKm, widthKm) => {
  const halfLat = kmToLatDeg(widthKm / 2);
  const halfLon = kmToLonDeg(lengthKm / 2, center.lat);
  const minLat = center.lat - halfLat;
  const maxLat = center.lat + halfLat;
  const minLon = center.lon - halfLon;
  const maxLon = center.lon + halfLon;
  return [
    [minLat, minLon],
    [minLat, maxLon],
    [maxLat, maxLon],
    [maxLat, minLon],
    [minLat, minLon]
  ];
};

const findArcByIdOrTime = (arcs, targetIds, targetTimes) => {
  if (!Array.isArray(arcs)) {
    return null;
  }
  const byId = arcs.find((arc) => targetIds.includes(arc.id));
  if (byId) {
    return byId;
  }
  return arcs.find((arc) => {
    const time = arc.time_utc || arc.time || "";
    return targetTimes.includes(time) || targetTimes.includes(time.slice(0, 5));
  });
};

const computeArc7Band = (state) => {
  if (!state || !state.arcs || !state.arcs.length) {
    return [];
  }
  const arc7 = findArcByIdOrTime(
    state.arcs,
    ["ping-001929", "arc-7", "arc7"],
    ["00:19:29", "00:19"]
  );
  if (!arc7 || !arc7.ringPoints || !arc7.ringPoints.length || !arc7.center) {
    return [];
  }
  const deltaKm = 100;
  const center = arc7.center;
  let arcSegment = arc7.ringPoints;
  if (state.flightLines && state.flightLines.length) {
    const hits = arc7.ringPoints.map((point) => {
      const lat = point[0];
      const lon = point[1];
      for (const line of state.flightLines) {
        for (const fp of line) {
          const d = haversineDistanceKm(lat, lon, fp[0], fp[1], state.earthRadiusKm);
          if (d <= deltaKm) {
            return true;
          }
        }
      }
      return false;
    });
    const firstIdx = hits.indexOf(true);
    const lastIdx = hits.lastIndexOf(true);
    if (firstIdx !== -1 && lastIdx !== -1 && lastIdx > firstIdx) {
      arcSegment = arc7.ringPoints.slice(firstIdx, lastIdx + 1);
    }
  }
  if (arcSegment.length < 2) {
    return [];
  }

  const outer = [];
  const inner = [];
  arcSegment.forEach((point) => {
    const lat = point[0];
    const lon = point[1];
    const brng = bearingDeg(center.lat, center.lon, lat, lon);
    const radiusKm = haversineDistanceKm(center.lat, center.lon, lat, lon, state.earthRadiusKm);
    const outerKm = radiusKm + deltaKm;
    const innerKm = Math.max(0, radiusKm - deltaKm);
    const outerPoint = vincentyDirect(center.lat, center.lon, brng, outerKm);
    const innerPoint = vincentyDirect(center.lat, center.lon, brng, innerKm);
    outer.push(outerPoint);
    inner.push(innerPoint);
  });
  return [...outer, ...inner.reverse(), outer[0]];
};

const computeArc7PublicBand = (state) => {
  if (!state || !state.arcs || !state.arcs.length) {
    return [];
  }
  const arc7 = findArcByIdOrTime(
    state.arcs,
    ["ping-001929", "arc-7", "arc7"],
    ["00:19:29", "00:19"]
  );
  if (!arc7 || !arc7.ringPoints || !arc7.ringPoints.length || !arc7.center) {
    return [];
  }
  const deltaKm = 83;
  const minLat = -36;
  const maxLat = -33;
  const indices = [];
  arc7.ringPoints.forEach((p, idx) => {
    if (p[0] >= minLat && p[0] <= maxLat) {
      indices.push(idx);
    }
  });
  if (indices.length < 2) {
    return [];
  }
  // Split into contiguous index ranges and pick the eastern-most segment
  const ranges = [];
  let start = indices[0];
  let prev = indices[0];
  for (let i = 1; i < indices.length; i += 1) {
    const idx = indices[i];
    if (idx === prev + 1) {
      prev = idx;
      continue;
    }
    ranges.push([start, prev]);
    start = idx;
    prev = idx;
  }
  ranges.push([start, prev]);

  let bestRange = ranges[0];
  let bestMeanLon = -Infinity;
  ranges.forEach(([a, b]) => {
    const segment = arc7.ringPoints.slice(a, b + 1);
    const meanLon =
      segment.reduce((sum, p) => sum + p[1], 0) / segment.length;
    if (meanLon > bestMeanLon) {
      bestMeanLon = meanLon;
      bestRange = [a, b];
    }
  });
  const arcSegment = arc7.ringPoints.slice(bestRange[0], bestRange[1] + 1);
  if (arcSegment.length < 2) {
    return [];
  }
  const center = arc7.center;
  const outer = [];
  const inner = [];
  arcSegment.forEach((point) => {
    const lat = point[0];
    const lon = point[1];
    const brng = bearingDeg(center.lat, center.lon, lat, lon);
    const radiusKm = haversineDistanceKm(center.lat, center.lon, lat, lon, state.earthRadiusKm);
    const outerKm = radiusKm + deltaKm;
    const innerKm = Math.max(0, radiusKm - deltaKm);
    outer.push(vincentyDirect(center.lat, center.lon, brng, outerKm));
    inner.push(vincentyDirect(center.lat, center.lon, brng, innerKm));
  });
  return [...outer, ...inner.reverse(), outer[0]];
};

const getWsprRowKey = (row) =>
  `${row.time}|${row.band}|${row.tx_sign}|${row.rx_sign}`;

const getWsprLabelOffset = (rowKey, side) => {
  if (!state || !state.labelOffsets) {
    return { x: 0, y: 0 };
  }
  const entry = state.labelOffsets[rowKey];
  if (!entry || !entry[side]) {
    return { x: 0, y: 0 };
  }
  return entry[side];
};

const getWsprLabelPosition = (row, lat, lon, projection, side) => {
  const projected = projection(lat, lon);
  if (!projected) {
    return null;
  }
  const rowKey = getWsprRowKey(row);
  const baseOffset = side === "rx" ? [6, 10] : [6, -6];
  const offset = getWsprLabelOffset(rowKey, side);
  return {
    x: projected[0] + baseOffset[0] + offset.x,
    y: projected[1] + baseOffset[1] + offset.y
  };
};

const getWsprLabelRect = (row, lat, lon, projection, side) => {
  const labelPos = getWsprLabelPosition(row, lat, lon, projection, side);
  if (!labelPos) {
    return null;
  }
  const label = `${row.time} ${row.band} ${row.tx_sign}->${row.rx_sign}`;
  ctx.font = "12px Space Grotesk, sans-serif";
  const metrics = ctx.measureText(label);
  const height = 12;
  return {
    x: labelPos.x,
    y: labelPos.y - height,
    width: metrics.width,
    height,
    text: label
  };
};

const pickWsprLabelAt = (x, y) => {
  if (!state || !state.selectedWsprRow || !state.lastProjection) {
    return null;
  }
  const row = state.selectedWsprRow;
  const projection = state.lastProjection;
  const txLat = Number(row.tx_lat);
  const txLon = Number(row.tx_lon);
  const rxLat = Number(row.rx_lat);
  const rxLon = Number(row.rx_lon);
  const hasTx = Number.isFinite(txLat) && Number.isFinite(txLon);
  const hasRx = Number.isFinite(rxLat) && Number.isFinite(rxLon);
  const hits = [];
  if (hasTx) {
    const rect = getWsprLabelRect(row, txLat, txLon, projection, "tx");
    if (rect && x >= rect.x && x <= rect.x + rect.width && y >= rect.y && y <= rect.y + rect.height) {
      hits.push({ row, side: "tx" });
    }
  }
  if (hasRx) {
    const rect = getWsprLabelRect(row, rxLat, rxLon, projection, "rx");
    if (rect && x >= rect.x && x <= rect.x + rect.width && y >= rect.y && y <= rect.y + rect.height) {
      hits.push({ row, side: "rx" });
    }
  }
  return hits[0] || null;
};

const drawWsprNodeLabel = (row, lat, lon, projection, side, fillStyle) => {
  const projected = projection(lat, lon);
  if (!projected) {
    return;
  }
  const label = `${row.time} ${row.band} ${row.tx_sign}->${row.rx_sign}`;
  const rowKey = getWsprRowKey(row);
  const baseOffset = side === "rx" ? [6, 10] : [6, -6];
  const offset = getWsprLabelOffset(rowKey, side);
  const offsetY = baseOffset[1] + offset.y;
  ctx.font = "12px Space Grotesk, sans-serif";
  ctx.fillStyle = fillStyle;
  ctx.globalAlpha = 0.7;
  ctx.fillText(
    label,
    projected[0] + baseOffset[0] + offset.x,
    projected[1] + offsetY
  );
  ctx.globalAlpha = 1;
};

const drawGraticule = (projection) => {
  const latStep = 10;
  const lonStep = 10;
  const lineStyle = "rgba(14, 26, 36, 0.15)";

  for (let lat = -80; lat <= 80; lat += latStep) {
    const points = [];
    for (let lon = -180; lon <= 180; lon += 2) {
      points.push([lat, lon]);
    }
    drawProjectedLine(points, projection, lineStyle, 0.6, 1);
  }

  for (let lon = -180; lon <= 180; lon += lonStep) {
    const points = [];
    for (let lat = -90; lat <= 90; lat += 2) {
      points.push([lat, lon]);
    }
    drawProjectedLine(points, projection, lineStyle, 0.6, 1);
  }
};

const circlePoints = (center, radiusKm, steps = 360) => {
  const lat1 = toRad(center.lat);
  const lon1 = toRad(center.lon);
  const angDist = radiusKm / EARTH_RADIUS_KM;
  const points = [];

  for (let i = 0; i <= steps; i += 1) {
    const bearing = toRad((360 / steps) * i);
    const sinLat1 = Math.sin(lat1);
    const cosLat1 = Math.cos(lat1);
    const sinAng = Math.sin(angDist);
    const cosAng = Math.cos(angDist);

    const lat2 = Math.asin(
      sinLat1 * cosAng + cosLat1 * sinAng * Math.cos(bearing)
    );
    const lon2 =
      lon1 +
      Math.atan2(
        Math.sin(bearing) * sinAng * cosLat1,
        cosAng - sinLat1 * Math.sin(lat2)
      );

    points.push([toDeg(lat2), ((toDeg(lon2) + 540) % 360) - 180]);
  }

  return points;
};

const vincentyDirect = (latDeg, lonDeg, bearingDeg, distanceKm) => {
  const a = WGS84_A_KM * 1000;
  const b = WGS84_B_KM * 1000;
  const f = WGS84_F;
  const phi1 = toRad(latDeg);
  const lambda1 = toRad(lonDeg);
  const alpha1 = toRad(bearingDeg);
  const sinAlpha1 = Math.sin(alpha1);
  const cosAlpha1 = Math.cos(alpha1);
  const tanU1 = (1 - f) * Math.tan(phi1);
  const cosU1 = 1 / Math.sqrt(1 + tanU1 * tanU1);
  const sinU1 = tanU1 * cosU1;
  const sigma1 = Math.atan2(tanU1, cosAlpha1);
  const sinAlpha = cosU1 * sinAlpha1;
  const cosSqAlpha = 1 - sinAlpha * sinAlpha;
  const uSq = (cosSqAlpha * (a * a - b * b)) / (b * b);
  const A = 1 + (uSq / 16384) * (4096 + uSq * (-768 + uSq * (320 - 175 * uSq)));
  const B = (uSq / 1024) * (256 + uSq * (-128 + uSq * (74 - 47 * uSq)));
  let sigma = (distanceKm * 1000) / (b * A);
  let sigmaP = 2 * Math.PI;
  let cos2SigmaM = 0;
  let sinSigma = 0;
  let cosSigma = 0;

  for (let i = 0; i < 64 && Math.abs(sigma - sigmaP) > 1e-12; i += 1) {
    cos2SigmaM = Math.cos(2 * sigma1 + sigma);
    sinSigma = Math.sin(sigma);
    cosSigma = Math.cos(sigma);
    const deltaSigma =
      B *
      sinSigma *
      (cos2SigmaM +
        (B / 4) *
          (cosSigma * (-1 + 2 * cos2SigmaM * cos2SigmaM) -
            (B / 6) *
              cos2SigmaM *
              (-3 + 4 * sinSigma * sinSigma) *
              (-3 + 4 * cos2SigmaM * cos2SigmaM)));
    sigmaP = sigma;
    sigma = (distanceKm * 1000) / (b * A) + deltaSigma;
  }

  const tmp = sinU1 * sinSigma - cosU1 * cosSigma * cosAlpha1;
  const phi2 = Math.atan2(
    sinU1 * cosSigma + cosU1 * sinSigma * cosAlpha1,
    (1 - f) * Math.sqrt(sinAlpha * sinAlpha + tmp * tmp)
  );
  const lambda = Math.atan2(
    sinSigma * sinAlpha1,
    cosU1 * cosSigma - sinU1 * sinSigma * cosAlpha1
  );
  const C = (f / 16) * cosSqAlpha * (4 + f * (4 - 3 * cosSqAlpha));
  const L =
    lambda -
    (1 - C) *
      f *
      sinAlpha *
      (sigma +
        C *
          sinSigma *
          (cos2SigmaM +
            C * cosSigma * (-1 + 2 * cos2SigmaM * cos2SigmaM)));

  return [toDeg(phi2), ((toDeg(lambda1 + L) + 540) % 360) - 180];
};

const circlePointsWgs84 = (center, radiusKm, steps = 360) => {
  const points = [];
  for (let i = 0; i <= steps; i += 1) {
    const bearing = (360 / steps) * i;
    const point = vincentyDirect(center.lat, center.lon, bearing, radiusKm);
    points.push(point);
  }
  return points;
};

const interpolateGreatCircle = (start, end, steps = 64) => {
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
      Math.max(
        -1,
        sinLat1 * sinLat2 + cosLat1 * cosLat2 * Math.cos(lon2 - lon1)
      )
    )
  );

  if (delta === 0) {
    return [start, end];
  }

  const points = [];
  const sinDelta = Math.sin(delta);
  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps;
    const a = Math.sin((1 - t) * delta) / sinDelta;
    const b = Math.sin(t * delta) / sinDelta;

    const x = a * cosLat1 * Math.cos(lon1) + b * cosLat2 * Math.cos(lon2);
    const y = a * cosLat1 * Math.sin(lon1) + b * cosLat2 * Math.sin(lon2);
    const z = a * sinLat1 + b * sinLat2;

    const lat = Math.atan2(z, Math.sqrt(x * x + y * y));
    const lon = Math.atan2(y, x);
    points.push([toDeg(lat), ((toDeg(lon) + 540) % 360) - 180]);
  }

  return points;
};

const interpolateGreatCircleLong = (start, end, steps = 64) => {
  const lat1 = toRad(start[0]);
  const lon1 = toRad(start[1]);
  const lat2 = toRad(end[0]);
  const lon2 = toRad(end[1]);

  const s = [
    Math.cos(lat1) * Math.cos(lon1),
    Math.cos(lat1) * Math.sin(lon1),
    Math.sin(lat1)
  ];
  const e = [
    Math.cos(lat2) * Math.cos(lon2),
    Math.cos(lat2) * Math.sin(lon2),
    Math.sin(lat2)
  ];
  const dot = Math.min(1, Math.max(-1, s[0] * e[0] + s[1] * e[1] + s[2] * e[2]));
  let theta = Math.acos(dot);
  if (theta === 0) {
    return [start, end];
  }
  let axis = [
    s[1] * e[2] - s[2] * e[1],
    s[2] * e[0] - s[0] * e[2],
    s[0] * e[1] - s[1] * e[0]
  ];
  const axisLen = Math.hypot(axis[0], axis[1], axis[2]);
  if (axisLen === 0) {
    return [start, end];
  }
  axis = [axis[0] / axisLen, axis[1] / axisLen, axis[2] / axisLen];
  axis = [-axis[0], -axis[1], -axis[2]];
  theta = Math.PI * 2 - theta;

  const points = [];
  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps;
    const angle = theta * t;
    const cosA = Math.cos(angle);
    const sinA = Math.sin(angle);
    const cross = [
      axis[1] * s[2] - axis[2] * s[1],
      axis[2] * s[0] - axis[0] * s[2],
      axis[0] * s[1] - axis[1] * s[0]
    ];
    const dotAxis = axis[0] * s[0] + axis[1] * s[1] + axis[2] * s[2];
    const v = [
      s[0] * cosA + cross[0] * sinA + axis[0] * dotAxis * (1 - cosA),
      s[1] * cosA + cross[1] * sinA + axis[1] * dotAxis * (1 - cosA),
      s[2] * cosA + cross[2] * sinA + axis[2] * dotAxis * (1 - cosA)
    ];
    const lat = Math.atan2(v[2], Math.sqrt(v[0] * v[0] + v[1] * v[1]));
    const lon = Math.atan2(v[1], v[0]);
    points.push([toDeg(lat), ((toDeg(lon) + 540) % 360) - 180]);
  }
  return points;
};

const LONG_PATH_START_UTC = "2014-03-07 22:40:00";
const LONG_PATH_END_UTC = "2014-03-08 01:00:00";

const parseUtcMillis = (value) => {
  if (!value) {
    return null;
  }
  // Expect "YYYY-MM-DD HH:MM:SS"
  const normalized = value.replace(" ", "T") + "Z";
  const ms = Date.parse(normalized);
  return Number.isFinite(ms) ? ms : null;
};

const isInLongPathWindow = (row) => {
  if (!row || !row.time) {
    return false;
  }
  if (row._timeMs == null) {
    row._timeMs = parseUtcMillis(row.time);
  }
  if (row._timeMs == null) {
    return false;
  }
  if (!isInLongPathWindow._startMs) {
    isInLongPathWindow._startMs = parseUtcMillis(LONG_PATH_START_UTC);
    isInLongPathWindow._endMs = parseUtcMillis(LONG_PATH_END_UTC);
  }
  return row._timeMs >= isInLongPathWindow._startMs && row._timeMs <= isInLongPathWindow._endMs;
};

const parseZ = (value) => {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
};

const anomalyStyle = (row) => {
  const snrZ = parseZ(row.snr_z);
  const driftZ = parseZ(row.drift_z);
  const score = Math.max(
    snrZ ? Math.abs(snrZ) : 0,
    driftZ ? Math.abs(driftZ) : 0
  );
  if (score >= 5) {
    return { color: "#b91c1c", width: 2.6, alpha: 0.9 };
  }
  if (score >= 3) {
    return { color: "#ef4444", width: 2.0, alpha: 0.75 };
  }
  if (score >= 1) {
    return { color: "#f59e0b", width: 1.4, alpha: 0.55 };
  }
  return { color: "#9ca3af", width: 0.9, alpha: 0.4 };
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
      Math.max(
        -1,
        sinLat1 * sinLat2 + cosLat1 * cosLat2 * Math.cos(lon2 - lon1)
      )
    )
  );

  if (delta === 0) {
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

const parseCsvRow = (line) => {
  const parts = line.split(",").map((value) => value.trim());
  return parts.map((value) => value.replace(/^\"|\"$/g, ""));
};

const parseWsprData = (text) => {
  if (!text) {
    return [];
  }
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));

  if (!lines.length) {
    return [];
  }

  const defaultFields = [
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
  ];

  const header = parseCsvRow(lines[0]);
  const hasHeader = header.includes("tx_lat") || header.includes("rx_lat");
  const fields = hasHeader ? header : defaultFields;
  const startIndex = hasHeader ? 1 : 0;

  return lines.slice(startIndex).map((line) => {
    const values = parseCsvRow(line);
    const row = {};
    fields.forEach((field, idx) => {
      row[field] = values[idx];
    });
    return row;
  });
};

const readInlineData = () => {
  const el = document.getElementById("arcs-data");
  if (!el) {
    return null;
  }
  try {
    return JSON.parse(el.textContent);
  } catch (error) {
    return { __error: error };
  }
};

const readArcgisInlineData = () => {
  const el = document.getElementById("arcgis-data");
  if (!el) {
    return null;
  }
  try {
    return JSON.parse(el.textContent);
  } catch (error) {
    return null;
  }
};

const readArcgisFlightInlineData = () => {
  const el = document.getElementById("arcgis-flight-data");
  if (!el) {
    return null;
  }
  try {
    return JSON.parse(el.textContent);
  } catch (error) {
    return null;
  }
};

const MATLAB_BOUNDS = {
  latMin: 1,
  latMax: 6,
  lonMin: 99,
  lonMax: 105
};

const inMatlabBounds = (lat, lon) => {
  return (
    lat >= MATLAB_BOUNDS.latMin &&
    lat <= MATLAB_BOUNDS.latMax &&
    lon >= MATLAB_BOUNDS.lonMin &&
    lon <= MATLAB_BOUNDS.lonMax
  );
};

const readAdsbData = () => {
  const el = document.getElementById("adsb-data");
  if (!el) {
    return [];
  }
  const lines = el.textContent.split(/\r?\n/);
  const points = [];

  lines.forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("lat,")) {
      return;
    }
    const parts = trimmed.split(",");
    if (parts.length < 2) {
      return;
    }
    const lat = Number(parts[0]);
    const lon = Number(parts[1]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      return;
    }
    points.push([lat, lon]);
  });

  return points;
};

const parseTracceCsv = (text) => {
  if (!text) {
    return [];
  }
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line);
  if (!lines.length) {
    return [];
  }
  const header = parseCsvRow(lines[0]).map((value) => value.toLowerCase());
  const latIdx = header.indexOf("latitude");
  const lonIdx = header.indexOf("longitude");
  if (latIdx === -1 || lonIdx === -1) {
    return [];
  }
  const points = [];
  for (let i = 1; i < lines.length; i += 1) {
    const values = parseCsvRow(lines[i]);
    const lat = Number(values[latIdx]);
    const lon = Number(values[lonIdx]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      continue;
    }
    points.push([lat, lon]);
  }
  return points;
};

const loadAircraftData = () => {
  return fetch("Study_Case/Tracce.csv")
    .then((response) => response.text())
    .then((text) => parseTracceCsv(text))
    .catch(() => []);
};

const parseMatlabLinks = (text) => {
  if (!text) {
    return [];
  }
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line);
  if (!lines.length) {
    return [];
  }
  const header = parseCsvRow(lines[0]).map((value) => value.toLowerCase());
  const txLatIdx = header.indexOf("tx_lat");
  const txLonIdx = header.indexOf("tx_lon");
  const rxLatIdx = header.indexOf("rx_lat");
  const rxLonIdx = header.indexOf("rx_lon");
  const colorIdx = header.indexOf("color");
  const revIdx = header.indexOf("rev");
  if (txLatIdx === -1 || txLonIdx === -1 || rxLatIdx === -1 || rxLonIdx === -1) {
    return [];
  }
  const links = [];
  for (let i = 1; i < lines.length; i += 1) {
    const values = parseCsvRow(lines[i]);
    const txLat = Number(values[txLatIdx]);
    const txLon = Number(values[txLonIdx]);
    const rxLat = Number(values[rxLatIdx]);
    const rxLon = Number(values[rxLonIdx]);
    if (!Number.isFinite(txLat) || !Number.isFinite(txLon) || !Number.isFinite(rxLat) || !Number.isFinite(rxLon)) {
      continue;
    }
    links.push({
      txLat,
      txLon,
      rxLat,
      rxLon,
      color: colorIdx >= 0 ? values[colorIdx] : "#000000",
      rev: revIdx >= 0 ? values[revIdx] : "0"
    });
  }
  return links;
};

const loadMatlabLinks = () => {
  return fetch("Study_Case/matlab_wspr_links.csv")
    .then((response) => response.text())
    .then((text) => parseMatlabLinks(text))
    .catch(() => []);
};

const parseCandidateLinks = (text) => {
  if (!text) {
    return [];
  }
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line);
  if (!lines.length) {
    return [];
  }
  const header = parseCsvRow(lines[0]).map((value) => value.toLowerCase());
  const txLatIdx = header.indexOf("tx_lat");
  const txLonIdx = header.indexOf("tx_lon");
  const rxLatIdx = header.indexOf("rx_lat");
  const rxLonIdx = header.indexOf("rx_lon");
  const arcIdIdx = header.indexOf("arc_id");
  if (txLatIdx === -1 || txLonIdx === -1 || rxLatIdx === -1 || rxLonIdx === -1) {
    return [];
  }
  const links = [];
  for (let i = 1; i < lines.length; i += 1) {
    const values = parseCsvRow(lines[i]);
    const txLat = Number(values[txLatIdx]);
    const txLon = Number(values[txLonIdx]);
    const rxLat = Number(values[rxLatIdx]);
    const rxLon = Number(values[rxLonIdx]);
    if (!Number.isFinite(txLat) || !Number.isFinite(txLon) || !Number.isFinite(rxLat) || !Number.isFinite(rxLon)) {
      continue;
    }
    links.push({
      txLat,
      txLon,
      rxLat,
      rxLon,
      arcId: arcIdIdx >= 0 ? values[arcIdIdx] : ""
    });
  }
  return links;
};

const loadCandidateLinks = () => {
  return fetch("Study_Case/wspr_candidates_from_richard.csv")
    .then((response) => response.text())
    .then((text) => parseCandidateLinks(text))
    .catch(() => []);
};

const parseLatLonPairs = (text) => {
  if (!text) {
    return [];
  }
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line);
  if (lines.length < 2) {
    return [];
  }
  const points = [];
  for (let i = 1; i < lines.length; i += 1) {
    const parts = lines[i].split(",");
    const lat = Number(parts[0]);
    const lon = Number(parts[1]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      continue;
    }
    points.push([lat, lon]);
  }
  return points;
};

const loadMh370LatLonPoints = () => {
  return fetch("Study_Case/mh370_latlon_points_clean.csv")
    .then((response) => response.text())
    .then((text) => parseLatLonPairs(text))
    .catch(() => []);
};

const loadFuelArea = () => {
  return fetch("Study_Case/fuel_area.json")
    .then((response) => response.json())
    .catch(() => null);
};

const loadOceanInfinityPaths = () => {
  return fetch("Study_Case/OceanInfinity/ocean_infinity_2025_paths.json")
    .then((response) => response.json())
    .catch(() => []);
};

const loadOceanInfinityLivePaths = () => {
  return fetch("Study_Case/OceanInfinity/ocean_infinity_live_paths.json")
    .then((response) => response.json())
    .catch(() => []);
};

const loadOceanInfinityPhase1Paths = () => {
  return fetch("Study_Case/OceanInfinity/ocean_infinity_phase1_paths.json")
    .then((response) => response.json())
    .catch(() => []);
};

const extractScLines = (scData) => {
  if (!scData || !scData.data) {
    return [];
  }
  const lines = [];
  Object.keys(scData.data).forEach((vessel) => {
    const rows = scData.data[vessel];
    if (!Array.isArray(rows) || !rows.length) {
      return;
    }
    const points = rows
      .map((row) => {
        const lat = Number(row[1]);
        const lon = Number(row[2]);
        return Number.isFinite(lat) && Number.isFinite(lon) ? [lat, lon] : null;
      })
      .filter(Boolean);
    if (points.length) {
      lines.push(points);
    }
  });
  return lines;
};

const loadSeabedConstructorPaths = () => {
  const files = [
    "Study_Case/OceanInfinity/SC1.json",
    "Study_Case/OceanInfinity/SC2.json",
    "Study_Case/OceanInfinity/SC3.json",
    "Study_Case/OceanInfinity/SC4.json"
  ];
  return Promise.all(
    files.map((file) =>
      fetch(file)
        .then((response) => response.json())
        .then((data) => extractScLines(data))
        .catch(() => [])
    )
  ).then((sets) => sets.flat());
};

const buildGodfreyLayers = (useWgs84) => {
  const circleFn = useWgs84 ? circlePointsWgs84 : circlePoints;
  const godfrey3Center = { lat: -29.128, lon: 99.934 };
  return [
    {
      id: "godfrey1",
      label: "Godfrey1",
      point: [-33.177, 95.3],
      color: "#c026d3",
      ringPoints: null
    },
    {
      id: "godfrey2",
      label: "Godfrey2",
      point: [-33.2, 95.3],
      color: "#a21caf",
      ringPoints: null
    },
    {
      id: "godfrey3",
      label: "Godfrey3",
      point: [godfrey3Center.lat, godfrey3Center.lon],
      color: "#db2777",
      ringPoints: circleFn(godfrey3Center, 30, 180)
    }
  ];
};

const SEARCH_AREAS_VERSION = "2026-01-30a";
const loadOceanInfinitySearchAreas = () => {
  return fetch(`Study_Case/OceanInfinity/ocean_infinity_search_areas.json?v=${SEARCH_AREAS_VERSION}`)
    .then((response) => response.json())
    .catch(() => ({ polygons: [], lines: [] }));
};

const hashString = (value) => {
  let hash = 0;
  if (!value) {
    return hash;
  }
  for (let i = 0; i < value.length; i += 1) {
    hash = ((hash << 5) - hash + value.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
};

const AREA_PALETTE = [
  "14,116,144",
  "37,99,235",
  "79,70,229",
  "99,102,241",
  "16,185,129",
  "245,158,11",
  "239,68,68",
  "190,24,93"
];

const getAreaColor = (labelText) => {
  const idx = hashString(labelText) % AREA_PALETTE.length;
  const rgb = AREA_PALETTE[idx];
  return {
    fill: `rgba(${rgb}, 0.22)`,
    stroke: `rgba(${rgb}, 0.85)`,
    label: `rgba(${rgb}, 0.95)`
  };
};

const ensureClosedRing = (points) => {
  if (!Array.isArray(points) || points.length < 3) {
    return points;
  }
  const first = points[0];
  const last = points[points.length - 1];
  if (!first || !last) {
    return points;
  }
  const close =
    Math.abs(first[0] - last[0]) < 0.001 && Math.abs(first[1] - last[1]) < 0.001;
  return close ? points : points.concat([first]);
};

const ringBounds = (points) => {
  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLon = Infinity;
  let maxLon = -Infinity;
  points.forEach((pt) => {
    if (!pt) {
      return;
    }
    const lat = pt[0];
    const lon = pt[1];
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      return;
    }
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
    if (lon < minLon) minLon = lon;
    if (lon > maxLon) maxLon = lon;
  });
  if (!Number.isFinite(minLat) || !Number.isFinite(minLon)) {
    return null;
  }
  return {
    minLat,
    maxLat,
    minLon,
    maxLon,
    spanLat: maxLat - minLat,
    spanLon: maxLon - minLon
  };
};



const readWsprData = () => {
  const el = document.getElementById("wspr-data");
  if (!el) {
    return "";
  }
  return el.textContent || "";
};

const readWsprFilteredInlineData = () => {
  const el = document.getElementById("wspr-filtered-data");
  if (!el) {
    return "";
  }
  return el.textContent || "";
};

const readWsprFiltered2InlineData = () => {
  const el = document.getElementById("wspr-filtered2-data");
  if (!el) {
    return "";
  }
  return el.textContent || "";
};

const readWsprAnomaliesInlineData = () => {
  const el = document.getElementById("wspr-anomalies-data");
  if (!el) {
    return "";
  }
  return el.textContent || "";
};

const loadLongPathData = () => {
  return fetch("Study_Case/wspr_longpath_indian_ocean_2240_onwards.csv")
    .then((response) => response.text())
    .catch(() => "");
};

const readLandData = () => {
  const el = document.getElementById("land-data");
  if (!el) {
    return null;
  }
  try {
    return JSON.parse(el.textContent);
  } catch (error) {
    return null;
  }
};

const decodeLandTopojson = (topology) => {
  if (!topology || !topology.objects || !topology.arcs || !topology.transform) {
    return [];
  }
  const { scale, translate } = topology.transform;

  const decodeArc = (arc) => {
    let x = 0;
    let y = 0;
    const points = [];
    arc.forEach((delta) => {
      x += delta[0];
      y += delta[1];
      const lon = x * scale[0] + translate[0];
      const lat = y * scale[1] + translate[1];
      points.push([lat, lon]);
    });
    return points;
  };

  const arcCache = topology.arcs.map(decodeArc);

  const arcToPoints = (arcIdx) => {
    const idx = arcIdx < 0 ? ~arcIdx : arcIdx;
    const arc = arcCache[idx] || [];
    return arcIdx < 0 ? arc.slice().reverse() : arc;
  };

  const ringFromArcIndexes = (arcIndexes) => {
    let ring = [];
    arcIndexes.forEach((arcIdx) => {
      const arc = arcToPoints(arcIdx);
      if (!arc.length) {
        return;
      }
      ring = ring.length ? ring.concat(arc.slice(1)) : ring.concat(arc);
    });
    return ring;
  };

  const extractRings = (geom) => {
    let rings = [];
    if (!geom) {
      return rings;
    }
    if (geom.type === "Polygon") {
      geom.arcs.forEach((ring) => {
        rings.push(ringFromArcIndexes(ring));
      });
    } else if (geom.type === "MultiPolygon") {
      geom.arcs.forEach((poly) => {
        poly.forEach((ring) => {
          rings.push(ringFromArcIndexes(ring));
        });
      });
    } else if (geom.type === "GeometryCollection") {
      geom.geometries.forEach((g) => {
        rings = rings.concat(extractRings(g));
      });
    }
    return rings;
  };

  const objectKeys = Object.keys(topology.objects || {});
  const landObject = topology.objects.land || topology.objects[objectKeys[0]];
  return extractRings(landObject);
};

const loadArcsData = () => {
  return fetch("arcs.json")
    .then((response) => response.json())
    .catch(() => {
      const inline = readInlineData();
      if (inline && !inline.__error) {
        return inline;
      }
      const message = inline && inline.__error
        ? inline.__error.message
        : "No inline data found.";
      throw new Error(message);
    });
};

const loadReferenceArc = () => {
  return fetch("arcgis_7tharc.geojson")
    .then((response) => response.json())
    .then((geojson) => {
      if (!geojson || !geojson.features) {
        return [];
      }
      const lines = [];
      geojson.features.forEach((feature) => {
        if (!feature || !feature.geometry) {
          return;
        }
        const { type, coordinates } = feature.geometry;
        if (type === "LineString") {
          lines.push(
            coordinates.map((point) => [point[1], point[0]])
          );
        } else if (type === "MultiLineString") {
          coordinates.forEach((line) => {
            lines.push(line.map((point) => [point[1], point[0]]));
          });
        }
      });
      return lines;
    })
    .catch(() => {
      const inline = readArcgisInlineData();
      if (!inline || !inline.features) {
        return [];
      }
      const lines = [];
      inline.features.forEach((feature) => {
        if (!feature || !feature.geometry) {
          return;
        }
        const { type, coordinates } = feature.geometry;
        if (type === "LineString") {
          lines.push(
            coordinates.map((point) => [point[1], point[0]])
          );
        } else if (type === "MultiLineString") {
          coordinates.forEach((line) => {
            lines.push(line.map((point) => [point[1], point[0]]));
          });
        }
      });
      return lines;
    });
};

const loadWsprFilteredData = () => {
  return fetch("full_wspr_handshake_window_filtered.csv")
    .then((response) => response.text())
    .catch(() => readWsprFilteredInlineData());
};

const loadWsprData = () => {
  return fetch("wsprspots-2014-03-07-1600-2014-03-08-0100_wspr.csv")
    .then((response) => response.text())
    .catch(() => readWsprData());
};

const loadWsprFiltered2Data = () => {
  return fetch("full_wspr_handshake_window_filtered2.csv")
    .then((response) => response.text())
    .catch(() => readWsprFiltered2InlineData());
};

const loadWsprAnomaliesData = () => {
  return fetch("wspr_anomalies_z5.csv")
    .then((response) => response.text())
    .catch(() => readWsprAnomaliesInlineData());
};

const loadFlightPaths = () => {
  const arcgisUrl =
    "https://services1.arcgis.com/wfNKYeHsOyaFyPw3/arcgis/rest/services/Generalised_Flight_Path_Probabilities/FeatureServer/0/query?where=1%3D1&outFields=*&outSR=4326&f=geojson";

  const parseLines = (geojson) => {
    if (!geojson || !geojson.features) {
      return [];
    }
    const lines = [];
    geojson.features.forEach((feature) => {
      if (!feature || !feature.geometry) {
        return;
      }
      const { type, coordinates } = feature.geometry;
      if (type === "LineString") {
        lines.push(
          coordinates.map((point) => [point[1], point[0]])
        );
      } else if (type === "MultiLineString") {
        coordinates.forEach((line) => {
          lines.push(line.map((point) => [point[1], point[0]]));
        });
      }
    });
    return lines;
  };

  return fetch(arcgisUrl)
    .then((response) => response.json())
    .then(parseLines)
    .catch(() => {
      return fetch("arcgis_flight_paths.geojson")
        .then((response) => response.json())
        .then(parseLines)
        .catch(() => {
          const inline = readArcgisFlightInlineData();
          return parseLines(inline);
        });
    });
};

const applyFlightPathFit = () => {
  if (!state || !state.flightLines || !state.flightLines.length) {
    return;
  }
  const points = [];
  state.flightLines.forEach((line) => {
    line.forEach((point) => points.push(point));
  });
  if (!points.length) {
    return;
  }

  const getMedian = (values) => {
    if (!values.length) {
      return null;
    }
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2
      ? sorted[mid]
      : (sorted[mid - 1] + sorted[mid]) / 2;
  };

  state.arcs.forEach((arc) => {
    if (!arc.fitToFlightPaths || !arc.center) {
      return;
    }
    const latMin = arc.fitLatMin;
    const latMax = arc.fitLatMax;
    const bandKm = arc.fitBandKm;
    const distances = [];

    points.forEach((point) => {
      const lat = point[0];
      const lon = point[1];
      if (typeof latMin === "number" && lat < latMin) {
        return;
      }
      if (typeof latMax === "number" && lat > latMax) {
        return;
      }
      const distance = haversineDistanceKm(
        arc.center.lat,
        arc.center.lon,
        lat,
        lon,
        state.earthRadiusKm
      );
      if (typeof bandKm === "number" && Math.abs(distance - arc.radiusKm) > bandKm) {
        return;
      }
      distances.push(distance);
    });

    const medianDistance = getMedian(distances);
    if (medianDistance === null) {
      return;
    }
    const offsetKm = typeof arc.fitOffsetKm === "number" ? arc.fitOffsetKm : 0;
    const newRadius = medianDistance + offsetKm;
    arc.radiusKm = newRadius;
    arc.ringPoints = state.useWgs84
      ? circlePointsWgs84(arc.center, newRadius, 360)
      : circlePoints(arc.center, newRadius, 360);
  });
};

let state = null;
const interaction = {
  dragging: false,
  moved: false,
  start: null,
  startCenter: null,
  draggingLabel: false,
  labelDrag: null
};

const buildProjection = () => {
  const margin = 28;
  const radius = (Math.min(canvas.width, canvas.height) / 2 - margin) * state.zoom;
  const translate = [canvas.width / 2, canvas.height / 2];
  const projection = (lat, lon) =>
    projectOrthographic(
      state.center,
      lat,
      lon,
      radius,
      translate,
      state.flipView
    );
  return { projection, radius, translate };
};

const updateWsprSelectionText = (row) => {
  const el = document.getElementById("wspr-selection");
  if (!el) {
    return;
  }
  if (!row) {
    el.textContent = "Click a WSPR line near a node to inspect.";
    return;
  }
  const label = `${row.time} ${row.band} ${row.tx_sign}->${row.rx_sign}`;
  const snr = row.snr !== undefined ? ` SNR ${row.snr} dB` : "";
  const drift = row.drift !== undefined ? ` Drift ${row.drift}` : "";
  const dist = row.distance !== undefined ? ` Dist ${row.distance} km` : "";
  el.textContent = `${label}${snr}${drift}${dist}`;
};

const pickWsprRowAt = (x, y) => {
  if (!state) {
    return null;
  }
  const { projection } = buildProjection();
  const threshold = 30;
  const thresholdSq = threshold * threshold;
  let best = null;
  let bestDist = thresholdSq;

  const distanceToSegmentSq = (px, py, x1, y1, x2, y2) => {
    const dx = x2 - x1;
    const dy = y2 - y1;
    if (dx === 0 && dy === 0) {
      const ax = px - x1;
      const ay = py - y1;
      return ax * ax + ay * ay;
    }
    const t = ((px - x1) * dx + (py - y1) * dy) / (dx * dx + dy * dy);
    const clamped = Math.max(0, Math.min(1, t));
    const cx = x1 + clamped * dx;
    const cy = y1 + clamped * dy;
    const ax = px - cx;
    const ay = py - cy;
    return ax * ax + ay * ay;
  };

  const distanceToPolylineSq = (px, py, points) => {
    let bestSeg = Number.POSITIVE_INFINITY;
    for (let i = 1; i < points.length; i += 1) {
      const a = points[i - 1];
      const b = points[i];
      if (!a || !b) {
        continue;
      }
      const dist = distanceToSegmentSq(px, py, a[0], a[1], b[0], b[1]);
      if (dist < bestSeg) {
        bestSeg = dist;
      }
    }
    return bestSeg;
  };

  const considerRow = (row) => {
    const txLat = Number(row.tx_lat);
    const txLon = Number(row.tx_lon);
    const rxLat = Number(row.rx_lat);
    const rxLon = Number(row.rx_lon);
    const hasTx = Number.isFinite(txLat) && Number.isFinite(txLon);
    const hasRx = Number.isFinite(rxLat) && Number.isFinite(rxLon);
    if (Number.isFinite(txLat) && Number.isFinite(txLon)) {
      const projected = projection(txLat, txLon);
      if (projected) {
        const dx = projected[0] - x;
        const dy = projected[1] - y;
        const dist = dx * dx + dy * dy;
        if (dist < bestDist) {
          bestDist = dist;
          best = row;
        }
      }
    }
    if (Number.isFinite(rxLat) && Number.isFinite(rxLon)) {
      const projected = projection(rxLat, rxLon);
      if (projected) {
        const dx = projected[0] - x;
        const dy = projected[1] - y;
        const dist = dx * dx + dy * dy;
        if (dist < bestDist) {
          bestDist = dist;
          best = row;
        }
      }
    }

    if (hasTx && hasRx) {
      const curve = interpolateGreatCircle([txLat, txLon], [rxLat, rxLon], 128);
      const projectedCurve = curve.map((point) => projection(point[0], point[1]));
      const dist = distanceToPolylineSq(x, y, projectedCurve);
      if (dist < bestDist) {
        bestDist = dist;
        best = row;
      }
    }
  };

  if (state.showWspr) {
    state.wsprRows.forEach(considerRow);
  }
  if (state.showWsprFiltered) {
    state.wsprFilteredRows.forEach(considerRow);
  }

  if (state.showWsprFiltered2) {
    state.wsprFiltered2Rows.forEach(considerRow);
  }
  if (state.showWsprAnomalies) {
    state.wsprAnomalyRows.forEach(considerRow);
  }

  return best;
};

const render = () => {
  if (!state) {
    return;
  }

  resizeCanvas();
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const { projection, radius, translate } = buildProjection();
  state.lastProjection = projection;

  drawSphere(radius, translate);

  if (state.landRings.length) {
    state.landRings.forEach((ring) => {
      const projectedPoints = [];
      let hasHidden = false;

      ring.forEach((point) => {
        const projected = projection(point[0], point[1]);
        if (!projected) {
          hasHidden = true;
        }
        projectedPoints.push(projected);
      });

      if (!hasHidden) {
        ctx.fillStyle = "#f7f0e7";
        ctx.strokeStyle = "rgba(14, 26, 36, 0.2)";
        ctx.lineWidth = 0.6;
        ctx.beginPath();
        projectedPoints.forEach((point, idx) => {
          if (!point) {
            return;
          }
          if (idx === 0) {
            ctx.moveTo(point[0], point[1]);
          } else {
            ctx.lineTo(point[0], point[1]);
          }
        });
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        return;
      }

      ctx.strokeStyle = "rgba(14, 26, 36, 0.2)";
      ctx.lineWidth = 0.6;
      ctx.beginPath();
      let started = false;
      projectedPoints.forEach((point) => {
        if (!point) {
          if (started) {
            ctx.stroke();
            ctx.beginPath();
            started = false;
          }
          return;
        }
        if (!started) {
          ctx.moveTo(point[0], point[1]);
          started = true;
        } else {
          ctx.lineTo(point[0], point[1]);
        }
      });
      if (started) {
        ctx.stroke();
      }
    });
  }

  drawGraticule(projection);

  state.arcs.forEach((arc) => {
    if (!arc.visible) {
      return;
    }
    drawProjectedLine(
      arc.ringPoints,
      projection,
      arc.color,
      arc.lineWidth,
      arc.opacity,
      arc.dash
    );
  });

  if (state.referenceLines.length) {
    state.referenceLines.forEach((line) => {
      drawProjectedLine(
        line,
        projection,
        "#0ea5a4",
        2,
        0.7,
        [4, 6]
      );
    });
  }

  if (state.showFlightPaths && state.flightLines.length) {
    state.flightLines.forEach((line) => {
      drawProjectedLine(
        line,
        projection,
        "#9ab642",
        2,
        0.7,
        null
      );
    });
  }

  if (state.showMh370LatLon && state.mh370LatLonPoints.length) {
    drawProjectedLine(
      state.mh370LatLonPoints,
      projection,
      "#7c3aed",
      2,
      0.75,
      null
    );
    drawProjectedPoints(
      state.mh370LatLonPoints,
      projection,
      "#a855f7",
      2.4,
      0.9
    );
  }

  if (state.godfreyLayers.length) {
    const labelSpots = [];
    state.godfreyLayers.forEach((layer) => {
      if (!state[layer.visibleKey]) {
        return;
      }
      if (layer.ringPoints && layer.ringPoints.length) {
        drawProjectedPolygon(
          layer.ringPoints,
          projection,
          "rgba(219, 39, 119, 0.16)",
          0.9,
          "rgba(219, 39, 119, 0.75)",
          2
        );
      }
      drawProjectedPoints([layer.point], projection, layer.color, 3.4, 0.95);
      const offset = placeLabel(projection, layer.point, labelSpots, 20);
      drawMapLabel(layer.label, layer.point, projection, layer.color, offset);
    });
  }

  if (state.showFuelArea && state.fuelAreaPoints.length) {
    drawProjectedPolygon(
      state.fuelAreaPoints,
      projection,
      "rgba(34, 197, 94, 0.18)",
      0.9,
      "rgba(34, 197, 94, 0.65)",
      2
    );
  }

  if (state.showArc7Rect && state.arc7RectPoints.length) {
    drawProjectedPolygon(
      state.arc7RectPoints,
      projection,
      "rgba(14, 165, 233, 0.16)",
      0.9,
      "rgba(14, 165, 233, 0.7)",
      2
    );
  }

  if (state.showArc7PublicBand && state.arc7PublicBandPoints.length) {
    drawProjectedPolygon(
      state.arc7PublicBandPoints,
      projection,
      "rgba(20, 184, 166, 0.18)",
      0.9,
      "rgba(20, 184, 166, 0.7)",
      2
    );
  }

  if (state.showBrokenRidge && state.brokenRidgePoints.length) {
    drawProjectedPolygon(
      state.brokenRidgePoints,
      projection,
      "rgba(249, 115, 22, 0.18)",
      0.9,
      "rgba(249, 115, 22, 0.7)",
      2
    );
    if (state.brokenRidgeCenter) {
      drawProjectedPoints(
        [state.brokenRidgeCenter],
        projection,
        "#f97316",
        3.2,
        0.95
      );
    }
  }

  if (state.showOceanInfinity && state.oceanInfinityPaths.length) {
    state.oceanInfinityPaths.forEach((line) => {
      drawProjectedLine(
        line,
        projection,
        "rgba(59, 130, 246, 0.9)",
        2.2,
        0.9,
        [6, 6]
      );
    });
  }

  if (state.showOceanInfinityLive && state.oceanInfinityLivePaths.length) {
    state.oceanInfinityLivePaths.forEach((line) => {
      drawProjectedLine(
        line,
        projection,
        "rgba(234, 88, 12, 0.9)",
        2.2,
        0.9,
        [4, 6]
      );
    });
  }

  if (state.showOceanInfinityPhase1 && state.oceanInfinityPhase1Paths.length) {
    state.oceanInfinityPhase1Paths.forEach((line) => {
      drawProjectedLine(
        line,
        projection,
        "rgba(14, 116, 144, 0.9)",
        2.2,
        0.9,
        [3, 5]
      );
    });
  }

  if (state.showSeabedConstructor && state.seabedConstructorPaths.length) {
    state.seabedConstructorPaths.forEach((line) => {
      drawProjectedLine(
        line,
        projection,
        "rgba(255, 194, 0, 0.95)",
        2.2,
        0.9,
        [5, 6]
      );
    });
  }

  if (state.showOceanInfinitySearchAreas) {
    const areas = state.oceanInfinitySearchAreas;
    const labelSpots = [];
    const seenLabels = new Set();
    if (areas.polygons && areas.polygons.length) {
      areas.polygons.forEach((poly) => {
        const labelText = (poly.name || "Search Area").replace(/Ocean Infinity/gi, "OI");
        const colors = getAreaColor(labelText);
        const ringPoints = ensureClosedRing(poly.points || poly);
        drawProjectedPolygon(
          ringPoints,
          projection,
          colors.fill,
          0.9,
          colors.stroke,
          2
        );
        if (poly.name && poly.label) {
          if (seenLabels.has(labelText)) {
            return;
          }
          if (/arc\\s*7.*20000ft/i.test(labelText)) {
            return;
          }
          seenLabels.add(labelText);
          const offset = placeLabel(projection, poly.label, labelSpots, 20);
          const anchor = projection(poly.label[0], poly.label[1]);
          if (anchor) {
            const labelPos = [anchor[0] + 6 + offset[0], anchor[1] - 6 + offset[1]];
            drawLabelLeader(anchor, labelPos, "rgba(15, 23, 42, 0.55)");
          }
          drawMapLabel(labelText, poly.label, projection, colors.label, offset);
        }
      });
    }
    if (areas.lines && areas.lines.length) {
      areas.lines.forEach((line) => {
        const labelText = (line.name || "Search Line").replace(/Ocean Infinity/gi, "OI");
        const colors = getAreaColor(labelText);
        const linePoints = line.points || line;
        if (linePoints.length < 2) {
          drawProjectedPoints(linePoints, projection, colors.stroke, 4, 0.9);
        } else {
          drawProjectedLine(
            linePoints,
            projection,
            colors.stroke,
            2.2,
            0.9,
            [3, 5]
          );
        }
        const closedLine = ensureClosedRing(linePoints);
        const bounds = closedLine ? ringBounds(closedLine) : null;
        const canFill =
          bounds &&
          bounds.spanLat < 15 &&
          bounds.spanLon < 30;
        if (canFill) {
          drawProjectedPolygon(
            closedLine,
            projection,
            colors.fill,
            0.6,
            colors.stroke,
            1.6
          );
        }
        if (line.name && line.label) {
          if (seenLabels.has(labelText)) {
            return;
          }
          if (/arc\\s*7.*20000ft/i.test(labelText)) {
            return;
          }
          seenLabels.add(labelText);
          const offset = placeLabel(projection, line.label, labelSpots, 20);
          const anchor = projection(line.label[0], line.label[1]);
          if (anchor) {
            const labelPos = [anchor[0] + 6 + offset[0], anchor[1] - 6 + offset[1]];
            drawLabelLeader(anchor, labelPos, "rgba(15, 23, 42, 0.55)");
          }
          drawMapLabel(labelText, line.label, projection, colors.label, offset);
        }
      });
    }
  }


  const fresnelRows = state.showWsprFiltered
    ? state.wsprFilteredRows
    : (state.showWsprFiltered2 ? state.wsprFiltered2Rows : []);
  if (state.showWsprFresnel && fresnelRows.length) {
    const fresnelWidthPx = Math.max(
      1,
      (FRESNEL_HALF_WIDTH_KM / state.earthRadiusKm) * radius * 2
    );
    fresnelRows.forEach((row) => {
      const txLat = Number(row.tx_lat);
      const txLon = Number(row.tx_lon);
      const rxLat = Number(row.rx_lat);
      const rxLon = Number(row.rx_lon);
      const hasTx = Number.isFinite(txLat) && Number.isFinite(txLon);
      const hasRx = Number.isFinite(rxLat) && Number.isFinite(rxLon);
      if (!hasTx || !hasRx) {
        return;
      }
      const curve = interpolateGreatCircle([txLat, txLon], [rxLat, rxLon], 96);
      drawProjectedLine(
        curve,
        projection,
        "#f59e0b",
        fresnelWidthPx,
        0.12,
        null
      );
    });
  }

  if (state.adsbPoints.length > 1) {
    drawProjectedLine(state.adsbPoints, projection, "#111827", 2, 0.8);
    state.adsbPoints.forEach((point, idx) => {
      const projected = projection(point[0], point[1]);
      if (!projected) {
        return;
      }
      ctx.beginPath();
      ctx.arc(projected[0], projected[1], idx === 0 ? 4 : 2, 0, Math.PI * 2);
      ctx.fillStyle = "#f2a65a";
      ctx.strokeStyle = "#111827";
      ctx.lineWidth = 1;
      ctx.fill();
      ctx.stroke();
    });
  }

  if (state.showAircrafts && state.aircraftPoints.length) {
    state.aircraftPoints.forEach((point) => {
      const projected = projection(point[0], point[1]);
      if (!projected) {
        return;
      }
      ctx.beginPath();
      ctx.arc(projected[0], projected[1], 2, 0, Math.PI * 2);
      ctx.fillStyle = "#f2a65a";
      ctx.strokeStyle = "#111827";
      ctx.lineWidth = 1;
      ctx.fill();
      ctx.stroke();
    });
  }

  if (state.showMatlab && state.matlabLinks.length) {
    state.matlabLinks.forEach((link) => {
      const curve = interpolateGreatCircle(
        [link.txLat, link.txLon],
        [link.rxLat, link.rxLon],
        96
      );
      const hitsBounds =
        inMatlabBounds(link.txLat, link.txLon) ||
        inMatlabBounds(link.rxLat, link.rxLon) ||
        curve.some((point) => inMatlabBounds(point[0], point[1]));
      if (!hitsBounds) {
        return;
      }
      drawProjectedLine(
        curve,
        projection,
        link.color || "#000000",
        1.4,
        0.5,
        link.rev === "1" ? [6, 4] : null
      );
    });
  }

  if (state.showCandidates && state.candidateLinks.length) {
    state.candidateLinks.forEach((link) => {
      const curve = interpolateGreatCircle(
        [link.txLat, link.txLon],
        [link.rxLat, link.rxLon],
        96
      );
      drawProjectedLine(curve, projection, "#10b981", 1.6, 0.75, null);
    });
  }

  if (state.showWspr) {
    state.wsprRows.forEach((row) => {
      const txLat = Number(row.tx_lat);
      const txLon = Number(row.tx_lon);
      const rxLat = Number(row.rx_lat);
      const rxLon = Number(row.rx_lon);
      const hasTx = Number.isFinite(txLat) && Number.isFinite(txLon);
      const hasRx = Number.isFinite(rxLat) && Number.isFinite(rxLon);
      const rowKey = getWsprRowKey(row);
      const isSelected = state.selectedWsprKey === rowKey;
      let curve = null;
      if (hasTx && hasRx) {
        curve = interpolateGreatCircle([txLat, txLon], [rxLat, rxLon], 96);
        drawProjectedLine(
          curve,
          projection,
          isSelected ? "#111827" : "#1f2937",
          isSelected ? 2.2 : 1,
          isSelected ? 0.8 : 0.2
        );
        if (state.showWsprLongPath && isInLongPathWindow(row)) {
          const longCurve = interpolateGreatCircleLong([txLat, txLon], [rxLat, rxLon], 96);
          drawProjectedLine(
            longCurve,
            projection,
            isSelected ? "#6b7280" : "#9ca3af",
            isSelected ? 1.6 : 0.8,
            isSelected ? 0.7 : 0.25,
            [4, 6]
          );
        }

        // Intentionally skip hop markers for a cleaner WSPR render.
      }

      if (hasTx) {
        const projected = projection(txLat, txLon);
        if (projected) {
          ctx.beginPath();
          ctx.arc(projected[0], projected[1], isSelected ? 3 : 2, 0, Math.PI * 2);
          ctx.fillStyle = "#d45d3f";
          ctx.globalAlpha = isSelected ? 0.9 : 0.6;
          ctx.fill();
          ctx.globalAlpha = 1;
          if (state.showWsprLabels && isSelected) {
            drawWsprNodeLabel(row, txLat, txLon, projection, "tx", "#111827");
          }
        }
      }

      if (hasRx) {
        const projected = projection(rxLat, rxLon);
        if (projected) {
          ctx.beginPath();
          ctx.arc(projected[0], projected[1], isSelected ? 3 : 2, 0, Math.PI * 2);
          ctx.fillStyle = "#14746f";
          ctx.globalAlpha = isSelected ? 0.9 : 0.6;
          ctx.fill();
          ctx.globalAlpha = 1;
          if (state.showWsprLabels && isSelected) {
            drawWsprNodeLabel(row, rxLat, rxLon, projection, "rx", "#111827");
          }
        }
      }
    });
  }

  if (state.showWsprFiltered) {
    state.wsprFilteredRows.forEach((row) => {
      const txLat = Number(row.tx_lat);
      const txLon = Number(row.tx_lon);
      const rxLat = Number(row.rx_lat);
      const rxLon = Number(row.rx_lon);
      const hasTx = Number.isFinite(txLat) && Number.isFinite(txLon);
      const hasRx = Number.isFinite(rxLat) && Number.isFinite(rxLon);
      const rowKey = getWsprRowKey(row);
      const isSelected = state.selectedWsprKey === rowKey;
      let curve = null;
      if (hasTx && hasRx) {
        curve = interpolateGreatCircle([txLat, txLon], [rxLat, rxLon], 96);
        drawProjectedLine(
          curve,
          projection,
          isSelected ? "#b91c1c" : "#ef4444",
          isSelected ? 3 : 2,
          isSelected ? 0.95 : 0.7,
          [6, 6]
        );
        if (state.showWsprLongPath && isInLongPathWindow(row)) {
          const longCurve = interpolateGreatCircleLong([txLat, txLon], [rxLat, rxLon], 96);
          drawProjectedLine(
            longCurve,
            projection,
            isSelected ? "#f97316" : "#f59e0b",
            isSelected ? 2.2 : 1.2,
            isSelected ? 0.8 : 0.4,
            [4, 6]
          );
        }
        if (state.showWsprLongPath && isInLongPathWindow(row)) {
          const longCurve = interpolateGreatCircleLong([txLat, txLon], [rxLat, rxLon], 96);
          drawProjectedLine(
            longCurve,
            projection,
            isSelected ? "#f97316" : "#f59e0b",
            isSelected ? 2.2 : 1.2,
            isSelected ? 0.8 : 0.4,
            [4, 6]
          );
        }
        if (state.showWsprLabels && isSelected) {
          if (hasTx) {
            drawWsprNodeLabel(row, txLat, txLon, projection, "tx", "#111827");
          }
          if (hasRx) {
            drawWsprNodeLabel(row, rxLat, rxLon, projection, "rx", "#111827");
          }
        }
      }

      if (hasTx) {
        const projected = projection(txLat, txLon);
        if (projected) {
          ctx.beginPath();
          ctx.arc(projected[0], projected[1], isSelected ? 3.5 : 2.5, 0, Math.PI * 2);
          ctx.fillStyle = "#ef4444";
          ctx.globalAlpha = isSelected ? 1 : 0.9;
          ctx.fill();
          ctx.globalAlpha = 1;
        }
      }

      if (hasRx) {
        const projected = projection(rxLat, rxLon);
        if (projected) {
          ctx.beginPath();
          ctx.arc(projected[0], projected[1], isSelected ? 3.5 : 2.5, 0, Math.PI * 2);
          ctx.fillStyle = "#f97316";
          ctx.globalAlpha = isSelected ? 1 : 0.9;
          ctx.fill();
          ctx.globalAlpha = 1;
        }
      }
    });
  }

  if (state.showWsprFiltered2) {
    state.wsprFiltered2Rows.forEach((row) => {
      const txLat = Number(row.tx_lat);
      const txLon = Number(row.tx_lon);
      const rxLat = Number(row.rx_lat);
      const rxLon = Number(row.rx_lon);
      const hasTx = Number.isFinite(txLat) && Number.isFinite(txLon);
      const hasRx = Number.isFinite(rxLat) && Number.isFinite(rxLon);
      const rowKey = getWsprRowKey(row);
      const isSelected = state.selectedWsprKey === rowKey;
      let curve = null;
      if (hasTx && hasRx) {
        curve = interpolateGreatCircle([txLat, txLon], [rxLat, rxLon], 96);
        drawProjectedLine(
          curve,
          projection,
          isSelected ? "#b91c1c" : "#ef4444",
          isSelected ? 3 : 2,
          isSelected ? 0.95 : 0.7,
          [6, 6]
        );
        if (state.showWsprLabels && isSelected) {
          if (hasTx) {
            drawWsprNodeLabel(row, txLat, txLon, projection, "tx", "#111827");
          }
          if (hasRx) {
            drawWsprNodeLabel(row, rxLat, rxLon, projection, "rx", "#111827");
          }
        }
      }

      if (hasTx) {
        const projected = projection(txLat, txLon);
        if (projected) {
          ctx.beginPath();
          ctx.arc(projected[0], projected[1], isSelected ? 3.5 : 2.5, 0, Math.PI * 2);
          ctx.fillStyle = "#ef4444";
          ctx.globalAlpha = isSelected ? 1 : 0.9;
          ctx.fill();
          ctx.globalAlpha = 1;
        }
      }

      if (hasRx) {
        const projected = projection(rxLat, rxLon);
        if (projected) {
          ctx.beginPath();
          ctx.arc(projected[0], projected[1], isSelected ? 3.5 : 2.5, 0, Math.PI * 2);
          ctx.fillStyle = "#f97316";
          ctx.globalAlpha = isSelected ? 1 : 0.9;
          ctx.fill();
          ctx.globalAlpha = 1;
        }
      }
    });
  }

  if (state.showHopPoints && state.wsprFiltered2Rows.length) {
    state.wsprFiltered2Rows.forEach((row) => {
      const txLat = Number(row.tx_lat);
      const txLon = Number(row.tx_lon);
      const rxLat = Number(row.rx_lat);
      const rxLon = Number(row.rx_lon);
      const hasTx = Number.isFinite(txLat) && Number.isFinite(txLon);
      const hasRx = Number.isFinite(rxLat) && Number.isFinite(rxLon);
      if (!hasTx || !hasRx) {
        return;
      }
      const start = [txLat, txLon];
      const end = [rxLat, rxLon];
      const hopPoints = [
        greatCirclePointAtFraction(start, end, 1 / 3),
        greatCirclePointAtFraction(start, end, 1 / 2),
        greatCirclePointAtFraction(start, end, 2 / 3)
      ];
      hopPoints.forEach((point) => {
        const projected = projection(point[0], point[1]);
        if (!projected) {
          return;
        }
        ctx.beginPath();
        ctx.arc(projected[0], projected[1], 3, 0, Math.PI * 2);
        ctx.fillStyle = "#7c3aed";
        ctx.globalAlpha = 0.85;
        ctx.fill();
        ctx.globalAlpha = 1;
      });
    });
  }

  if (state.showWsprAnomalies) {
    const visibleArcs = state.arcs.filter((arc) => arc.visible);
    const anomalyRows = state.showWsprAnomaliesNearArc
      ? state.wsprAnomalyRows.filter((row) => anomalyNearVisibleArc(row, visibleArcs))
      : state.wsprAnomalyRows;
    anomalyRows.forEach((row) => {
      const txLat = Number(row.tx_lat);
      const txLon = Number(row.tx_lon);
      const rxLat = Number(row.rx_lat);
      const rxLon = Number(row.rx_lon);
      const hasTx = Number.isFinite(txLat) && Number.isFinite(txLon);
      const hasRx = Number.isFinite(rxLat) && Number.isFinite(rxLon);
      const rowKey = getWsprRowKey(row);
      const isSelected = state.selectedWsprKey === rowKey;
      if (hasTx && hasRx) {
        const curve = interpolateGreatCircle([txLat, txLon], [rxLat, rxLon], 96);
        drawProjectedLine(
          curve,
          projection,
          isSelected ? "#9f1239" : "#e11d48",
          isSelected ? 3 : 1.8,
          isSelected ? 0.95 : 0.75,
          [3, 6]
        );
        if (state.showWsprLongPath && isInLongPathWindow(row)) {
          const longCurve = interpolateGreatCircleLong([txLat, txLon], [rxLat, rxLon], 96);
          drawProjectedLine(
            longCurve,
            projection,
            isSelected ? "#f97316" : "#f59e0b",
            isSelected ? 2.2 : 1.2,
            isSelected ? 0.8 : 0.4,
            [4, 6]
          );
        }
      }
    });
  }

  if (
    state.showWsprLongPath &&
    !state.showWspr &&
    !state.showWsprFiltered &&
    !state.showWsprFiltered2 &&
    !state.showWsprAnomalies
  ) {
    const longRows = state.longPathRows.length ? state.longPathRows : state.wsprRows;
    longRows.forEach((row) => {
      if (!isInLongPathWindow(row)) {
        return;
      }
      const txLat = Number(row.tx_lat);
      const txLon = Number(row.tx_lon);
      const rxLat = Number(row.rx_lat);
      const rxLon = Number(row.rx_lon);
      const hasTx = Number.isFinite(txLat) && Number.isFinite(txLon);
      const hasRx = Number.isFinite(rxLat) && Number.isFinite(rxLon);
      if (!hasTx || !hasRx) {
        return;
      }
      const longCurve = interpolateGreatCircleLong([txLat, txLon], [rxLat, rxLon], 96);
      const style = anomalyStyle(row);
      drawProjectedLine(longCurve, projection, style.color, style.width, style.alpha, [4, 6]);
    });
  }

  const projectedTarget = projection(-29.128, 99.934);
  if (projectedTarget) {
    ctx.beginPath();
    ctx.arc(projectedTarget[0], projectedTarget[1], 6, 0, Math.PI * 2);
    ctx.fillStyle = "#f59e0b";
    ctx.strokeStyle = "#111827";
    ctx.lineWidth = 2;
    ctx.fill();
    ctx.stroke();
  }
};

loadArcsData()
  .then((data) => {
    const listEl = document.getElementById("arc-list");
    const center = data.meta && data.meta.center ? data.meta.center : { lat: 0, lon: 0 };
    const rangeScale =
      data.meta && typeof data.meta.range_scale === "number"
        ? data.meta.range_scale
        : 1;
    const btoBiasUs =
      data.meta && typeof data.meta.bto_bias_us === "number"
        ? data.meta.bto_bias_us
        : 0;
    const groundRangeOffsetKm =
      data.meta && typeof data.meta.ground_range_offset_km === "number"
        ? data.meta.ground_range_offset_km
        : 0;
    const groundRangeScale =
      data.meta && typeof data.meta.ground_range_scale === "number"
        ? data.meta.ground_range_scale
        : 1;
    const useWgs84 = data.meta && data.meta.use_wgs84 === true;
    const earthRadiusKm = useWgs84 ? WGS84_AUTHALIC_RADIUS_KM : EARTH_RADIUS_KM;
    const satAltKm =
      data.meta && typeof data.meta.sat_alt_km === "number"
        ? data.meta.sat_alt_km
        : 35786;
    const arcgisCenter =
      data.meta && data.meta.arcgis_center
        ? {
            lat: Number(data.meta.arcgis_center.lat) || 0,
            lon: Number(data.meta.arcgis_center.lon) || 0
          }
        : null;
    const centersByArc =
      data.meta && data.meta.centers_by_arc ? data.meta.centers_by_arc : {};
    const useArcgisCenter =
      data.meta && data.meta.use_arcgis_center === true && arcgisCenter;
    const subpointOffset =
      data.meta && data.meta.subpoint_offset
        ? {
            lat: Number(data.meta.subpoint_offset.lat) || 0,
            lon: Number(data.meta.subpoint_offset.lon) || 0
          }
        : { lat: 0, lon: 0 };

    const arcs = data.arcs.map((arc, idx) => {
      const isR600 = arc.channel && arc.channel.toUpperCase() === "R600";
      const baseBto = arc.bto_us + btoBiasUs;
      const adjustedBto = isR600 ? baseBto - 4600 : baseBto;
      const slantKm = btoToSlantRangeKm(adjustedBto) * rangeScale;
      const baseRadiusKm =
        arc.radius_km ||
        slantRangeToGroundKm(slantKm, satAltKm, earthRadiusKm);
      const radiusKm = baseRadiusKm * groundRangeScale + groundRangeOffsetKm;
      const timeKey = arc.time_utc ? arc.time_utc.slice(0, 5) : null;
      const centerOverride = arc.center_override
        ? {
            lat: Number(arc.center_override.lat),
            lon: Number(arc.center_override.lon)
          }
        : null;
      const metaCenter = centersByArc[arc.id]
        ? {
            lat: Number(centersByArc[arc.id].lat),
            lon: Number(centersByArc[arc.id].lon)
          }
        : null;
      const subpoint =
        arc.center || centerOverride || metaCenter
          ? null
          : getSubpointForTime(timeKey);
      const adjustedSubpoint = subpoint
        ? {
            lat: subpoint.lat + subpointOffset.lat,
            lon: subpoint.lon + subpointOffset.lon,
            quality: subpoint.quality
          }
        : null;
      const arcCenter =
        arc.center ||
        centerOverride ||
        metaCenter ||
        (useArcgisCenter ? arcgisCenter : adjustedSubpoint || center);
      const isLogon = arc.logon === true;
      const color = arc.color || palette[idx % palette.length];
      const fitToFlightPaths = arc.fit_to_flight_paths === true;
      const fitLatMin =
        typeof arc.fit_lat_min === "number" ? arc.fit_lat_min : null;
      const fitLatMax =
        typeof arc.fit_lat_max === "number" ? arc.fit_lat_max : null;
      const fitBandKm =
        typeof arc.fit_band_km === "number" ? arc.fit_band_km : null;
      const fitOffsetKm =
        typeof arc.fit_offset_km === "number" ? arc.fit_offset_km : 0;
      return {
        id: arc.id,
        time: arc.time_utc,
        bto_us: arc.bto_us,
        channel: arc.channel,
        radiusKm,
        center: arcCenter,
        ringPoints: useWgs84
          ? circlePointsWgs84(arcCenter, radiusKm, 360)
          : circlePoints(arcCenter, radiusKm, 360),
        lineWidth: 2,
        opacity: 0.9,
        dash: null,
        color,
        note: isLogon ? "logon corrected" : null,
        visible: true,
        fitToFlightPaths,
        fitLatMin,
        fitLatMax,
        fitBandKm,
        fitOffsetKm
      };
    });

    const adsbPoints = readAdsbData();
    const aircraftPoints = [];
    const matlabLinks = [];
    const candidateLinks = [];
    const wsprRows = parseWsprData(readWsprData());
    const wsprFilteredRows = parseWsprData(readWsprFilteredInlineData());
    const wsprFiltered2Rows = parseWsprData(readWsprFiltered2InlineData());
    const wsprAnomalyRows = parseWsprData(readWsprAnomaliesInlineData());
    const longPathRows = [];
    const landRings = decodeLandTopojson(readLandData());
    state = {
      center,
      arcs,
      adsbPoints,
      aircraftPoints,
      matlabLinks,
      candidateLinks,
      wsprRows,
      wsprFilteredRows,
      wsprFiltered2Rows,
      wsprAnomalyRows,
      longPathRows,
      landRings,
      referenceLines: [],
      flightLines: [],
      mh370LatLonPoints: [],
      godfreyLayers: buildGodfreyLayers(useWgs84),
      fuelAreaPoints: [],
      arc7RectPoints: [],
      arc7PublicBandPoints: [],
      brokenRidgePoints: [],
      brokenRidgeCenter: null,
      oceanInfinityPaths: [],
      oceanInfinityLivePaths: [],
      oceanInfinityPhase1Paths: [],
      seabedConstructorPaths: [],
      oceanInfinitySearchAreas: { polygons: [], lines: [] },
      zoom: 1,
      showWspr: false,
      showWsprLabels: false,
      showWsprLongPath: false,
      showWsprFiltered: true,
      showWsprFiltered2: false,
      showHopPoints: false,
      showWsprAnomalies: false,
      showWsprAnomaliesNearArc: false,
      showWsprFresnel: false,
      showFlightPaths: true,
      showMh370LatLon: false,
      showGodfrey1: false,
      showGodfrey2: false,
      showGodfrey3: false,
      showFuelArea: false,
      showArc7Rect: false,
      showArc7PublicBand: false,
      showBrokenRidge: false,
      showOceanInfinity: false,
      showOceanInfinityLive: false,
      showOceanInfinityPhase1: false,
      showSeabedConstructor: false,
      showOceanInfinitySearchAreas: false,
      showAircrafts: false,
      showMatlab: false,
      showCandidates: false,
      selectedWsprKey: null,
      selectedWsprRow: null,
      labelOffsets: {},
      flipView: false,
      defaultCenter: { ...center },
      defaultZoom: 1,
      useWgs84,
      earthRadiusKm,
      lastProjection: null
    };

    state.godfreyLayers = state.godfreyLayers.map((layer) => ({
      ...layer,
      visibleKey: `show${layer.label}`
    }));

    if (listEl) {
      listEl.innerHTML = "";
      arcs.forEach((arc, idx) => {
        addArcItem(arc, arc.color, listEl, idx, (visible) => {
          arc.visible = visible;
          render();
        });
      });
    }

    const wsprToggle = document.getElementById("toggle-wspr");
    if (wsprToggle) {
      wsprToggle.checked = false;
      wsprToggle.addEventListener("change", () => {
        state.showWspr = wsprToggle.checked;
        render();
      });
    }

    const wsprLabelsToggle = document.getElementById("toggle-wspr-labels");
    if (wsprLabelsToggle) {
      wsprLabelsToggle.checked = false;
      wsprLabelsToggle.addEventListener("change", () => {
        state.showWsprLabels = wsprLabelsToggle.checked;
        render();
      });
    }

    const wsprLongPathToggle = document.getElementById("toggle-wspr-longpath");
    if (wsprLongPathToggle) {
      wsprLongPathToggle.checked = false;
      wsprLongPathToggle.addEventListener("change", () => {
        state.showWsprLongPath = wsprLongPathToggle.checked;
        render();
      });
    }

    const wsprFilteredToggle = document.getElementById("toggle-wspr-filtered");
    if (wsprFilteredToggle) {
      wsprFilteredToggle.checked = true;
      wsprFilteredToggle.addEventListener("change", () => {
        state.showWsprFiltered = wsprFilteredToggle.checked;
        render();
      });
    }

    const wsprFiltered2Toggle = document.getElementById("toggle-wspr-filtered2");
    if (wsprFiltered2Toggle) {
      wsprFiltered2Toggle.checked = false;
      wsprFiltered2Toggle.addEventListener("change", () => {
        state.showWsprFiltered2 = wsprFiltered2Toggle.checked;
        render();
      });
    }

    const hopPointsToggle = document.getElementById("toggle-hop-points");
    if (hopPointsToggle) {
      hopPointsToggle.checked = false;
      hopPointsToggle.addEventListener("change", () => {
        state.showHopPoints = hopPointsToggle.checked;
        render();
      });
    }

    const wsprAnomaliesToggle = document.getElementById("toggle-wspr-anomalies");
    if (wsprAnomaliesToggle) {
      wsprAnomaliesToggle.checked = false;
      wsprAnomaliesToggle.addEventListener("change", () => {
        state.showWsprAnomalies = wsprAnomaliesToggle.checked;
        render();
      });
    }

    const wsprAnomaliesNearArcToggle = document.getElementById(
      "toggle-wspr-anomalies-near-arc"
    );
    if (wsprAnomaliesNearArcToggle) {
      wsprAnomaliesNearArcToggle.checked = false;
      wsprAnomaliesNearArcToggle.addEventListener("change", () => {
        state.showWsprAnomaliesNearArc = wsprAnomaliesNearArcToggle.checked;
        render();
      });
    }

    const wsprFresnelToggle = document.getElementById("toggle-wspr-fresnel");
    if (wsprFresnelToggle) {
      wsprFresnelToggle.checked = false;
      wsprFresnelToggle.addEventListener("change", () => {
        state.showWsprFresnel = wsprFresnelToggle.checked;
        render();
      });
    }

    const flightToggle = document.getElementById("toggle-flight-paths");
    if (flightToggle) {
      flightToggle.checked = true;
      flightToggle.addEventListener("change", () => {
        state.showFlightPaths = flightToggle.checked;
        render();
      });
    }

    const mh370LatLonToggle = document.getElementById("toggle-mh370-latlon");
    if (mh370LatLonToggle) {
      mh370LatLonToggle.checked = false;
      mh370LatLonToggle.addEventListener("change", () => {
        state.showMh370LatLon = mh370LatLonToggle.checked;
        render();
      });
    }

    const godfrey1Toggle = document.getElementById("toggle-godfrey-1");
    if (godfrey1Toggle) {
      godfrey1Toggle.checked = false;
      godfrey1Toggle.addEventListener("change", () => {
        state.showGodfrey1 = godfrey1Toggle.checked;
        render();
      });
    }

    const godfrey2Toggle = document.getElementById("toggle-godfrey-2");
    if (godfrey2Toggle) {
      godfrey2Toggle.checked = false;
      godfrey2Toggle.addEventListener("change", () => {
        state.showGodfrey2 = godfrey2Toggle.checked;
        render();
      });
    }

    const godfrey3Toggle = document.getElementById("toggle-godfrey-3");
    if (godfrey3Toggle) {
      godfrey3Toggle.checked = false;
      godfrey3Toggle.addEventListener("change", () => {
        state.showGodfrey3 = godfrey3Toggle.checked;
        render();
      });
    }

    const fuelAreaToggle = document.getElementById("toggle-fuel-area");
    if (fuelAreaToggle) {
      fuelAreaToggle.checked = false;
      fuelAreaToggle.addEventListener("change", () => {
        state.showFuelArea = fuelAreaToggle.checked;
        render();
      });
    }

    const arc7RectToggle = document.getElementById("toggle-arc7-rect");
    if (arc7RectToggle) {
      arc7RectToggle.checked = false;
      arc7RectToggle.addEventListener("change", () => {
        state.showArc7Rect = arc7RectToggle.checked;
        render();
      });
    }

    const arc7PublicBandToggle = document.getElementById("toggle-arc7-public-band");
    if (arc7PublicBandToggle) {
      arc7PublicBandToggle.checked = false;
      arc7PublicBandToggle.addEventListener("change", () => {
        state.showArc7PublicBand = arc7PublicBandToggle.checked;
        render();
      });
    }

    const brokenRidgeToggle = document.getElementById("toggle-broken-ridge");
    if (brokenRidgeToggle) {
      brokenRidgeToggle.checked = false;
      brokenRidgeToggle.addEventListener("change", () => {
        state.showBrokenRidge = brokenRidgeToggle.checked;
        render();
      });
    }

    const oceanInfinityToggle = document.getElementById("toggle-oi-2025");
    if (oceanInfinityToggle) {
      oceanInfinityToggle.checked = false;
      oceanInfinityToggle.addEventListener("change", () => {
        state.showOceanInfinity = oceanInfinityToggle.checked;
        render();
      });
    }

    const oceanInfinityLiveToggle = document.getElementById("toggle-oi-live");
    if (oceanInfinityLiveToggle) {
      oceanInfinityLiveToggle.checked = false;
      oceanInfinityLiveToggle.addEventListener("change", () => {
        state.showOceanInfinityLive = oceanInfinityLiveToggle.checked;
        render();
      });
    }

    const oceanInfinityPhase1Toggle = document.getElementById("toggle-oi-phase1");
    if (oceanInfinityPhase1Toggle) {
      oceanInfinityPhase1Toggle.checked = false;
      oceanInfinityPhase1Toggle.addEventListener("change", () => {
        state.showOceanInfinityPhase1 = oceanInfinityPhase1Toggle.checked;
        render();
      });
    }

    const seabedConstructorToggle = document.getElementById("toggle-seabed-constructor");
    if (seabedConstructorToggle) {
      seabedConstructorToggle.checked = false;
      seabedConstructorToggle.addEventListener("change", () => {
        state.showSeabedConstructor = seabedConstructorToggle.checked;
        render();
      });
    }

    const oceanInfinitySearchToggle = document.getElementById("toggle-oi-search-areas");
    if (oceanInfinitySearchToggle) {
      oceanInfinitySearchToggle.checked = false;
      oceanInfinitySearchToggle.addEventListener("change", () => {
        state.showOceanInfinitySearchAreas = oceanInfinitySearchToggle.checked;
        render();
      });
    }


    const aircraftsToggle = document.getElementById("toggle-aircrafts");
    if (aircraftsToggle) {
      aircraftsToggle.checked = false;
      aircraftsToggle.addEventListener("change", () => {
        state.showAircrafts = aircraftsToggle.checked;
        render();
      });
    }

    const candidatesToggle = document.getElementById("toggle-candidates");
    if (candidatesToggle) {
      candidatesToggle.checked = false;
      candidatesToggle.addEventListener("change", () => {
        state.showCandidates = candidatesToggle.checked;
        render();
      });
    }

    const resetButton = document.getElementById("reset-view");
    if (resetButton) {
      resetButton.addEventListener("click", () => {
        state.center = { ...state.defaultCenter };
        state.zoom = state.defaultZoom;
        render();
      });
    }

    const flipToggle = document.getElementById("toggle-flip");
    if (flipToggle) {
      flipToggle.checked = state.flipView;
      flipToggle.addEventListener("change", () => {
        state.flipView = flipToggle.checked;
        render();
      });
    }

    const zoomInBtn = document.getElementById("zoom-in");
    if (zoomInBtn) {
      zoomInBtn.addEventListener("click", () => {
      state.zoom = Math.min(32, state.zoom + 0.2);
      render();
    });
  }

    const zoomOutBtn = document.getElementById("zoom-out");
    if (zoomOutBtn) {
      zoomOutBtn.addEventListener("click", () => {
        state.zoom = Math.max(0.5, state.zoom - 0.2);
        render();
      });
    }

    canvas.addEventListener("mousedown", (event) => {
      const rect = canvas.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;

      if (state.showWsprLabels && state.selectedWsprRow) {
        const hit = pickWsprLabelAt(x, y);
        if (hit) {
          const rowKey = getWsprRowKey(hit.row);
          const current = getWsprLabelOffset(rowKey, hit.side);
          interaction.draggingLabel = true;
          interaction.moved = true;
          interaction.labelDrag = {
            key: rowKey,
            side: hit.side,
            startX: x,
            startY: y,
            startOffset: { ...current }
          };
          return;
        }
      }

      interaction.dragging = true;
      interaction.moved = false;
      interaction.start = { x: event.clientX, y: event.clientY };
      interaction.startCenter = { ...state.center };
    });

    window.addEventListener("mouseup", () => {
      interaction.dragging = false;
      interaction.draggingLabel = false;
      interaction.labelDrag = null;
    });

    window.addEventListener("mousemove", (event) => {
      if (interaction.draggingLabel && interaction.labelDrag) {
        const rect = canvas.getBoundingClientRect();
        const x = event.clientX - rect.left;
        const y = event.clientY - rect.top;
        const dx = x - interaction.labelDrag.startX;
        const dy = y - interaction.labelDrag.startY;
        const { key, side, startOffset } = interaction.labelDrag;
        if (!state.labelOffsets[key]) {
          state.labelOffsets[key] = {};
        }
        state.labelOffsets[key][side] = {
          x: startOffset.x + dx,
          y: startOffset.y + dy
        };
        render();
        return;
      }

      if (!interaction.dragging || !interaction.start || !interaction.startCenter) {
        return;
      }
      interaction.moved = true;
      const dx = event.clientX - interaction.start.x;
      const dy = event.clientY - interaction.start.y;
      const lonPerPx = 180 / canvas.width;
      const latPerPx = 90 / canvas.height;
      const dragFlip = state.flipView ? -1 : 1;
      const newLon = interaction.startCenter.lon - dx * lonPerPx * dragFlip;
      const newLat = interaction.startCenter.lat + dy * latPerPx;
      state.center = {
        lat: Math.max(-85, Math.min(85, newLat)),
        lon: ((newLon + 540) % 360) - 180
      };
      render();
    });

    canvas.addEventListener("wheel", (event) => {
      event.preventDefault();
      const direction = event.deltaY > 0 ? -0.1 : 0.1;
      state.zoom = Math.min(32, Math.max(0.5, state.zoom + direction));
      render();
    }, { passive: false });

    canvas.addEventListener("click", (event) => {
      if (interaction.moved || interaction.draggingLabel) {
        return;
      }
      const rect = canvas.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;
      const row = pickWsprRowAt(x, y);
      state.selectedWsprRow = row;
      state.selectedWsprKey = row ? getWsprRowKey(row) : null;
      updateWsprSelectionText(row);
      render();
    });

    loadReferenceArc().then((referenceLines) => {
      state.referenceLines = referenceLines;
      render();
    });
    loadFlightPaths().then((flightLines) => {
      state.flightLines = flightLines;
      applyFlightPathFit();
      state.arc7RectPoints = computeArc7Band(state);
      state.arc7PublicBandPoints = computeArc7PublicBand(state);
      render();
    });
    loadMh370LatLonPoints().then((points) => {
      state.mh370LatLonPoints = points;
      render();
    });
    loadFuelArea().then((area) => {
      if (!area || !area.start_point || !Number.isFinite(area.radius_km)) {
        return;
      }
      const points = state.useWgs84
        ? circlePointsWgs84(area.start_point, area.radius_km, 360)
        : circlePoints(area.start_point, area.radius_km, 360);
      state.fuelAreaPoints = points;
      render();
    });
    state.arc7RectPoints = computeArc7Band(state);
    state.arc7PublicBandPoints = computeArc7PublicBand(state);
    state.brokenRidgeCenter = { lat: -31.0, lon: 95.0 };
    state.brokenRidgePoints = brokenRidgeBox(state.brokenRidgeCenter, 1200, 400);
    loadOceanInfinityPaths().then((paths) => {
      state.oceanInfinityPaths = Array.isArray(paths) ? paths : [];
      render();
    });
    loadOceanInfinityLivePaths().then((paths) => {
      state.oceanInfinityLivePaths = Array.isArray(paths) ? paths : [];
      render();
    });
    loadOceanInfinityPhase1Paths().then((paths) => {
      state.oceanInfinityPhase1Paths = Array.isArray(paths) ? paths : [];
      render();
    });
    loadSeabedConstructorPaths().then((paths) => {
      state.seabedConstructorPaths = Array.isArray(paths) ? paths : [];
      render();
    });
    loadOceanInfinitySearchAreas().then((areas) => {
      state.oceanInfinitySearchAreas = areas || { polygons: [], lines: [] };
      render();
    });
    loadAircraftData().then((points) => {
      state.aircraftPoints = points;
      render();
    });
    loadMatlabLinks().then((links) => {
      state.matlabLinks = links;
      render();
    });
    loadCandidateLinks().then((links) => {
      state.candidateLinks = links;
      render();
    });
    loadWsprData().then((text) => {
      const parsed = parseWsprData(text);
      if (parsed.length) {
        state.wsprRows = parsed;
        render();
      }
    });
    loadWsprFilteredData().then((text) => {
      const parsed = parseWsprData(text);
      if (parsed.length) {
        state.wsprFilteredRows = parsed;
        render();
      }
    });
    loadWsprFiltered2Data().then((text) => {
      const parsed = parseWsprData(text);
      if (parsed.length) {
        state.wsprFiltered2Rows = parsed;
        render();
      }
    });
    loadWsprAnomaliesData().then((text) => {
      const parsed = parseWsprData(text);
      if (parsed.length) {
        state.wsprAnomalyRows = parsed;
        render();
      }
    });
    loadLongPathData().then((text) => {
      const parsed = parseWsprData(text);
      if (parsed.length) {
        state.longPathRows = parsed;
        render();
      }
    });
    updateWsprSelectionText(null);
    window.addEventListener("resize", render);
  })
  .catch((error) => {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "#111827";
    ctx.font = "14px Space Grotesk, sans-serif";
    ctx.fillText("Failed to load arcs: " + error.message, 20, 40);
  });
