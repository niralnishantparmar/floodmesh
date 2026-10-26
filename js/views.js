import { LOW_BATTERY_PCT, MIN_RISK_ZOOM } from './config.js';
import {
  STATUS, REPORT_KINDS, statusLabel, summarize, cmToIn,
  fmtIn, fmtCm, fmtRise, fmtEta, fmtAge, fmtClock, fmtTempF, escapeHtml,
} from './logic.js';

const esc = escapeHtml;

function since(iso) {
  const sec = (Date.now() - Date.parse(iso)) / 1000;
  return sec < 60 ? 'just now' : fmtAge(sec);
}

export function reportKind(r) {
  return REPORT_KINDS[r.kind] || 'Hazard';
}

export function feet(n) {
  return `${Math.round(n).toLocaleString()} ft`;
}

function back(label, action = 'back') {
  return `<button class="back" data-action="${action}">${label}</button>`;
}

function footer(kind = 'street') {
  const note = kind === 'home'
    ? 'Home alerts are an early heads-up and don\'t replace a monitored alarm system or a plumber\'s inspection.'
    : 'FloodMesh is meant to help you plan. It doesn\'t replace official warnings from your local government or national weather service.';
  return `
    <footer class="foot">
      <p>${note}</p>
      <p><button class="link" data-action="how">How it works</button><span class="dot-sep"></span><button class="link" data-action="stack">How it's built</button><span class="dot-sep"></span><button class="link" data-action="demo-toggle">Demo controls</button></p>
    </footer>`;
}

export function mapView(ctx) {
  return `
    <section class="block">
      <p class="eyebrow" data-live="place"></p>
      <div data-live="area"></div>
    </section>
    <section class="block">
      <div class="block-head"><h2>Sensors in view</h2><span class="count" data-live="sensor-count"></span></div>
      <p class="lead-in" data-live="summary"></p>
      <div data-live="street-list"></div>
    </section>
    <section class="block">
      <div class="block-head"><h2>Reports from residents</h2><button class="btn small" data-action="report-start">Report flooding</button></div>
      <div data-live="report-list"></div>
    </section>
    <section class="block">
      <div class="block-head"><h2>Where a sensor would help</h2></div>
      <div data-live="sites"></div>
    </section>
    ${footer()}`;
}

export function placeLine(ctx) {
  return esc(ctx.state.place || '');
}

export function areaBlock(ctx) {
  const { risk, sim, state } = ctx;
  const zoomedOut = ctx.zoom < MIN_RISK_ZOOM;
  const area = !zoomedOut ? risk.areaLevel(ctx.view) : null;
  const flooding = ctx.inView.filter((s) => s.mode === 'street' && ctx.evalOf(s).key === 'flooding').map((s) => s.name);
  let word;
  let color;
  if (flooding.length) {
    word = 'Flooding';
    color = STATUS.flooding.color;
  } else if (area) {
    word = area.level.label;
    color = area.level.color;
  } else {
    word = zoomedOut ? 'Zoom in' : risk.status === 'failed' ? 'Unavailable' : 'Checking';
    color = 'var(--ink-3)';
  }
  const w = risk.weather;
  let reason;
  if (zoomedOut) reason = 'Street-level flood risk shows up once you zoom in closer, since it depends on the shape of the ground block by block.';
  else if (flooding.length) reason = `Sensors are picking up water over the road at ${flooding.join(' and ')}.`;
  else if (risk.status === 'failed') reason = 'Elevation data for this area could not be loaded, so the map shows sensors and reports only.';
  else if (!area) reason = 'Reading the elevation data for this area.';
  else if (sim.running) reason = 'The replay storm is dropping heavy rain, and the lowest spots fill up first.';
  else if (w && !w.error && w.rain24In >= 0.5) reason = 'Steady rain is in the forecast, so low spots may start collecting water over the next day.';
  else if (w && !w.error && w.rain24In >= 0.05) reason = 'A little rain is in the forecast, but not enough to flood streets.';
  else if (w && !w.error) reason = 'No meaningful rain is in the forecast for the next day.';
  else reason = 'The weather forecast isn\'t available, so this is based on terrain and any sensor readings.';
  const alerts = risk.alerts.length
    ? `<p class="alert-line"><strong>${esc(risk.alerts.map((a) => a.event).join(', '))}</strong> in effect for this area.</p>`
    : '';
  return `
    <div class="area" style="--c:${color}">
      <h1 class="area-title">Flood risk right now</h1>
      <p class="area-word">${word}</p>
      <p class="area-reason">${reason}</p>
      <p class="weather">${esc(weatherLine(ctx))}</p>
      ${alerts}
      <p class="hint">${ctx.risk.mode === 'heavy' ? 'The map shades the places that flood first in a heavy storm. ' : ''}Click any spot to see how flood-prone it is and why.</p>
      <p><button class="link" data-action="locate">Show my location</button></p>
    </div>`;
}

