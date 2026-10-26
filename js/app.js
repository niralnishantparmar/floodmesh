import { START_VIEW, MIN_RISK_ZOOM, HISTORY_MINUTES, REPLAY } from './config.js';
import { STATUS, evaluate, waterCm, cmToIn, fmtIn, fmtClock, replayRainfall, escapeHtml } from './logic.js';
import * as data from './data.js';
import { Simulator } from './sim.js';
import { notify, browserAlertState, enableBrowserAlerts } from './notify.js';
import { MapView } from './mapview.js';
import { RiskEngine } from './insight.js';
import { femaZoneAt, describeZone, searchPlaces, placeName } from './sources.js';
import { welcomeHtml } from './welcome.js';
import { loadForecastModel, forecastSensor, rainFromHourly, rainFromCurve } from './forecast.js';
import { createAlertTracker, checkAlerts } from './alerts.js';
import * as V from './views.js';

const panel = document.getElementById('panel');

function randomToken() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function storedToken(key) {
  try {
    let token = localStorage.getItem(key);
    if (!token) {
      token = randomToken();
      localStorage.setItem(key, token);
    }
    return token;
  } catch {
    return randomToken();
  }
}

function readSet(key) {
  try {
    return new Set(JSON.parse(localStorage.getItem(key) || '[]'));
  } catch {
    return new Set();
  }
}

