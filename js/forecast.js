import { waterCm } from './logic.js';

export async function loadForecastModel(url = 'model/forecast.json') {
  try {
    const res = await fetch(url, { cache: 'no-cache' });
    if (!res.ok) return null;
    const model = await res.json();
    if (model.synthetic || !Array.isArray(model.layers)) return null;
    return model;
  } catch {
    return null;
  }
}

export function runModel(model, x) {
  let h = x.map((v, i) => (v - model.x_mean[i]) / (model.x_std[i] || 1));
  model.layers.forEach((layer, li) => {
    const out = layer.b.slice();
    for (let i = 0; i < h.length; i += 1) {
      const row = layer.W[i];
      const hi = h[i];
      for (let j = 0; j < out.length; j += 1) out[j] += hi * row[j];
    }
    h = li < model.layers.length - 1 ? out.map((v) => (v > 0 ? v : 0)) : out;
  });
  return h.map((v, j) => v * model.y_std[j] + model.y_mean[j]);
}

function timeOf(r) {
  return Date.parse(r.label_time || r.created_at);
}

function levelAt(points, t) {
  if (!points.length) return null;
  if (t <= points[0].t) return points[0].v;
  for (let k = points.length - 1; k >= 0; k -= 1) {
    if (points[k].t <= t) {
      const a = points[k];
      const b = points[k + 1];
      if (!b) return a.v;
      return a.v + ((b.v - a.v) * (t - a.t)) / (b.t - a.t);
    }
  }
  return points[0].v;
}

export function sensorFeatures(sensor, readings, rain) {
  const points = readings
    .map((r) => ({ t: timeOf(r), v: waterCm(sensor, r) }))
    .filter((p) => p.v != null && Number.isFinite(p.t));
  if (points.length < 2) return null;
  const scale = sensor.alert_depth_cm;
  const now = points[points.length - 1].t;
  const u = (minutes) => levelAt(points, now - minutes * 60000) / scale;
  const current = points[points.length - 1].v;
  const lowest = Math.min(...points.filter((p) => p.t >= now - 24 * 3600e3).map((p) => p.v));
  return {
    now,
    current,
    scale,
    x: [u(0) - u(15), u(0) - u(30), u(0) - u(60), u(0) - u(120), (current - lowest) / scale,
      rain.past1, rain.past3, rain.past6, rain.next1],
  };
}

export function forecastSensor(model, sensor, readings, rain) {
  const f = sensorFeatures(sensor, readings, rain);
  if (!f) return null;
  const [d30, d60] = runModel(model, f.x);
  const depth30 = Math.max(0, f.current + d30 * f.scale);
  const depth60 = Math.max(0, f.current + d60 * f.scale);
  const alert = sensor.alert_depth_cm;
  let crossMin = null;
  if (f.current < alert) {
    if (depth30 >= alert) crossMin = (30 * (alert - f.current)) / (depth30 - f.current);
    else if (depth60 >= alert) crossMin = 30 + (30 * (alert - depth30)) / (depth60 - depth30);
  }
  return { at: f.now, current: f.current, depth30, depth60, crossMin };
}

export function rainFromHourly(hourly, nowMs = Date.now()) {
  if (!hourly || !hourly.length) return null;
  const hour = Math.floor(nowMs / 3600e3) * 3600e3;
  const at = (t) => {
    const hit = hourly.find((h) => h.t === t);
    return hit ? hit.mm : 0;
  };
  const past = [0, 1, 2, 3, 4, 5].map((k) => at(hour - k * 3600e3));
  return {
    past1: past[0],
    past3: past[0] + past[1] + past[2],
    past6: past.reduce((a, b) => a + b, 0),
    next1: at(hour + 3600e3),
  };
}

export function rainFromCurve(inPerHrAt, minuteNow) {
  const mm = (from, to) => {
    let total = 0;
    for (let m = from; m < to; m += 5) total += (inPerHrAt(Math.max(0, m + 2.5)) * 25.4 * 5) / 60;
    return total;
  };
  return {
    past1: mm(minuteNow - 60, minuteNow),
    past3: mm(minuteNow - 180, minuteNow),
    past6: mm(minuteNow - 360, minuteNow),
    next1: mm(minuteNow, minuteNow + 60),
  };
}