export function weatherLine(ctx) {
  const { sim, risk } = ctx;
  if (sim.running) return `Storm replay: ${sim.rainfall().toFixed(1)} in of rain per hour.`;
  const w = risk.weather;
  if (!w) return 'Loading the forecast.';
  if (w.error) return 'The weather forecast isn\'t available right now.';
  const parts = [];
  const head = [w.summary, w.tempF != null ? `${w.tempF}°F` : null].filter(Boolean).join(', ');
  if (head) parts.push(`${head}.`);
  const rain = w.rain24In < 0.05 ? 'under 0.1 in' : `${w.rain24In.toFixed(1)} in`;
  if (w.rainChance != null) parts.push(`${w.rainChance}% chance of rain in the next 6 hours, with ${rain} expected over the next day.`);
  else parts.push(`About ${rain} of rain is expected over the next day.`);
  return parts.join(' ');
}

export function sensorCount(ctx) {
  const n = ctx.inView.filter((s) => s.mode === 'street').length;
  return n ? String(n) : '';
}

export function summaryLine(ctx) {
  const street = ctx.inView.filter((s) => s.mode === 'street');
  return summarize(street.map((s) => ({ sensor: s, ev: ctx.evalOf(s) })));
}

export function sparkline(ctx, sensor) {
  const list = ctx.state.readings.get(sensor.id) || [];
  const pts = list.slice(-60).map((r) => ctx.waterOf(sensor, r) ?? 0);
  if (pts.length < 2) return '';
  const max = Math.max(sensor.alert_depth_cm, ...pts) || 1;
  const step = 100 / (pts.length - 1);
  const line = pts.map((v, k) => `${(k * step).toFixed(1)},${(19 - (v / max) * 17).toFixed(1)}`).join(' ');
  const alertY = (19 - (sensor.alert_depth_cm / max) * 17).toFixed(1);
  return `<svg class="spark" viewBox="0 0 100 20" preserveAspectRatio="none" aria-hidden="true"><line x1="0" x2="100" y1="${alertY}" y2="${alertY}" class="spark-limit"/><polyline points="${line}" class="spark-line"/></svg>`;
}

export function sensorRows(ctx, sensors, emptyHtml) {
  if (!sensors.length) return emptyHtml;
  return `<ul class="rows">${sensors.map((s) => {
    const ev = ctx.evalOf(s);
    const quiet = ev.key === 'offline' || ev.key === 'nodata';
    const value = quiet ? (ev.ageSec != null ? `last seen ${ev.ageSec < 60 ? 'just now' : fmtAge(ev.ageSec)}` : 'no readings yet') : fmtIn(ev.water);
    return `
      <li>
        <button class="row" data-action="select" data-id="${s.id}" style="--c:${STATUS[ev.key].color}">
          <span class="row-main"><span class="row-name">${esc(s.name)}</span><span class="row-value${quiet ? ' quiet' : ''}">${value}</span></span>
          <span class="row-sub"><span>${esc(s.location_note || (s.mode === 'personal' ? 'Home sensor' : 'Street sensor'))}</span><span class="row-status">${statusLabel(s, ev.key)}</span></span>
          ${sparkline(ctx, s)}
        </button>
      </li>`;
  }).join('')}</ul>`;
}

export function streetList(ctx) {
  const sensors = ctx.inView.filter((s) => s.mode === 'street');
  const empty = `<p class="empty">There are no FloodMesh sensors in this part of the map yet.${ctx.isOfficial() ? ' You can add one from the Network tab.' : ''}</p>`;
  return sensorRows(ctx, sensors, empty);
}