function persist(key, value) {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

function saveSet(key, set) {
  persist(key, JSON.stringify([...set]));
}

const freshWizard = (mode = 'personal') => ({ step: 1, mode, code: '', name: '', note: '', point: null, sensorId: null });

const state = {
  ready: false,
  session: null,
  profile: null,
  view: 'map',
  selectedId: null,
  authMode: 'signin',
  afterAuth: null,
  sensors: [],
  readings: new Map(),
  seen: new Set(),
  lastDbReading: null,
  reports: [],
  cleared: readSet('floodmesh-cleared'),
  myReports: readSet('floodmesh-my-reports'),
  muted: readSet('floodmesh-muted'),
  evals: new Map(),
  forecasts: new Map(),
  point: null,
  pointTitle: null,
  place: 'Edison, New Jersey',
  placeAt: START_VIEW.center,
  sites: [],
  wizard: freshWizard(),
  femaCache: new Map(),
  model: null,
  chart: null,
  chartFor: null,
  channel: null,
};

const reporterToken = storedToken('floodmesh-reporter');
const voterToken = storedToken('floodmesh-voter');
const tracker = createAlertTracker();

const isOfficial = () => state.profile?.role === 'official';
const userId = () => state.session?.user?.id ?? null;
const sensorById = (id) => state.sensors.find((s) => s.id === id);

function latestOf(id) {
  const list = state.readings.get(id);
  return list && list.length ? list[list.length - 1] : null;
}

function latestRealOf(id) {
  const list = state.readings.get(id) || [];
  for (let i = list.length - 1; i >= 0; i -= 1) {
    if (!list[i].simulated && list[i].distance_mm != null) return list[i];
  }
  return null;
}

function evalOf(s) {
  let ev = state.evals.get(s.id);
  if (!ev) {
    ev = evaluate(s, latestOf(s.id), Date.now());
    state.evals.set(s.id, ev);
  }
  return ev;
}

function activeReports() {
  const now = Date.now();
  return state.reports.filter((r) => Date.parse(r.expires_at) > now);
}

function distanceFt(a, b) {
  const R = 20902231;
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b[0] - a[0]);
  const dLng = rad(b[1] - a[1]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function ownsReport(r) {
  return state.myReports.has(r.id) || (userId() != null && r.reporter_id === userId());
}

function femaFor(lat, lng) {
  const key = `${lat.toFixed(5)},${lng.toFixed(5)}`;
  if (!state.femaCache.has(key)) {
    state.femaCache.set(key, { status: 'loading' });
    femaZoneAt(lat, lng)
      .then((zone) => state.femaCache.set(key, { status: 'ok', text: describeZone(zone) }))
      .catch(() => state.femaCache.set(key, { status: 'failed', text: 'The FEMA flood map service didn\'t respond. Its maps cover the United States only.' }))
      .finally(() => fillLive());
  }
  return state.femaCache.get(key);
}

const map = new MapView('map', {
  center: START_VIEW.center,
  zoom: START_VIEW.zoom,
  onSelect: (id) => openSensor(id),
  onSiteSelect: (k) => openSite(k),
  onRiskMode: (mode) => {
    risk.setMode(mode);
    refresh();
  },
  onViewChange: () => scheduleAnalysis(),
  onMapClick: (latlng) => onMapClick(latlng),
  popupContent: (r) => V.reportPopup(ctx(), r),
});

const risk = new RiskEngine({ onUpdate: (kind) => onRiskUpdate(kind) });

const sim = new Simulator({
  getSensors: () => state.sensors,
  getProfile: (s) => replayProfile(s),
  emit: (r) => addReading(r),
  onChange: (kind) => onReplayChange(kind),
});

function ctx() {
  const inView = state.sensors.filter((s) => s.lat != null && map.contains(s.lat, s.lng));
  return {
    state,
    risk,
    sim,
    zoom: map.zoom(),
    view: map.view(),
    inView,
    reportsInView: activeReports().filter((r) => map.contains(r.lat, r.lng)),
    evalOf,
    waterOf: waterCm,
    isOfficial,
    userId,
    femaFor,
    distanceFt,
    ownsReport,
    canRemoveReport: (r) => ownsReport(r) || isOfficial(),
    browserAlerts: browserAlertState(),
  };
}

function replayProfile(s) {
  const info = s.lat != null ? risk.analyze(s.lat, s.lng) : null;
  const score = info && !info.outside ? info.heavy : 0.6;
  let hash = 0;
  for (const ch of s.id) hash = (hash * 31 + ch.charCodeAt(0)) % 997;
  return { peak: s.alert_depth_cm * (1.15 + 0.7 * score), center: 78 + (hash % 18), sd: 24 };
}

function addReading(r) {
  if (r.id != null && state.seen.has(r.id)) return;
  const sensor = sensorById(r.sensor_id);
  if (!sensor) return;
  if (!r.simulated && sim.drives(sensor)) return;
  if (r.id != null) state.seen.add(r.id);
  if (!r.simulated && (!state.lastDbReading || r.created_at > state.lastDbReading)) state.lastDbReading = r.created_at;
  let list = state.readings.get(r.sensor_id);
  if (!list) {
    list = [];
    state.readings.set(r.sensor_id, list);
  }
  list.push(r);
  const n = list.length;
  if (n > 1 && Date.parse(list[n - 2].created_at) > Date.parse(r.created_at)) {
    list.sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
  }
  if (list.length > 1500) list.splice(0, list.length - 1500);
}

async function pollReadings() {
  const ids = state.sensors.filter((s) => !s.is_simulated && !sim.drives(s)).map((s) => s.id);
  try {
    (await data.fetchNewReadings(ids, state.lastDbReading)).forEach(addReading);
  } catch (err) {
    console.warn('Polling readings failed', err);
  }
}

async function loadReports() {
  try {
    state.reports = await data.fetchReports();
  } catch (err) {
    console.warn('Loading reports failed', err);
  }
}

function onReport(r) {
  if (state.reports.some((x) => x.id === r.id)) return;
  state.reports.unshift(r);
  if (state.ready && !ownsReport(r) && map.contains(r.lat, r.lng)) {
    notify({ title: 'New flooding report nearby', body: `A resident just reported a ${V.reportKind(r).toLowerCase()} in this part of the map.`, level: 'warning' });
  }
}

function onReportChange(r) {
  const i = state.reports.findIndex((x) => x.id === r.id);
  if (i >= 0) state.reports[i] = { ...state.reports[i], ...r };
}

function onReportGone(r) {
  if (r && r.id != null) state.reports = state.reports.filter((x) => x.id !== r.id);
}

let identityToken = 0;
let loadedFor;
let identityTask = null;

function onIdentityChange(force = false) {
  const uid = userId();
  if (!force && uid === loadedFor) return identityTask || Promise.resolve();
  loadedFor = uid;
  identityToken += 1;
  identityTask = loadIdentity(identityToken);
  return identityTask;
}

async function loadIdentity(token) {
  const stale = () => token !== identityToken;
  state.ready = false;
  state.readings.clear();
  state.seen.clear();
  state.lastDbReading = null;
  tracker.reset();
  try {
    state.profile = state.session ? await data.fetchProfile(userId()) : null;
    if (stale()) return;
    state.sensors = await data.fetchSensors();
    if (stale()) return;
    (await data.fetchRecentReadings(state.sensors.filter((s) => !s.is_simulated).map((s) => s.id))).forEach(addReading);
    if (stale()) return;
    await loadReports();
  } catch (err) {
    console.error('Loading FloodMesh data failed', err);
    notify({ title: 'Couldn\'t reach FloodMesh', body: 'The sensor data didn\'t load. Check your connection and refresh the page.', level: 'warning' });
  }
  if (stale()) return;
  if (!isOfficial() && state.view === 'network') state.view = 'map';
  sim.primeIdle();
  data.unsubscribe(state.channel);
  state.channel = data.subscribe({ onReading: addReading, onReport, onReportChange, onReportGone });
  updateSites();
  state.ready = true;
  renderAll();
}

function onReplayChange(kind) {
  for (const s of state.sensors.filter((x) => x.mode === 'street')) {
    for (const r of state.readings.get(s.id) || []) state.seen.delete(r.id);
    state.readings.set(s.id, []);
    tracker.forget(s.id);
  }
  if (kind === 'start') {
    state.modeBeforeReplay = risk.mode;
    risk.setMode('now');
    map.setRiskMode('now');
  } else {
    const ids = state.sensors.filter((s) => s.mode === 'street' && !s.is_simulated).map((s) => s.id);
    data.fetchRecentReadings(ids).then((rows) => {
      rows.forEach(addReading);
      refresh();
    }).catch(() => {});
    if (state.modeBeforeReplay) {
      risk.setMode(state.modeBeforeReplay);
      map.setRiskMode(state.modeBeforeReplay);
    }
  }
  renderDemo();
  if (state.view === 'sensor') renderPanel();
  refresh();
}

let analysisTimer = null;

function scheduleAnalysis() {
  const c = map.center();
  if (state.place && state.placeAt && distanceFt([c.lat, c.lng], state.placeAt) > 13000) state.place = null;
  clearTimeout(analysisTimer);
  analysisTimer = setTimeout(() => {
    risk.analyzeView(map.view(), map.zoom());
    updateSites();
    refresh();
  }, 450);
  fillLive();
}

function updateNotice() {
  if (map.zoom() < MIN_RISK_ZOOM) {
    map.setNotice('Zoom in to see street-level flood risk.', { label: 'Zoom in', run: () => map.goTo(map.center(), 15) });
  } else if (risk.status === 'loading') {
    map.setNotice('Reading the terrain for this area.');
  } else if (risk.status === 'failed') {
    map.setNotice('Elevation data isn\'t available for this area.');
  } else {
    map.setNotice('');
  }
}

function onRiskUpdate(kind) {
  if (kind === 'terrain' || kind === 'roads') updateSites();
  updateNotice();
  refresh();
}

function updateSites() {
  state.sites = risk.sites(map.view(), state.sensors.filter((s) => s.mode === 'street'));
  map.setSites(map.zoom() >= MIN_RISK_ZOOM ? state.sites : []);
}

function rainInputs(sensor) {
  if (sim.drives(sensor)) return rainFromCurve(replayRainfall, sim.minute());
  const hourly = risk.weather && !risk.weather.error ? rainFromHourly(risk.weather.hourly) : null;
  if (hourly) return hourly;
  return { past1: 0, past3: 0, past6: 0, next1: 0 };
}

function updateForecasts() {
  state.forecasts.clear();
  if (!state.model) return;
  for (const s of state.sensors) {
    if (s.mode !== 'street') continue;
    const ev = state.evals.get(s.id);
    if (!ev || ev.key === 'offline' || ev.key === 'nodata') continue;
    const fc = forecastSensor(state.model, s, (state.readings.get(s.id) || []).slice(-400), rainInputs(s));
    if (fc) state.forecasts.set(s.id, fc);
  }
}

const OBS_STRENGTH = { flooding: 1, warning: 0.7, rising: 0.4 };

function observations() {
  const points = [];
  for (const s of state.sensors) {
    if (s.mode !== 'street' || s.lat == null) continue;
    const strength = OBS_STRENGTH[state.evals.get(s.id)?.key];
    if (strength) points.push({ lat: s.lat, lng: s.lng, strength });
  }
  for (const r of activeReports()) points.push({ lat: r.lat, lng: r.lng, strength: 0.6 });
  return points;
}

function refresh() {
  const now = Date.now();
  state.evals = new Map(state.sensors.map((s) => [s.id, evaluate(s, latestOf(s.id), now)]));
  updateForecasts();
  map.setSensors(state.sensors.filter((s) => s.mode === 'street'), state.evals, state.selectedId);
  map.setReports(activeReports());
  risk.replayRain = sim.running ? sim.rainfall() : null;
  risk.setObservations(observations());
  if (risk.status === 'zoom' || risk.status === 'failed') {
    map.setRiskImage(null);
  } else {
    const image = risk.render();
    if (image) map.setRiskImage(image.url, image.bounds);
  }
  updateNotice();
  fillLive();
  renderReplayStatus();
  if (state.ready) {
    checkAlerts({
      sensors: state.sensors,
      evals: state.evals,
      forecasts: state.forecasts,
      muted: state.muted,
      uid: userId(),
      official: isOfficial(),
      tracker,
      notify,
    });
  }
}

function fill(name, html) {
  const el = panel.querySelector(`[data-live="${name}"]`);
  if (!el || el.__html === html) return;
  el.innerHTML = html;
  el.__html = html;
}

function fillLive() {
  const c = ctx();
  const s = state.selectedId ? sensorById(state.selectedId) : null;
  switch (state.view) {
    case 'map':
      fill('place', V.placeLine(c));
      fill('area', V.areaBlock(c));
      fill('sensor-count', V.sensorCount(c));
      fill('summary', V.summaryLine(c));
      fill('street-list', V.streetList(c));
      fill('report-list', V.reportList(c));
      fill('sites', V.siteList(c));
      break;
    case 'point':
      if (state.point) fill('point', V.pointBody(c));
      break;
    case 'sensor':
      if (!s) break;
      fill('stats', V.statsBlock(c, s));
      fill('model-note', s.mode === 'street' ? V.modelNote(c) : '');
      fill('site-profile', V.siteProfile(c, s));
      fill('mute', V.muteLine(c, s));
      updateChart(s);
      break;
    case 'mine':
      fill('mine', V.mineList(c));
      break;
    case 'network':
      fill('health', V.healthTable(c));
      fill('sites', V.siteList(c));
      fill('report-list', V.reportList(c));
      break;
    case 'add':
      if (state.wizard.step === 3) {
        const ws = sensorById(state.wizard.sensorId);
        fill('calibrate', V.calibrateBody(c, ws, ws ? latestRealOf(ws.id) : null));
      }
      break;
    default:
      break;
  }
}

function setMessage(text, isError = false) {
  panel.querySelectorAll('[data-live="message"]').forEach((el) => {
    el.className = `msg${isError ? ' error' : ''}`;
    el.textContent = text;
  });
}

function renderAll() {
  renderTopbar();
  renderPanel();
  renderDemo();
  refresh();
}

function tabFor(view) {
  if (view === 'sensor') return sensorById(state.selectedId)?.mode === 'personal' ? 'mine' : 'map';
  if (view === 'add') return state.wizard.mode === 'street' ? 'network' : 'mine';
  if (['point', 'report'].includes(view)) return 'map';
  return view;
}

function renderTopbar() {
  const active = tabFor(state.view);
  document.querySelectorAll('#tabs [data-view]').forEach((btn) => {
    btn.classList.toggle('on', btn.dataset.view === active);
    btn.setAttribute('aria-current', btn.dataset.view === active ? 'page' : 'false');
  });
  document.getElementById('tab-network').hidden = !isOfficial();
  document.getElementById('account-btn').textContent = state.session ? (state.profile?.display_name || 'Account') : 'Sign in';
}

const VIEWS = {
  map: (c) => V.mapView(c),
  point: (c) => V.pointView(c),
  sensor: (c) => {
    const s = sensorById(state.selectedId);
    return s ? V.sensorView(c, s) : V.mapView(c);
  },
  report: () => V.reportView(),
  auth: (c) => V.authView(c),
  account: (c) => (state.session ? V.accountView(c) : V.authView(c)),
  mine: (c) => V.mineView(c),
  network: (c) => V.networkView(c),
  add: (c) => V.addView(c),
};

function renderPanel() {
  destroyChart();
  panel.innerHTML = (VIEWS[state.view] || VIEWS.map)(ctx());
  panel.scrollTop = 0;
  panel.classList.remove('enter');
  void panel.offsetWidth;
  panel.classList.add('enter');
  const s = state.view === 'sensor' ? sensorById(state.selectedId) : null;
  if (s) mountChart(s);
}

function chartSeries(sensor) {
  const list = state.readings.get(sensor.id) || [];
  const cutoff = sensor.is_simulated || sim.drives(sensor) ? 0 : Date.now() - HISTORY_MINUTES * 60000;
  const points = list.filter((r) => Date.parse(r.created_at) >= cutoff);
  const step = Math.max(1, Math.ceil(points.length / 240));
  const sampled = points.filter((_, i) => i % step === 0 || i === points.length - 1);
  const at = (r) => Date.parse(r.label_time || r.created_at);
  const water = sampled.map((r) => ({ x: at(r), y: Number(cmToIn(waterCm(sensor, r) ?? 0).toFixed(2)) }));
  const fc = state.forecasts.get(sensor.id);
  const forecast = fc && water.length
    ? [water[water.length - 1], { x: fc.at + 30 * 60000, y: Number(cmToIn(fc.depth30).toFixed(2)) }, { x: fc.at + 60 * 60000, y: Number(cmToIn(fc.depth60).toFixed(2)) }]
    : [];
  const xs = [...water, ...forecast].map((p) => p.x);
  const limit = Number(cmToIn(sensor.alert_depth_cm).toFixed(2));
  const span = xs.length ? [Math.min(...xs), Math.max(...xs)] : [Date.now() - 3600e3, Date.now()];
  return { water, forecast, limitLine: [{ x: span[0], y: limit }, { x: span[1], y: limit }], limit, span };
}

function mountChart(sensor) {
  const canvas = panel.querySelector('#chart');
  if (!canvas || !window.Chart) return;
  const sr = chartSeries(sensor);
  state.chart = new window.Chart(canvas, {
    type: 'line',
    data: {
      datasets: [
        { label: 'Water (in)', data: sr.water, borderColor: '#1d5c8f', backgroundColor: 'rgba(29, 92, 143, 0.08)', fill: true, pointRadius: 0, borderWidth: 1.6, tension: 0.2 },
        { label: 'Forecast (in)', data: sr.forecast, borderColor: '#1d5c8f', borderDash: [3, 3], borderWidth: 1.4, pointRadius: 2.5, pointBackgroundColor: '#1d5c8f', fill: false },
        { label: sensor.mode === 'personal' ? 'Alert level' : 'Impassable', data: sr.limitLine, borderColor: '#a3302a', borderDash: [1, 3], borderWidth: 1.2, pointRadius: 0, fill: false },
      ],
    },
    options: {
      animation: false,
      responsive: true,
      maintainAspectRatio: false,
      parsing: false,
      interaction: { mode: 'nearest', intersect: false, axis: 'x' },
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { title: (items) => (items.length ? fmtClock(new Date(items[0].parsed.x).toISOString()) : '') } },
      },
      scales: {
        x: {
          type: 'linear',
          min: sr.span[0],
          max: sr.span[1],
          ticks: { maxTicksLimit: 5, maxRotation: 0, callback: (v) => fmtClock(new Date(v).toISOString()) },
          grid: { display: false },
          border: { color: '#cfc9bd' },
        },
        y: { beginAtZero: true, suggestedMax: sr.limit * 1.3, grid: { color: '#ece8df' }, border: { display: false }, title: { display: true, text: 'inches' } },
      },
    },
  });
  state.chartFor = sensor.id;
}

