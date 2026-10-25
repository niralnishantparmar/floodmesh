import { OFFLINE_AFTER_SEC, RISING_CM_PER_MIN, WARNING_ETA_MIN, REPLAY } from './config.js';

export const STATUS = {
  normal:   { label: 'Normal',      color: '#2f7d4f', rank: 0 },
  rising:   { label: 'Rising',      color: '#a87a00', rank: 1 },
  warning:  { label: 'Warning',     color: '#d0610b', rank: 2 },
  flooding: { label: 'Flooding',    color: '#c0392b', rank: 3 },
  offline:  { label: 'Offline',     color: '#87919a', rank: -1 },
  nodata:   { label: 'No data yet', color: '#87919a', rank: -1 },
};

const PERSONAL_LABELS = {
  normal: 'Dry',
  rising: 'Water rising',
  warning: 'Water present',
  flooding: 'Water detected',
  offline: 'Offline',
  nodata: 'Waiting for first reading',
};

export const REPORT_KINDS = {
  flooded_road: 'Flooded road',
  blocked_drain: 'Blocked storm drain',
  stalled_car: 'Stalled vehicle',
  other: 'Other hazard',
};

export function statusLabel(sensor, key) {
  return sensor.mode === 'personal' ? PERSONAL_LABELS[key] : STATUS[key].label;
}

// Water depth in cm. Real readings carry the raw distance, so depth is recomputed
// from the current mount height (this keeps old readings correct after recalibrating).
export function waterCm(sensor, reading) {
  if (!reading) return null;
  if (reading.distance_mm != null && sensor.mount_height_cm != null) {
    return Math.max(0, sensor.mount_height_cm - reading.distance_mm / 10);
  }
  return reading.water_cm ?? null;
}

export function evaluate(sensor, latest, nowMs) {
  if (!latest) {
    return { key: 'nodata', water: null, rise: null, etaMin: null, ageSec: null, battery: null, temp: null };
  }
  const ageSec = Math.max(0, (nowMs - Date.parse(latest.created_at)) / 1000);
  const water = waterCm(sensor, latest);
  const rise = latest.rise_cm_per_min ?? 0;
  const alert = sensor.alert_depth_cm;

  let etaMin = null;
  if (water != null && water < alert && rise > 0.05) etaMin = (alert - water) / rise;

  let key;
  if (ageSec > OFFLINE_AFTER_SEC) key = 'offline';
  else if (water != null && water >= alert) key = 'flooding';
  // Deep water is a warning whether it is still rising or already falling.
  else if ((etaMin != null && etaMin <= WARNING_ETA_MIN) || (water != null && water >= alert * 0.6)) key = 'warning';
  else if (rise >= RISING_CM_PER_MIN) key = 'rising';
  else key = 'normal';

  return {
    key,
    water,
    rise,
    etaMin,
    ageSec,
    battery: latest.battery_pct ?? null,
    temp: latest.temp_c ?? null,
  };
}

export function summarize(items) {
  const street = items.filter((i) => i.sensor.mode === 'street');
  if (!street.length) return 'No street sensors are installed in this area yet.';
  const names = (key) => street.filter((i) => i.ev.key === key).map((i) => i.sensor.name);
  const parts = [];
  const flooding = names('flooding');
  const warning = names('warning');
  const rising = names('rising');
  const offline = names('offline');
  if (flooding.length) parts.push(`Flooding at ${joinNames(flooding)}.`);
  if (warning.length) parts.push(`Water approaching road level at ${joinNames(warning)}.`);
  if (rising.length) parts.push(`Water rising at ${joinNames(rising)}.`);
  if (offline.length) parts.push(`${offline.length} not reporting.`);
  const head = `${street.length} street sensor${street.length === 1 ? '' : 's'} in this area.`;
  return parts.length ? `${head} ${parts.join(' ')}` : `${head} All are reading normal.`;
}

function joinNames(list) {
  if (list.length <= 2) return list.join(' and ');
  return `${list.slice(0, -1).join(', ')}, and ${list[list.length - 1]}`;
}

// Formatting -------------------------------------------------------------

export const cmToIn = (cm) => cm / 2.54;

export function fmtIn(cm) {
  if (cm == null || Number.isNaN(cm)) return 'No data';
  const inches = cmToIn(cm);
  return `${inches.toFixed(inches >= 10 ? 0 : 1)} in`;
}

export function fmtCm(cm) {
  return cm == null || Number.isNaN(cm) ? '' : `${cm.toFixed(1)} cm`;
}

export function fmtRise(rise) {
  if (rise == null) return 'No data';
  if (Math.abs(rise) < 0.05) return 'Steady';
  const perMin = Math.abs(rise) / 2.54;
  return `${rise > 0 ? 'Rising' : 'Falling'} ${perMin.toFixed(2)} in/min`;
}

export function fmtEta(min) {
  if (min == null) return '';
  if (min < 1) return 'under a minute';
  if (min < 60) return `about ${Math.round(min)} min`;
  return `about ${(min / 60).toFixed(1)} hr`;
}

export function fmtAge(sec) {
  if (sec == null) return '';
  if (sec < 60) return `${Math.round(sec)} s ago`;
  if (sec < 3600) return `${Math.round(sec / 60)} min ago`;
  if (sec < 86400) return `${Math.round(sec / 3600)} hr ago`;
  return `${Math.round(sec / 86400)} days ago`;
}

export function fmtClock(iso) {
  return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

export function fmtTempF(c) {
  return c == null ? '' : `${Math.round((c * 9) / 5 + 32)}°F`;
}

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// Storm replay curves ----------------------------------------------------
// Water depth follows a bell curve around the storm peak; the rate is its derivative.

export function replayLevel(profile, minute) {
  return profile.peak * Math.exp(-0.5 * ((minute - profile.center) / profile.sd) ** 2);
}

export function replayRate(profile, minute) {
  return replayLevel(profile, minute) * (-(minute - profile.center) / (profile.sd * profile.sd));
}

export function replayRainfall(minute) {
  return REPLAY.rainPeakInPerHr * Math.exp(-0.5 * ((minute - REPLAY.rainPeakMin) / 25) ** 2);
}