export function reportActions(ctx, r) {
  if (ctx.canRemoveReport(r)) return `<button class="link" data-action="report-remove" data-id="${r.id}">${ctx.ownsReport(r) ? 'Remove my report' : 'Remove report'}</button>`;
  if (ctx.state.cleared.has(r.id)) return '<span class="muted small">Thanks, noted.</span>';
  return `<button class="link" data-action="report-clear" data-id="${r.id}">The water is gone</button>`;
}

export function reportList(ctx) {
  const list = ctx.reportsInView;
  if (!list.length) return '<p class="empty">No one has reported flooding in this part of the map in the last few hours.</p>';
  return `<ul class="rows plain">${list.map((r) => `
    <li class="report">
      <button class="report-main" data-action="focus-report" data-id="${r.id}">
        <span class="row-name">${esc(REPORT_KINDS[r.kind] || 'Report')}</span>
        <span class="row-sub"><span>${since(r.created_at)}${r.note ? `, "${esc(r.note)}"` : ''}</span></span>
      </button>
      <div class="report-actions">${reportActions(ctx, r)}</div>
    </li>`).join('')}</ul>`;
}

export function reportPopup(ctx, r) {
  return `
    <div class="popup">
      <strong>${esc(REPORT_KINDS[r.kind] || 'Report')}</strong>
      ${r.note ? `<p>${esc(r.note)}</p>` : ''}
      <span class="muted">Reported ${since(r.created_at)} by a resident. Not verified.</span>
      <div class="popup-actions">${reportActions(ctx, r)}</div>
    </div>`;
}

export function siteList(ctx) {
  const { risk, state } = ctx;
  if (ctx.zoom < MIN_RISK_ZOOM) return '<p class="empty">Zoom in to see suggested sensor locations.</p>';
  if (!risk.ready) return `<p class="empty">${risk.status === 'failed' ? 'Suggestions need elevation data, which couldn\'t be loaded here.' : 'Looking for low spots in this area.'}</p>`;
  if (!state.sites.length) {
    return ctx.inView.some((x) => x.mode === 'street')
      ? '<p class="empty">The most flood-prone spots in view are already close to a sensor.</p>'
      : '<p class="empty">Nothing in this part of the map stands out as especially flood-prone.</p>';
  }
  return `<ol class="sites">${state.sites.map((site, k) => `
    <li>
      <span class="site-num">${k + 1}</span>
      <div>
        <button class="link strong" data-action="site" data-k="${k}">${esc(site.road || 'Unnamed spot')}</button>
        <p class="small">${topShare(site.rank)} for flood risk among ${site.rankAgainstRoads ? 'road spots' : 'spots'} in view, with runoff from about ${acres(site.acres)} draining toward it.</p>
      </div>
    </li>`).join('')}</ol>`;
}

function acres(a) {
  return `${a >= 10 ? Math.round(a) : a.toFixed(1)} acres`;
}

function topShare(rank) {
  return `In the top ${Math.max(1, Math.ceil((1 - rank) * 100))}%`;
}

export function rankSentence(info) {
  const where = info.rankAgainstRoads ? 'road spots' : 'spots';
  if (info.rank >= 0.99) return `This is one of the most flood-prone ${where} in view, in the top 1%.`;
  if (info.rank >= 0.5) return `It is more flood-prone than ${Math.round(info.rank * 100)}% of ${where} in view.`;
  return `It is less flood-prone than ${Math.round((1 - info.rank) * 100)}% of ${where} in view.`;
}