function updateChart(sensor) {
  if (!state.chart || state.chartFor !== sensor.id) return;
  const sr = chartSeries(sensor);
  state.chart.data.datasets[0].data = sr.water;
  state.chart.data.datasets[1].data = sr.forecast;
  state.chart.data.datasets[2].data = sr.limitLine;
  state.chart.options.scales.x.min = sr.span[0];
  state.chart.options.scales.x.max = sr.span[1];
  state.chart.options.scales.y.suggestedMax = sr.limit * 1.3;
  state.chart.update('none');
}

function destroyChart() {
  if (state.chart) state.chart.destroy();
  state.chart = null;
  state.chartFor = null;
}

function renderReplayStatus() {
  const el = document.getElementById('replay-status');
  if (!sim.running) {
    el.hidden = true;
    return;
  }
  el.hidden = false;
  el.innerHTML = `<span class="pulse"></span>Storm replay at ${fmtClock(sim.clock().toISOString())}, ${sim.rainfall().toFixed(1)} in/hr <button class="link" data-action="replay-stop">Stop</button>`;
}

function renderDemo() {
  const el = document.getElementById('demo');
  const home = state.sensors.find((s) => s.mode === 'personal' && s.is_simulated && s.owner_id === userId());
  el.innerHTML = `
    <div class="demo-head"><strong>Demo controls</strong><button class="link" data-demo="close">Close</button></div>
    <p>Storm replay plays a simulated three-hour storm at ${REPLAY.speed} times normal speed through the street sensors in your account, so you can see how forecasts and alerts behave without waiting for rain.</p>
    <p><button class="btn small" data-demo="${sim.running ? 'replay-stop' : 'replay-start'}">${sim.running ? 'Stop the replay' : 'Start a storm replay'}</button></p>
    ${home ? `<p>Home demo unit</p><p class="demo-row"><button class="btn small ghost" data-demo="basement">Water on the floor</button><button class="btn small ghost" data-demo="battery">Low battery</button><button class="btn small ghost" data-demo="reset">Reset</button></p>` : ''}`;
}