export function factorList(ctx, lat, lng, info, skipId = null) {
  const rows = [];
  const add = (term, text) => rows.push(`<dt>${term}</dt><dd>${text}</dd>`);
  if (info && !info.outside) {
    const rel = (ft, radius) => `${ft >= 1 ? `${Math.round(ft)} ft lower than` : ft <= -1 ? `${Math.round(-ft)} ft higher than` : 'about level with'} the ground within ${feet(Math.round(radius / 50) * 50)}`;
    add('Elevation', `${Math.round(info.elevFt)} ft above sea level, ${rel(info.localFt, info.localRadiusFt)} and ${rel(info.broadFt, info.broadRadiusFt)}.`);
    add('Drainage', info.acres >= 0.5 ? `Runoff from about ${acres(info.acres)} of surrounding land flows through here.` : 'Very little runoff flows here, since water tends to drain away from this spot.');
    add('Low spot', info.pondFt >= 0.3 ? `It sits in a dip that could hold about ${info.pondFt.toFixed(1)} ft of standing water if storm drains back up.` : 'It isn\'t in a closed dip, so water has somewhere to drain.');
  }
  const fema = ctx.femaFor(lat, lng);
  add('FEMA map', fema.status === 'loading' ? 'Checking the National Flood Hazard Layer.' : esc(fema.text));
  add('Weather', esc(weatherLine(ctx)));
  const street = ctx.state.sensors.filter((s) => s.mode === 'street' && s.lat != null && s.id !== skipId);
  if (street.length) {
    const nearest = street.map((s) => ({ s, d: ctx.distanceFt([lat, lng], [s.lat, s.lng]) })).sort((a, b) => a.d - b.d)[0];
    if (nearest.d < 26400) {
      const ev = ctx.evalOf(nearest.s);
      add('Nearest sensor', `${esc(nearest.s.name)}, ${feet(nearest.d)} away, ${STATUS[ev.key].label.toLowerCase()}${ev.water != null && ev.key !== 'offline' ? ` at ${fmtIn(ev.water)}` : ''}.`);
    }
  }
  const near = ctx.state.reports.filter((r) => ctx.distanceFt([lat, lng], [r.lat, r.lng]) <= 1000 && Date.parse(r.expires_at) > Date.now());
  add('Reports', near.length ? `${near.length} active report${near.length > 1 ? 's' : ''} within 1,000 ft.` : 'None within 1,000 ft.');
  return `<dl class="facts">${rows.join('')}</dl>`;
}

export function pointView(ctx) {
  const [lat, lng] = ctx.state.point;
  return `
    ${back('Map', 'to-map')}
    <header class="page-head">
      <h1>${esc(ctx.state.pointTitle || 'Flood risk at this spot')}</h1>
      <p class="muted" data-live="point-place"><span class="mono">${lat.toFixed(5)}, ${lng.toFixed(5)}</span></p>
    </header>
    <div data-live="point"></div>
    <div class="actions">
      <button class="btn" data-action="report-here">Report flooding here</button>
      ${ctx.isOfficial() ? '<button class="btn ghost" data-action="add-here">Add a sensor here</button>' : ''}
    </div>
    ${footer()}`;
}

export function pointBody(ctx) {
  const [lat, lng] = ctx.state.point;
  if (ctx.zoom < MIN_RISK_ZOOM) {
    return `<p>Zoom in to analyze this spot. Flood risk depends on the shape of the ground nearby, which only shows up at street level.</p>
      <p><button class="btn ghost" data-action="zoom-point">Zoom in here</button></p>`;
  }
  const info = ctx.risk.analyze(lat, lng);
  let head;
  if (!ctx.risk.ready) {
    head = `<p class="muted">${ctx.risk.status === 'failed' ? 'Elevation data couldn\'t be loaded here, so only nearby readings are shown.' : 'Reading elevation data for this area.'}</p>`;
  } else if (info.outside) {
    head = '<p class="muted">This spot is outside the area currently analyzed. Move the map so it\'s in view.</p>';
  } else {
    head = `
      <div class="pair">
        <div style="--c:${info.levelNow.color}"><span class="label">Right now</span><span class="pair-word">${info.levelNow.label}</span></div>
        <div style="--c:${info.levelHeavy.color}"><span class="label">In a heavy storm</span><span class="pair-word">${info.levelHeavy.label}</span></div>
      </div>
      <p>${rankSentence(info)}</p>`;
  }
  const res = info && !info.outside ? Math.round(info.resolutionFt / 10) * 10 : null;
  return `${head}
    <h2 class="sub">Why</h2>
    ${factorList(ctx, lat, lng, info && !info.outside ? info : null)}
    <p class="fine">Elevation comes from USGS 3DEP and other public sources${res ? `, analyzed in squares about ${res} ft across at this zoom level` : ''}. Treat this as a guide rather than an official flood determination.</p>`;
}

export function readout(label, value, sub = '') {
  return `<div class="readout"><span class="label">${label}</span><span class="value">${value}</span>${sub ? `<span class="small">${sub}</span>` : ''}</div>`;
}

function trendWord(delta) {
  if (Math.abs(delta) < 0.25) return 'about the same';
  return delta > 0 ? `up ${fmtIn(delta)}` : `down ${fmtIn(-delta)}`;
}

export function statsBlock(ctx, s) {
  const ev = ctx.evalOf(s);
  const personal = s.mode === 'personal';
  const rows = [
    readout(personal ? 'Water on the floor' : 'Water above the road', fmtIn(ev.water), fmtCm(ev.water)),
    readout('Trend', fmtRise(ev.rise)),
  ];
  const fc = ctx.state.forecasts.get(s.id);
  if (fc) {
    rows.push(readout('In 30 minutes', fmtIn(fc.depth30), `forecast, ${trendWord(fc.depth30 - fc.current)}`));
    rows.push(readout('In 60 minutes', fmtIn(fc.depth60), `forecast, ${trendWord(fc.depth60 - fc.current)}`));
    if (fc.crossMin != null && ev.key !== 'flooding') rows.push(readout('Impassable in', fmtEta(fc.crossMin), 'from the forecast model'));
  } else if (ev.etaMin != null && ev.key !== 'offline') {
    rows.push(readout(personal ? 'Reaches alert level in' : 'Impassable in', fmtEta(ev.etaMin)));
  }
  if (ev.ice) rows.push(readout('Ice risk', 'Likely', 'freezing air with water on the road'));
  if (ev.temp != null) rows.push(readout('Air temperature', fmtTempF(ev.temp)));
  if (ev.battery != null) rows.push(readout('Battery', `${Math.round(ev.battery)}%`, ev.battery < LOW_BATTERY_PCT ? 'recharge soon' : 'recharges over USB'));
  let updated = ev.ageSec == null ? 'Waiting for the first reading' : `Updated ${fmtAge(ev.ageSec)}`;
  if (ctx.sim.drives(s)) updated = `Storm replay, ${fmtClock(ctx.sim.clock().toISOString())}`;
  return `
    <div class="status" style="--c:${STATUS[ev.key].color}">
      <span class="status-word">${statusLabel(s, ev.key)}</span>
      <span class="muted small">${updated}</span>
    </div>
    <div class="readouts">${rows.join('')}</div>`;
}

export function sensorView(ctx, s) {
  const owner = s.owner_id === ctx.userId();
  const personal = s.mode === 'personal';
  return `
    ${back(personal ? 'My sensors' : 'Map', personal ? 'to-mine' : 'to-map')}
    <header class="page-head">
      <h1>${esc(s.name)}</h1>
      <p class="muted">${esc(s.location_note || (personal ? 'Home sensor, visible only to you' : 'Street sensor'))}${s.is_simulated ? ', demo unit with simulated readings' : ''}</p>
    </header>
    <div data-live="stats"></div>
    <div class="chart"><canvas id="chart" aria-label="Water level over time"></canvas></div>
    <div data-live="model-note"></div>
    ${personal ? '' : `<section class="block"><h2>Why this spot floods</h2><div data-live="site-profile"></div></section>`}
    ${owner ? ownerSettings(ctx, s) : watchSettings(ctx, s)}
    ${footer(personal ? 'home' : 'street')}`;
}

function watchSettings(ctx, s) {
  if (s.mode !== 'street') return '';
  return `<section class="block"><h2>Alerts</h2><p data-live="mute"></p></section>`;
}

export function muteLine(ctx, s) {
  const muted = ctx.state.muted.has(s.id);
  return `${muted ? 'You won\'t get alerts from this sensor.' : 'You\'ll get an alert when this sensor shows water rising or flooding.'} <button class="link" data-action="mute" data-id="${s.id}">${muted ? 'Turn alerts on' : 'Turn alerts off'}</button>`;
}

function ownerSettings(ctx, s) {
  const personal = s.mode === 'personal';
  return `
    <section class="block">
      <h2>Settings</h2>
      <form class="form row-form" data-form="alert-depth" data-id="${s.id}">
        <label>${personal ? 'Alert me when water reaches' : 'Mark the road impassable at'}
          <span class="unit"><input name="depth" type="number" min="0.2" max="60" step="0.1" value="${cmToIn(s.alert_depth_cm).toFixed(1)}" required> in</span>
        </label>
        <button class="btn ghost" type="submit">Save</button>
      </form>
      <div class="setting">
        <p>The sensor treats ${fmtIn(s.mount_height_cm)} as the distance to a dry ${personal ? 'floor' : 'road'}. If you move it, reset that while the surface below is dry.</p>
        <button class="btn ghost" data-action="calibrate" data-id="${s.id}" ${s.is_simulated ? 'disabled' : ''}>Reset the dry level</button>
      </div>
      <p class="msg" data-live="message"></p>
      <p class="danger-zone"><button class="link danger" data-action="remove-sensor" data-id="${s.id}">Remove this sensor</button></p>
    </section>`;
}