function toggleDemo(force) {
  const el = document.getElementById('demo');
  el.hidden = force === undefined ? !el.hidden : !force;
  if (!el.hidden) renderDemo();
}

function goTo(view, { selectedId = null } = {}) {
  const leaving = state.view;
  if (['report', 'point', 'add'].includes(leaving) && view !== leaving) map.clearPin();
  if (view !== 'point') state.point = null;
  state.view = view;
  state.selectedId = selectedId;
  renderAll();
}

function openSensor(id) {
  if (state.view === 'report' || (state.view === 'add' && state.wizard.step === 2)) return;
  const s = sensorById(id);
  if (!s) return;
  goTo('sensor', { selectedId: id });
  if (s.lat != null) map.panTo([s.lat, s.lng]);
}

function openPoint(latlng, title = null) {
  map.clearPin();
  state.point = [latlng.lat, latlng.lng];
  state.pointTitle = title;
  state.view = 'point';
  state.selectedId = null;
  renderAll();
  map.setPin(latlng, false);
  const [lat, lng] = state.point;
  placeName(lat, lng)
    .then((name) => {
      if (name && state.point && state.point[0] === lat) fill('point-place', `${escapeHtml(name)}<br><span class="mono">${lat.toFixed(5)}, ${lng.toFixed(5)}</span>`);
    })
    .catch(() => {});
}