export function modelNote(ctx) {
  const m = ctx.state.model;
  if (!m) return '';
  const years = m.years[1] - m.years[0] + 1;
  const imp = m.metrics.improvement_vs_trend_60;
  const result = imp != null && imp > 0
    ? `Tested on ${m.metrics.test_period}, a year it never saw in training, its one-hour predictions were ${Math.round(imp * 100)}% more accurate than assuming the current trend would simply continue.`
    : `Tested on ${m.metrics.test_period}, it did not beat simply assuming the current trend continues, so treat its numbers as a rough guide.`;
  return `
    <details class="note">
      <summary>How the forecast works</summary>
      <p>The 30 and 60 minute numbers come from a small neural network trained on ${years} years of 15-minute water level readings from the USGS gauge on the ${esc(m.site.name.replace(/, NJ$/, ''))}, along with hourly rainfall. ${result}</p>
      <p>No public record of street flooding exists to train on yet, so the model learned how a nearby river responds to rain and applies that pattern here, scaled to this sensor's flooding line. It will be retrained on FloodMesh readings once sensors have logged a season of storms.</p>
    </details>`;
}

export function siteProfile(ctx, s) {
  if (s.lat == null) return '';
  if (ctx.zoom < MIN_RISK_ZOOM) return '<p class="muted">Zoom in on the map to see the terrain around this sensor.</p>';
  const info = ctx.risk.analyze(s.lat, s.lng);
  const head = info && !info.outside
    ? `<p>In a heavy storm, the terrain puts this spot at <strong style="color:${info.levelHeavy.color}">${info.levelHeavy.label.toLowerCase()}</strong> risk. ${rankSentence(info)}</p>`
    : `<p class="muted">${ctx.risk.status === 'failed' ? 'Elevation data isn\'t available here.' : 'Reading elevation data.'}</p>`;
  return head + factorList(ctx, s.lat, s.lng, info && !info.outside ? info : null, s.id);
}

export function reportView() {
  const options = Object.entries(REPORT_KINDS)
    .map(([value, label], i) => `<label class="choice"><input type="radio" name="kind" value="${value}" ${i === 0 ? 'checked' : ''}><span>${label}</span></label>`)
    .join('');
  return `
    ${back('Cancel', 'to-map')}
    <header class="page-head">
      <h1>Report flooding</h1>
      <p class="muted">Drag the pin to where you saw the problem. Your report stays on the map for four hours, or until two people say the water is gone, and it's marked as unverified.</p>
    </header>
    <form class="form" data-form="report">
      <fieldset><legend>What did you see?</legend>${options}</fieldset>
      <label><span>Anything else people should know? <span class="muted">(optional)</span></span>
        <textarea name="note" rows="3" maxlength="280" placeholder="Water covering both lanes"></textarea>
      </label>
      <button class="btn" type="submit">Send report</button>
      <p class="msg" data-live="message"></p>
    </form>`;
}

export function authView(ctx) {
  const signin = ctx.state.authMode === 'signin';
  return `
    ${back('Map', 'to-map')}
    <header class="page-head">
      <h1>${signin ? 'Sign in' : 'Create an account'}</h1>
      <p class="muted">${signin
        ? 'Sign in to add sensors and see the ones in your home. Town staff accounts can also add street sensors once they\'ve been verified.'
        : 'An account lets you connect sensors in your home. Street sensors are limited to verified town staff.'}</p>
    </header>
    <form class="form" data-form="auth">
      ${signin ? '' : '<label>Name<input name="name" required maxlength="60" autocomplete="name"></label>'}
      <label>Email<input type="email" name="email" required autocomplete="email"></label>
      <label>Password<input type="password" name="password" required minlength="6" autocomplete="${signin ? 'current-password' : 'new-password'}"></label>
      <button class="btn" type="submit">${signin ? 'Sign in' : 'Create account'}</button>
      <p class="msg" data-live="message"></p>
    </form>
    <p class="switch">${signin ? 'New here?' : 'Already have an account?'} <button class="link" data-action="auth-toggle">${signin ? 'Create an account' : 'Sign in instead'}</button></p>`;
}