function openSite(k) {
  const site = state.sites[k];
  if (!site) return;
  openPoint(L.latLng(site.lat, site.lng), `Suggested site ${k + 1}${site.road ? `: ${site.road}` : ''}`);
}

function onMapClick(latlng) {
  if (state.view === 'report') {
    map.setPin(latlng, true);
  } else if (state.view === 'add' && state.wizard.step === 2 && state.wizard.mode === 'street') {
    setWizardPoint(latlng);
  } else {
    openPoint(latlng);
  }
}

function setWizardPoint(latlng) {
  state.wizard.point = latlng;
  map.setPin(latlng, true, (moved) => {
    state.wizard.point = moved;
    fill('pick-point', `${moved.lat.toFixed(5)}, ${moved.lng.toFixed(5)}`);
  });
  fill('pick-point', `${latlng.lat.toFixed(5)}, ${latlng.lng.toFixed(5)}`);
}

function startWizard(mode, point = null) {
  if (!state.session) {
    state.authMode = 'signin';
    state.afterAuth = { view: 'add', mode };
    goTo('auth');
    return;
  }
  state.wizard = freshWizard(mode === 'street' && isOfficial() ? 'street' : 'personal');
  goTo('add');
  if (point) state.wizard.pendingPoint = point;
}

async function calibrateSensor(id) {
  const s = sensorById(id);
  const r = latestRealOf(id);
  if (!s || !r || Date.now() - Date.parse(r.created_at) > 60000) {
    setMessage('The sensor hasn\'t sent a fresh reading yet. Make sure it\'s powered and online, then try again.', true);
    return false;
  }
  const mount = Number((r.distance_mm / 10).toFixed(1));
  try {
    await data.updateSensor(id, { mount_height_cm: mount });
    s.mount_height_cm = mount;
    return true;
  } catch (err) {
    setMessage(`That didn't save: ${err.message}`, true);
    return false;
  }
}

async function handleAction(action, el) {
  switch (action) {
    case 'select':
      openSensor(el.dataset.id);
      break;
    case 'to-map':
    case 'back':
      goTo('map');
      break;
    case 'to-mine':
      goTo('mine');
      break;
    case 'goto':
      goTo(el.dataset.view);
      break;
    case 'auth-toggle':
      state.authMode = state.authMode === 'signin' ? 'signup' : 'signin';
      renderPanel();
      break;
    case 'auth-create':
      state.authMode = 'signup';
      goTo('auth');
      break;
    case 'report-start':
      goTo('report');
      map.setPin(map.center(), true);
      break;
    case 'report-here': {
      const [lat, lng] = state.point;
      goTo('report');
      map.setPin(L.latLng(lat, lng), true);
      break;
    }
    case 'focus-report':
      map.openReport(Number(el.dataset.id));
      break;
    case 'report-remove': {
      const id = Number(el.dataset.id);
      if (!window.confirm('Remove this report from the map?')) break;
      try {
        const removed = await data.deleteReport(id, reporterToken);
        if (removed) {
          state.reports = state.reports.filter((r) => r.id !== id);
          state.myReports.delete(id);
          saveSet('floodmesh-my-reports', state.myReports);
          map.closePopups();
          notify({ title: 'Report removed', body: 'It no longer appears on the map.', level: 'info' });
        } else {
          notify({ title: 'Couldn\'t remove that report', body: 'Only the person who sent it, from the same browser, or town staff can remove it.', level: 'warning' });
        }
      } catch (err) {
        notify({ title: 'Couldn\'t remove that report', body: err.message, level: 'warning' });
      }
      refresh();
      break;
    }
    case 'report-clear': {
      const id = Number(el.dataset.id);
      try {
        const clears = await data.clearReport(id, voterToken);
        state.cleared.add(id);
        saveSet('floodmesh-cleared', state.cleared);
        if (clears >= 2) state.reports = state.reports.filter((r) => r.id !== id);
        map.closePopups();
      } catch (err) {
        notify({ title: 'That didn\'t go through', body: err.message, level: 'warning' });
      }
      refresh();
      break;
    }
    case 'site':
      openSite(Number(el.dataset.k));
      break;
    case 'add-start':
      startWizard(el.dataset.mode);
      break;
    case 'add-here': {
      const [lat, lng] = state.point;
      startWizard('street', L.latLng(lat, lng));
      break;
    }
    case 'add-back':
      state.wizard.step = 1;
      renderPanel();
      break;
    case 'add-cancel':
      goTo(state.wizard.mode === 'street' ? 'network' : 'mine');
      break;
    case 'add-calibrate':
      if (await calibrateSensor(state.wizard.sensorId)) {
        notify({ title: 'Sensor ready', body: 'The dry level is saved, and the sensor is now monitoring.', level: 'info' });
        goTo('sensor', { selectedId: state.wizard.sensorId });
      }
      break;
    case 'add-finish':
      goTo('sensor', { selectedId: state.wizard.sensorId });
      break;
    case 'mute':
      if (state.muted.has(el.dataset.id)) state.muted.delete(el.dataset.id);
      else state.muted.add(el.dataset.id);
      saveSet('floodmesh-muted', state.muted);
      fillLive();
      break;
    case 'calibrate':
      if (await calibrateSensor(el.dataset.id)) {
        renderPanel();
        setMessage(`The dry level is now ${fmtIn(sensorById(el.dataset.id).mount_height_cm)} below the sensor.`);
      }
      break;
    case 'remove-sensor': {
      const s = sensorById(el.dataset.id);
      if (!s || !window.confirm(`Remove ${s.name}? It will stop reporting until you pair it again.`)) break;
      try {
        await data.removeSensor(s.id);
        state.sensors = state.sensors.filter((x) => x.id !== s.id);
        state.readings.delete(s.id);
        notify({ title: `${s.name} removed`, body: 'You can pair the same sensor again later with its pairing code.', level: 'info' });
        goTo(s.mode === 'personal' ? 'mine' : 'network');
      } catch (err) {
        setMessage(`Couldn't remove it: ${err.message}`, true);
      }
      break;
    }
    case 'signout':
      await data.auth.signOut();
      state.session = null;
      await onIdentityChange();
      goTo('map');
      break;
    case 'alerts-enable':
      await enableBrowserAlerts();
      renderPanel();
      break;
    case 'demo-toggle':
      toggleDemo();
      break;
    case 'how':
      showWelcome('how');
      break;
    case 'stack':
      showWelcome('stack');
      break;
    case 'locate':
      locate();
      break;
    case 'zoom-point':
      if (state.point) map.goTo(state.point, 15);
      break;
    case 'replay-stop':
      sim.stop();
      break;
    default:
      break;
  }
}

function field(form, name) {
  const el = form.querySelector(`[name="${name}"]:checked`) || form.querySelector(`[name="${name}"]`);
  return el ? el.value : '';
}

async function handleForm(name, form) {
  try {
    if (name === 'auth') await submitAuth(form);
    else if (name === 'report') await submitReport(form);
    else if (name === 'pair-code') await submitPairCode(form);
    else if (name === 'pair-details') await submitPairDetails(form);
    else if (name === 'alert-depth') await submitAlertDepth(form);
  } catch (err) {
    setMessage(err.message, true);
  }
}