export function accountView(ctx) {
  const { state } = ctx;
  return `
    ${back('Map', 'to-map')}
    <header class="page-head">
      <h1>${esc(state.profile?.display_name || 'Your account')}</h1>
      <p class="muted">${esc(state.session.user.email)}</p>
    </header>
    <dl class="facts">
      <dt>Account</dt><dd>${ctx.isOfficial() ? 'Verified town staff' : 'Resident'}</dd>
      <dt>Alerts</dt><dd>Alerts appear inside FloodMesh while it's open. ${ctx.browserAlerts === 'default' ? '<button class="link" data-action="alerts-enable">Also show them as browser notifications</button>' : ctx.browserAlerts === 'granted' ? 'Browser notifications are on.' : ''} Background push alerts are planned for the mobile version.</dd>
    </dl>
    <p class="actions"><button class="btn ghost" data-action="signout">Sign out</button></p>
    ${footer()}`;
}

export function mineView(ctx) {
  if (!ctx.state.session) {
    return `
      <header class="page-head">
        <h1>My sensors</h1>
        <p>A FloodMesh sensor in a basement or crawl space alerts your phone as soon as standing water appears, so a burst pipe or seepage gets caught early. It runs on a rechargeable battery and keeps working through power outages.</p>
      </header>
      <p class="actions"><button class="btn" data-action="goto" data-view="auth">Sign in</button><button class="btn ghost" data-action="auth-create">Create an account</button></p>
      ${footer('home')}`;
  }
  return `
    <header class="page-head">
      <h1>My sensors</h1>
      <p class="muted">Sensors in your home are private and never appear on the public map.</p>
    </header>
    <div data-live="mine"></div>
    <p class="actions"><button class="btn" data-action="add-start" data-mode="personal">Add a sensor</button></p>
    ${footer('home')}`;
}

export function mineList(ctx) {
  const mine = ctx.state.sensors.filter((s) => s.owner_id === ctx.userId());
  const empty = '<p class="empty">You haven\'t added a sensor yet. It takes about two minutes once the sensor is plugged in.</p>';
  return sensorRows(ctx, mine, empty);
}

export function networkView(ctx) {
  if (!ctx.isOfficial()) {
    return `<header class="page-head"><h1>Network</h1><p class="muted">Managing street sensors requires a verified town staff account.</p></header>`;
  }
  return `
    <header class="page-head">
      <h1>Street sensor network</h1>
      <p class="muted">Every street sensor, including ones outside the current map view.</p>
    </header>
    <div data-live="health"></div>
    <p class="actions"><button class="btn" data-action="add-start" data-mode="street">Add a street sensor</button></p>
    <section class="block">
      <h2>Where a sensor would help</h2>
      <div data-live="sites"></div>
    </section>
    <section class="block">
      <h2>Reports to review</h2>
      <div data-live="report-list"></div>
    </section>`;
}

export function healthTable(ctx) {
  const street = ctx.state.sensors.filter((s) => s.mode === 'street');
  if (!street.length) return '<p class="empty">No street sensors have been added yet.</p>';
  return `
    <table class="table">
      <thead><tr><th>Sensor</th><th>Status</th><th class="num">Water</th><th class="num">Last reading</th></tr></thead>
      <tbody>${street.map((s) => {
        const ev = ctx.evalOf(s);
        return `<tr data-action="select" data-id="${s.id}">
          <td>${esc(s.name)}</td>
          <td><span class="key-dot" style="--c:${STATUS[ev.key].color}"></span>${STATUS[ev.key].label}</td>
          <td class="num">${ev.water == null || ev.key === 'offline' ? '' : fmtIn(ev.water)}</td>
          <td class="num">${ev.ageSec == null ? 'never' : ev.ageSec < 60 ? 'just now' : fmtAge(ev.ageSec)}</td>
        </tr>`;
      }).join('')}</tbody>
    </table>`;
}

function steps(current) {
  return `<div class="steps" aria-label="Step ${current} of 3">${[1, 2, 3].map((n) => `<span class="${n <= current ? 'on' : ''}"></span>`).join('')}</div>`;
}