async function submitAuth(form) {
  const email = field(form, 'email').trim();
  const password = field(form, 'password');
  setMessage('One moment.');
  const result = state.authMode === 'signin'
    ? await data.auth.signIn(email, password)
    : await data.auth.signUp(email, password, field(form, 'name').trim());
  if (result.error) {
    setMessage(result.error.message, true);
    return;
  }
  if (!result.data.session) {
    setMessage('Your account was created. Check your email to confirm it, and then sign in.');
    return;
  }
  state.session = result.data.session;
  await onIdentityChange();
  const next = state.afterAuth;
  state.afterAuth = null;
  if (next && next.view === 'add') startWizard(next.mode);
  else goTo(isOfficial() ? 'network' : 'mine');
}

async function submitReport(form) {
  const point = map.getPin();
  if (!point) {
    setMessage('Drop the pin on the map first so people know where the problem is.', true);
    return;
  }
  setMessage('Sending.');
  const row = await data.fileReport({ lat: point.lat, lng: point.lng, kind: field(form, 'kind'), note: field(form, 'note').trim(), token: reporterToken });
  state.myReports.add(row.id);
  saveSet('floodmesh-my-reports', state.myReports);
  if (!state.reports.some((r) => r.id === row.id)) state.reports.unshift(row);
  goTo('map');
  notify({ title: 'Report sent', body: 'It\'s on the map now. You can remove it from the list if you made a mistake.', level: 'info' });
}

function normalizeCode(raw) {
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

async function submitPairCode(form) {
  const code = normalizeCode(field(form, 'code'));
  if (!/^[A-Z0-9]{6}$/.test(code)) {
    setMessage('Pairing codes have six letters and numbers, like ABC-123.', true);
    return;
  }
  setMessage('Looking for the sensor.');
  const found = await data.checkPairingCode(code);
  if (!found) {
    setMessage('No sensor is waiting with that code. Check that its setup page says it\'s connected, then try again.', true);
    return;
  }
  state.wizard.code = code;
  state.wizard.step = 2;
  renderPanel();
  if (state.wizard.pendingPoint && state.wizard.mode === 'street') setWizardPoint(state.wizard.pendingPoint);
}

async function submitPairDetails(form) {
  const wz = state.wizard;
  const mode = isOfficial() ? field(form, 'mode') || wz.mode : 'personal';
  wz.name = field(form, 'name').trim();
  wz.note = field(form, 'note').trim();
  if (mode === 'street' && !wz.point) {
    setMessage('Click the map to show where the sensor is mounted.', true);
    return;
  }
  setMessage('Pairing.');
  const id = await data.claimDevice({
    code: wz.code,
    mode,
    name: wz.name,
    note: wz.note,
    lat: mode === 'street' ? wz.point.lat : null,
    lng: mode === 'street' ? wz.point.lng : null,
    alertCm: Number(field(form, 'depth')) * 2.54,
  });
  const sensor = await data.fetchSensor(id);
  if (sensor) state.sensors.push(sensor);
  wz.sensorId = id;
  wz.mode = mode;
  wz.step = 3;
  map.clearPin();
  updateSites();
  renderAll();
}

async function submitAlertDepth(form) {
  const id = form.dataset.id;
  const cm = Number(field(form, 'depth')) * 2.54;
  await data.updateSensor(id, { alert_depth_cm: cm });
  const s = sensorById(id);
  if (s) s.alert_depth_cm = cm;
  setMessage(`Saved. Alerts will now go off at ${fmtIn(cm)}.`);
  refresh();
}

function locate() {
  if (!navigator.geolocation) {
    notify({ title: 'Location unavailable', body: 'This browser can\'t share your location.', level: 'info' });
    return;
  }
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      state.place = 'Around your location';
      state.placeAt = [pos.coords.latitude, pos.coords.longitude];
      map.goTo([pos.coords.latitude, pos.coords.longitude], 16);
    },
    () => notify({ title: 'Location unavailable', body: 'Your browser didn\'t share a location. You can search for a place instead.', level: 'info' }),
    { enableHighAccuracy: false, timeout: 10000 },
  );
}

async function runSearch(query) {
  const box = document.getElementById('search-results');
  if (!query.trim()) return;
  box.hidden = false;
  box.innerHTML = '<p class="search-note">Searching.</p>';
  try {
    const results = await searchPlaces(query);
    if (!results.length) {
      box.innerHTML = '<p class="search-note">Nothing matched that search.</p>';
      return;
    }
    showPlace(results[0]);
    box.innerHTML = results.map((r, k) => `<button type="button" data-k="${k}">${escapeHtml(r.name)}</button>`).join('');
    box.onclick = (e) => {
      const btn = e.target.closest('[data-k]');
      if (!btn) return;
      showPlace(results[Number(btn.dataset.k)]);
      box.hidden = true;
    };
  } catch (err) {
    box.innerHTML = '<p class="search-note">Search isn\'t available right now.</p>';
  }
}

function showPlace(place) {
  state.place = place.short;
  state.placeAt = [place.lat, place.lng];
  if (state.view !== 'map') goTo('map');
  if (place.bounds) map.fitBounds(place.bounds, 16);
  else map.goTo([place.lat, place.lng], 16);
}