export function addView(ctx) {
  const wz = ctx.state.wizard;
  if (!ctx.state.session) return authView(ctx);
  if (wz.step === 1) {
    return `
      ${back('Cancel', 'add-cancel')}
      ${steps(1)}
      <header class="page-head"><h1>Connect the sensor to Wi&#8209;Fi</h1></header>
      <ol class="howto">
        <li>Plug the sensor in. Its setup network appears within a few seconds.</li>
        <li>On your phone, open Wi-Fi settings and join the network named <strong>FloodMesh</strong> followed by four letters.</li>
        <li>A setup page opens on its own. Pick your home Wi-Fi and enter the password, and the page shows a six-character pairing code.</li>
      </ol>
      <form class="form" data-form="pair-code">
        <label>Pairing code
          <input name="code" class="code-input" inputmode="text" autocomplete="off" autocapitalize="characters" spellcheck="false" maxlength="7" placeholder="ABC-123" value="${esc(wz.code)}" required>
        </label>
        <button class="btn" type="submit">Continue</button>
        <p class="msg" data-live="message"></p>
      </form>
      <p class="fine">If the setup page doesn't open by itself, go to 192.168.4.1 in your phone's browser while you're connected to the FloodMesh network. Holding the sensor's BOOT button for three seconds starts setup over.</p>`;
  }
  if (wz.step === 2) {
    const street = wz.mode === 'street';
    const typeChoice = ctx.isOfficial() ? `
      <fieldset><legend>Where is it going?</legend>
        <label class="choice"><input type="radio" name="mode" value="personal" ${!street ? 'checked' : ''}><span>Inside a home or building, visible only to me</span></label>
        <label class="choice"><input type="radio" name="mode" value="street" ${street ? 'checked' : ''}><span>On a street, shown on the public map</span></label>
      </fieldset>` : '';
    return `
      ${back('Back', 'add-back')}
      ${steps(2)}
      <header class="page-head"><h1>Tell us about it</h1></header>
      <form class="form" data-form="pair-details">
        ${typeChoice}
        <label>Name<input name="name" required maxlength="60" placeholder="${street ? 'Main St underpass' : 'Basement'}" value="${esc(wz.name || '')}"></label>
        <label><span>Where exactly? <span class="muted">(optional)</span></span><input name="note" maxlength="120" placeholder="${street ? 'North side, on the retaining wall' : 'Next to the water heater'}" value="${esc(wz.note || '')}"></label>
        ${street ? `<div class="pick"><p>Click the map where the sensor is mounted. You can drag the pin to fine-tune it.</p><p class="mono small" data-live="pick-point">${wz.point ? `${wz.point.lat.toFixed(5)}, ${wz.point.lng.toFixed(5)}` : 'No location chosen yet'}</p></div>` : ''}
        <label>${street ? 'Mark the road impassable at' : 'Alert me when water reaches'}
          <span class="unit"><input name="depth" type="number" min="0.2" max="60" step="0.1" value="${street ? '6.0' : '1.0'}" required> in</span>
        </label>
        <button class="btn" type="submit">Pair sensor</button>
        <p class="msg" data-live="message"></p>
      </form>`;
  }
  return `
    ${steps(3)}
    <header class="page-head"><h1>Set the dry level</h1></header>
    <div data-live="calibrate"></div>
    <p class="msg" data-live="message"></p>`;
}

export function calibrateBody(ctx, s, reading) {
  if (!s) return '<p>Finishing pairing.</p>';
  if (!reading) {
    return `<p>Waiting for the first reading from ${esc(s.name)}. Sensors report every 10 seconds, so this should only take a moment.</p>
      <p class="fine">If nothing arrives within a minute, check that the sensor's setup page said it was connected, and that it's within range of your Wi-Fi.</p>
      <p class="actions"><button class="btn ghost" data-action="add-finish">Skip for now</button></p>`;
  }
  return `<p>${esc(s.name)} is connected and measuring <strong>${fmtIn(reading.distance_mm / 10)}</strong> down to the surface below it.</p>
    <p>Make sure that surface is dry, then save this as the dry level. Water depth is measured from here.</p>
    <p class="actions"><button class="btn" data-action="add-calibrate">Save dry level</button><button class="btn ghost" data-action="add-finish">Skip for now</button></p>`;
}