const WELCOME_SECTIONS = { how: 'how-it-works', stack: 'how-its-built', who: 'who-its-for' };

function scrollWelcome(section) {
  const target = document.getElementById(WELCOME_SECTIONS[section]);
  if (target && target.scrollIntoView) target.scrollIntoView({ behavior: 'smooth' });
}

function showWelcome(section = null) {
  const el = document.getElementById('welcome');
  el.innerHTML = welcomeHtml();
  el.hidden = false;
  document.body.classList.add('welcome-open');
  el.scrollTop = 0;
  if (section) {
    const target = document.getElementById(WELCOME_SECTIONS[section]);
    if (target && target.scrollIntoView) target.scrollIntoView();
  }
}

function hideWelcome(go) {
  document.getElementById('welcome').hidden = true;
  document.body.classList.remove('welcome-open');
  persist('floodmesh-welcomed', '1');
  if (go === 'auth') {
    state.authMode = 'signin';
    goTo('auth');
  } else if (go === 'mine') {
    goTo('mine');
  } else {
    goTo('map');
  }
  map.resize();
}

panel.addEventListener('click', (e) => {
  const el = e.target.closest('[data-action]');
  if (!el || el.disabled) return;
  handleAction(el.dataset.action, el);
});

panel.addEventListener('submit', (e) => {
  const form = e.target.closest('[data-form]');
  if (!form) return;
  e.preventDefault();
  handleForm(form.dataset.form, form);
});

panel.addEventListener('change', (e) => {
  if (e.target.name === 'mode' && state.view === 'add' && state.wizard.step === 2) {
    const form = e.target.closest('form');
    state.wizard.name = field(form, 'name');
    state.wizard.note = field(form, 'note');
    state.wizard.mode = e.target.value;
    if (state.wizard.mode !== 'street') map.clearPin();
    renderPanel();
    if (state.wizard.mode === 'street' && state.wizard.point) setWizardPoint(state.wizard.point);
  }
});

panel.addEventListener('input', (e) => {
  if (!e.target.classList.contains('code-input')) return;
  const raw = normalizeCode(e.target.value).slice(0, 6);
  e.target.value = raw.length > 3 ? `${raw.slice(0, 3)}-${raw.slice(3)}` : raw;
});

document.addEventListener('click', (e) => {
  const el = e.target.closest('.leaflet-popup [data-action]');
  if (el) handleAction(el.dataset.action, el);
  if (!e.target.closest('.search')) document.getElementById('search-results').hidden = true;
});

document.getElementById('tabs').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-view]');
  if (btn) goTo(btn.dataset.view);
});

document.getElementById('account-btn').addEventListener('click', () => {
  state.authMode = 'signin';
  goTo(state.session ? 'account' : 'auth');
});

document.getElementById('how-btn').addEventListener('click', () => showWelcome());

document.getElementById('search').addEventListener('submit', (e) => {
  e.preventDefault();
  runSearch(e.target.querySelector('input').value);
});

document.getElementById('replay-status').addEventListener('click', (e) => {
  if (e.target.closest('[data-action="replay-stop"]')) sim.stop();
});

document.getElementById('demo').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-demo]');
  if (!btn) return;
  const act = btn.dataset.demo;
  if (act === 'close') toggleDemo(false);
  else if (act === 'replay-start') sim.start();
  else if (act === 'replay-stop') sim.stop();
  else if (act === 'basement') sim.basementWater();
  else if (act === 'battery') sim.lowBattery();
  else if (act === 'reset') sim.resetHome();
});

document.getElementById('welcome').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-welcome]');
  if (!btn) return;
  if (WELCOME_SECTIONS[btn.dataset.welcome]) scrollWelcome(btn.dataset.welcome);
  else hideWelcome(btn.dataset.welcome);
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !document.getElementById('welcome').hidden) {
    hideWelcome('map');
    return;
  }
  if (e.target instanceof Element && e.target.closest('input, textarea, select')) return;
  if (e.shiftKey && e.key.toLowerCase() === 'd') toggleDemo();
});

async function start() {
  if (window.Chart) {
    window.Chart.defaults.font.family = "'Atkinson Hyperlegible', system-ui, sans-serif";
    window.Chart.defaults.font.size = 11;
    window.Chart.defaults.color = '#5f6e7c';
  }
  renderAll();
  let welcomed = false;
  try {
    welcomed = localStorage.getItem('floodmesh-welcomed') === '1';
  } catch {
    welcomed = false;
  }
  if (!welcomed) showWelcome();
  state.session = await data.auth.session();
  data.auth.onChange((session) => {
    state.session = session;
    setTimeout(() => onIdentityChange(), 0);
  });
  loadForecastModel().then((model) => {
    state.model = model;
    if (model) refresh();
  });
  scheduleAnalysis();
  await onIdentityChange(true);
  setInterval(refresh, 1000);
  setInterval(pollReadings, 15000);
  setInterval(() => {
    if (state.view === 'add' && state.wizard.step === 3) pollReadings();
  }, 4000);
  setInterval(loadReports, 60000);
  window.addEventListener('resize', () => map.resize());
}

start();
