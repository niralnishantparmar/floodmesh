import {
  SUPABASE_URL, SUPABASE_KEY, AREA_NAME, MAP_CENTER, MAP_ZOOM, HISTORY_MINUTES, LOW_BATTERY_PCT, REPLAY, RISK_BOUNDS,
} from './config.js';
import {
  STATUS, REPORT_KINDS, statusLabel, waterCm, evaluate, summarize, cmToIn,
  fmtIn, fmtCm, fmtRise, fmtEta, fmtAge, fmtClock, fmtTempF, escapeHtml,
} from './logic.js';
import { Simulator } from './sim.js';
import { notify, browserAlertState, enableBrowserAlerts } from './notify.js';
import { MapView } from './mapview.js';
import { RiskEngine } from './insight.js';
import { femaZoneAt, describeZone } from './sources.js';
import { icon } from './icons.js';
import { welcomeHtml } from './welcome.js';

const db = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
const panel = document.getElementById('panel');

const state = {
  ready: false,
  session: null,
  profile: null,
  view: 'public',
  selectedId: null,
  authMode: 'signin',
  sensors: [],
  readings: new Map(),
  seen: new Set(),
  lastDbReading: null,
  reports: [],
  myReports: new Set(),
  reportPending: false,
  keys: new Map(),
  evals: new Map(),
  prevStatus: new Map(),
  lowBattery: new Set(),
  muted: new Set(readMuted()),
  installPoint: null,
  point: null,
  sites: [],
  femaCache: new Map(),
  chart: null,
  chartFor: null,
  channel: null,
};

function readMuted() {
  try {
    return JSON.parse(localStorage.getItem('floodmesh-muted') || '[]');
  } catch {
    return [];
  }
}

function saveMuted() {
  try {
    localStorage.setItem('floodmesh-muted', JSON.stringify([...state.muted]));
  } catch {
    /* storage unavailable, keep in memory */
  }
}

// Read a form field by name without relying on legacy named-property access.
const field = (form, name) => {
  const el = form.querySelector(`[name="${name}"]:checked`) || form.querySelector(`[name="${name}"]`);
  return el ? el.value : '';
};
const isOfficial = () => state.profile?.role === 'official';
const userId = () => state.session?.user?.id ?? null;
const sensorById = (id) => state.sensors.find((s) => s.id === id);
const latestOf = (id) => {
  const list = state.readings.get(id);
  return list && list.length ? list[list.length - 1] : null;
};
const latestRealOf = (id) => {
  const list = state.readings.get(id) || [];
  for (let i = list.length - 1; i >= 0; i -= 1) {
    if (!list[i].simulated && list[i].distance_mm != null) return list[i];
  }
  return null;
};

// Map and simulator ------------------------------------------------------

const map = new MapView('map', {
  center: MAP_CENTER,
  zoom: MAP_ZOOM,
  onSelect: (id) => selectSensor(id),
  onSiteSelect: (k) => openSite(k),
  onRiskMode: (mode) => {
    risk.setMode(mode);
    refreshLive();
  },
  onMapClick: (latlng) => {
    if (state.view === 'install') {
      setInstallPoint(latlng);
    } else if (state.view === 'report') {
      map.setPin(latlng, true);
    } else {
      openPoint(latlng);
    }
  },
});

function setInstallPoint(latlng) {
  state.installPoint = latlng;
  map.setPin(latlng, true).off('dragend').on('dragend', (e) => {
    state.installPoint = e.target.getLatLng();
    fillInstallPoint();
  });
  fillInstallPoint();
}

const risk = new RiskEngine({ bounds: RISK_BOUNDS, center: MAP_CENTER, onUpdate: (kind) => onRiskUpdate(kind) });

const sim = new Simulator({
  getSensors: () => state.sensors,
  emit: (reading) => addReading(reading),
  onChange: (kind) => onReplayChange(kind),
});

// Data -------------------------------------------------------------------

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

async function loadSensors() {
  const { data, error } = await db.from('sensors').select('*').order('created_at', { ascending: true });
  if (error) {
    console.error('Loading sensors failed', error);
    state.sensors = [];
    return false;
  }
  state.sensors = data || [];
  return true;
}

async function loadReadings(ids) {
  if (!ids.length) return;
  const since = new Date(Date.now() - HISTORY_MINUTES * 60000).toISOString();
  const { data, error } = await db
    .from('readings')
    .select('*')
    .in('sensor_id', ids)
    .gte('created_at', since)
    .order('created_at', { ascending: true })
    .limit(1000);
  if (error) console.error('Loading readings failed', error);
  (data || []).forEach(addReading);

  // Sensors that have been quiet for over an hour still need their last reading,
  // so they can show as offline with a "last seen" time.
  for (const id of ids) {
    if (latestOf(id)) continue;
    const { data: last } = await db
      .from('readings')
      .select('*')
      .eq('sensor_id', id)
      .order('created_at', { ascending: false })
      .limit(1);
    if (last && last.length) addReading(last[0]);
  }
}

async function pollReadings() {
  const ids = state.sensors.filter((s) => !s.is_simulated && !sim.drives(s)).map((s) => s.id);
  if (!ids.length) return;
  let query = db.from('readings').select('*').in('sensor_id', ids).order('created_at', { ascending: true }).limit(500);
  if (state.lastDbReading) query = query.gt('created_at', state.lastDbReading);
  else query = query.gte('created_at', new Date(Date.now() - HISTORY_MINUTES * 60000).toISOString());
  const { data, error } = await query;
  if (!error) (data || []).forEach(addReading);
}

async function loadReports() {
  const { data, error } = await db.from('reports').select('*').order('created_at', { ascending: false }).limit(200);
  if (error) {
    console.error('Loading reports failed', error);
    return;
  }
  state.reports = data || [];
}

function activeReports() {
  const now = Date.now();
  return state.reports.filter((r) => Date.parse(r.expires_at) > now);
}

function addReport(r) {
  if (state.reports.some((x) => x.id === r.id)) return;
  state.reports.unshift(r);
  if (state.ready && !state.reportPending && !state.myReports.has(r.id)) {
    notify({
      title: 'New flooding report nearby',
      body: `${REPORT_KINDS[r.kind] || 'Hazard'} reported by a resident.${r.note ? ` "${r.note}"` : ''}`,
      level: 'warning',
    });
  }
}

function subscribe() {
  if (state.channel) db.removeChannel(state.channel);
  state.channel = db
    .channel('floodmesh-live')
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'readings' }, (payload) => addReading(payload.new))
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'reports' }, (payload) => addReport(payload.new))
    .subscribe();
}

async function loadProfile() {
  state.profile = null;
  if (!state.session) return;
  const { data, error } = await db.from('profiles').select('*').eq('id', userId()).maybeSingle();
  if (error) console.error('Loading profile failed', error);
  state.profile = data || null;
}

let loadedFor;
let identityTask = null;
let identityToken = 0;

function onIdentityChange(force = false) {
  const uid = userId();
  if (!force && uid === loadedFor) return identityTask || Promise.resolve();
  loadedFor = uid;
  identityToken += 1;
  const token = identityToken;
  identityTask = loadIdentity(token);
  return identityTask;
}

async function loadIdentity(token) {
  const stale = () => token !== identityToken;
  state.ready = false;
  state.readings.clear();
  state.seen.clear();
  state.lastDbReading = null;
  state.keys.clear();
  state.prevStatus.clear();
  state.lowBattery.clear();

  await loadProfile();
  if (stale()) return;
  if (!isOfficial() && (state.view === 'municipal' || state.view === 'install')) state.view = 'public';
  await loadSensors();
  if (stale()) return;
  await loadReadings(state.sensors.filter((s) => !s.is_simulated).map((s) => s.id));
  if (stale()) return;
  await loadReports();
  if (stale()) return;
  sim.primeIdle();
  subscribe();

  const points = state.sensors.filter((s) => s.mode === 'street' && s.lat != null).map((s) => [s.lat, s.lng]);
  map.fit(points);
  updateSites();
  state.ready = true;
  renderAll();
}

let modeBeforeReplay = null;

function onReplayChange(kind) {
  if (kind === 'start') {
    modeBeforeReplay = risk.mode;
    risk.setMode('now');
    map.setRiskMode('now');
  } else if (kind === 'stop' && modeBeforeReplay) {
    risk.setMode(modeBeforeReplay);
    map.setRiskMode(modeBeforeReplay);
    modeBeforeReplay = null;
  }
  const driven = state.sensors.filter((s) => s.mode === 'street' && (s.is_simulated || (kind === 'start' && sim.includeReal) || (kind === 'stop' && !s.is_simulated)));
  for (const s of driven) {
    for (const r of state.readings.get(s.id) || []) state.seen.delete(r.id);
    state.readings.set(s.id, []);
    state.prevStatus.delete(s.id);
  }
  if (kind === 'stop') {
    const realIds = driven.filter((s) => !s.is_simulated).map((s) => s.id);
    loadReadings(realIds).then(() => refreshLive());
    sim.primeIdle();
  }
  renderDemo();
  if (state.selectedId) renderPanel();
  refreshLive();
}

// Alerts -----------------------------------------------------------------

function checkAlerts() {
  if (!state.ready) return;
  const uid = userId();
  for (const s of state.sensors) {
    const ev = state.evals.get(s.id);
    if (!ev) continue;
    const prev = state.prevStatus.get(s.id);
    state.prevStatus.set(s.id, ev.key);
    const owned = s.owner_id === uid && uid != null;

    if (s.mode === 'personal' && owned && ev.battery != null) {
      if (ev.battery < LOW_BATTERY_PCT && !state.lowBattery.has(s.id)) {
        state.lowBattery.add(s.id);
        if (prev !== undefined) {
          notify({
            title: `${s.name} sensor battery low`,
            body: `Battery at ${Math.round(ev.battery)}%. Plug it into any USB phone charger to keep it monitoring.`,
            level: 'warning',
          });
        }
      } else if (ev.battery >= LOW_BATTERY_PCT + 5) {
        state.lowBattery.delete(s.id);
      }
    }

    if (prev === undefined || prev === 'nodata' || prev === ev.key) continue;
    const rank = STATUS[ev.key].rank;
    const prevRank = STATUS[prev].rank;

    if (s.mode === 'street') {
      if (!state.muted.has(s.id)) {
        if (ev.key === 'warning' && prevRank < 2) {
          notify({
            title: `Water rising at ${s.name}`,
            body: `${fmtIn(ev.water)} on the road now. Expected to become impassable in ${fmtEta(ev.etaMin) || 'the next half hour'}.`,
            level: 'warning',
          });
        } else if (ev.key === 'flooding') {
          notify({
            title: `Flooding at ${s.name}`,
            body: `${fmtIn(ev.water)} of water above the road surface. Use another route.`,
            level: 'danger',
          });
        } else if (prev === 'flooding' && rank >= 0) {
          notify({
            title: `Water dropping at ${s.name}`,
            body: `Level is back below ${fmtIn(s.alert_depth_cm)}. Watch for debris on the road.`,
            level: 'info',
          });
        }
      }
      if (isOfficial() && ev.key === 'offline') {
        notify({
          title: `${s.name} stopped reporting`,
          body: `No reading for ${fmtAge(ev.ageSec).replace(' ago', '')}. Check power and Wi-Fi at the site.`,
          level: 'warning',
        });
      }
    } else if (owned) {
      if (ev.key === 'flooding') {
        notify({
          title: `Water detected: ${s.name}`,
          body: `${fmtIn(ev.water)} of standing water under the sensor. Check for a leak or burst pipe.`,
          level: 'danger',
        });
      } else if (ev.key === 'offline') {
        notify({
          title: `${s.name} sensor is offline`,
          body: 'Check that it has power and is within range of your Wi-Fi.',
          level: 'warning',
        });
      } else if (prev === 'flooding') {
        notify({ title: `${s.name} is dry again`, body: 'The sensor no longer detects standing water.', level: 'info' });
      }
    }
  }
}

// Rendering --------------------------------------------------------------

function renderAll() {
  renderTopbar();
  renderPanel();
  renderDemo();
  refreshLive();
}

function renderTopbar() {
  document.querySelectorAll('#tabs [data-view]').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.view === tabFor(state.view));
  });
  document.getElementById('tab-municipal').hidden = !isOfficial();
  const account = document.getElementById('account-btn');
  account.textContent = state.session ? (state.profile?.display_name || 'Account') : 'Sign in';
}

function tabFor(view) {
  if (view === 'report' || view === 'point') return 'public';
  if (view === 'install') return 'municipal';
  return view;
}

function renderPanel() {
  destroyChart();
  const views = {
    public: () => (state.selectedId ? streetDetailView() : publicListView()),
    point: pointView,
    report: reportView,
    auth: authView,
    account: accountView,
    home: homeView,
    municipal: municipalView,
    install: installView,
  };
  panel.innerHTML = (views[state.view] || publicListView)();
  panel.scrollTop = 0;
  const sensor = state.selectedId && sensorById(state.selectedId);
  if (sensor && panel.querySelector('#chart')) mountChart(sensor);
}

function publicListView() {
  return `
    <header class="panel-head">
      <h1>Street flood conditions</h1>
      <p class="muted">${escapeHtml(AREA_NAME)}</p>
    </header>
    <div data-live="area"></div>
    <p class="hint">${icon('target')}<span>Click anywhere on the map to see the flood risk at that spot and why.</span></p>
    <section class="section tight">
      <div class="section-head"><h2>Street sensors</h2></div>
      <p class="summary" data-live="summary"></p>
      <div class="sensor-list" data-live="street-list"></div>
    </section>
    <section class="section">
      <div class="section-head">
        <h2>Community reports</h2>
        <button class="btn btn-secondary btn-small" data-action="report-start">Report flooding</button>
      </div>
      <div data-live="report-list"></div>
    </section>
    <section class="section">
      <div class="section-head"><h2>Where sensors are needed next</h2></div>
      <p class="muted small">Low spots on roads with no sensor nearby, ranked by how easily water collects there.</p>
      <div data-live="sites"></div>
    </section>
    ${footer()}`;
}

function footer(kind = 'street') {
  const note = kind === 'home'
    ? 'Home alerts are informational and do not replace a monitored alarm or a plumber.'
    : 'FloodMesh readings are informational. They do not replace warnings from Edison Township, Middlesex County, or the National Weather Service.';
  return `
    <footer class="panel-foot">
      <p>${note}</p>
      <button class="link-btn" data-action="demo-toggle">Demo controls</button>
    </footer>`;
}

function streetDetailView() {
  const s = sensorById(state.selectedId);
  if (!s) return publicListView();
  return `
    <button class="back" data-action="back">All sensors</button>
    <header class="detail-head">
      <h1>${escapeHtml(s.name)}</h1>
      <p class="muted">${escapeHtml(s.location_note || '')}</p>
    </header>
    <div data-live="stats"></div>
    <div class="chart-wrap"><canvas id="chart" aria-label="Water level over the last hour"></canvas></div>
    <div data-live="detail-actions"></div>
    <section class="section">
      <h2>Why this spot floods</h2>
      <div data-live="site-profile"></div>
    </section>
    <p class="fine">${s.is_simulated ? 'Simulated sensor used to demonstrate the network. ' : ''}Depth is measured from the road surface directly below the sensor. Roads are marked impassable at ${fmtIn(s.alert_depth_cm)}, the depth at which moving water can stall most cars.</p>
    ${footer()}`;
}

function reportView() {
  const options = Object.entries(REPORT_KINDS)
    .map(([value, label], i) => `<label class="radio"><input type="radio" name="kind" value="${value}" ${i === 0 ? 'checked' : ''}> ${label}</label>`)
    .join('');
  return `
    <button class="back" data-action="back">Cancel</button>
    <header class="detail-head">
      <h1>Report flooding</h1>
      <p class="muted">Drag the pin on the map to where you saw the problem. Reports stay on the map for four hours and are labeled as unverified.</p>
    </header>
    <form data-form="report" class="form">
      <fieldset>
        <legend>What did you see?</legend>
        ${options}
      </fieldset>
      <label>Details (optional)
        <textarea name="note" rows="3" maxlength="280" placeholder="Water covering both lanes at the bottom of the hill"></textarea>
      </label>
      <button type="submit" class="btn">Submit report</button>
    </form>
    <div data-live="message"></div>`;
}

function authView() {
  const signin = state.authMode === 'signin';
  return `
    <header class="detail-head">
      <h1>${signin ? 'Sign in' : 'Create an account'}</h1>
      <p class="muted">${signin
        ? 'Residents sign in to monitor sensors in their home. Municipal staff accounts can install street sensors once FloodMesh has verified them with the township.'
        : 'Anyone can create a resident account and connect a home sensor. Street sensor access requires a verified municipal account.'}</p>
    </header>
    <form data-form="auth" class="form">
      ${signin ? '' : '<label>Name<input name="name" required maxlength="60" autocomplete="name"></label>'}
      <label>Email<input type="email" name="email" required autocomplete="email"></label>
      <label>Password<input type="password" name="password" required minlength="6" autocomplete="${signin ? 'current-password' : 'new-password'}"></label>
      <button type="submit" class="btn">${signin ? 'Sign in' : 'Create account'}</button>
    </form>
    <div data-live="message"></div>
    <p class="switch">${signin ? 'New to FloodMesh?' : 'Already have an account?'}
      <button class="link-btn" data-action="auth-toggle">${signin ? 'Create an account' : 'Sign in instead'}</button></p>`;
}

function accountView() {
  if (!state.session) return authView();
  const alerts = browserAlertState();
  const alertLine = {
    granted: 'Browser notifications are on.',
    denied: 'Browser notifications are blocked in your browser settings.',
    default: '',
    unsupported: 'This browser does not support notifications.',
  }[alerts];
  return `
    <header class="detail-head">
      <h1>${escapeHtml(state.profile?.display_name || 'Your account')}</h1>
      <p class="muted">${escapeHtml(state.session.user.email)}</p>
    </header>
    <dl class="facts">
      <dt>Account type</dt>
      <dd>${isOfficial() ? 'Verified municipal account' : 'Resident account'}</dd>
    </dl>
    <section class="section">
      <h2>Alerts</h2>
      <p>Alerts appear inside FloodMesh while it is open. Background push notifications are planned for the mobile release.</p>
      ${alerts === 'default' ? '<button class="btn btn-secondary" data-action="alerts-enable">Also show browser notifications</button>' : `<p class="muted">${alertLine}</p>`}
    </section>
    <section class="section">
      <button class="btn btn-secondary" data-action="signout">Sign out</button>
    </section>
    ${footer()}`;
}

function homeView() {
  if (!state.session) {
    return `
      <header class="detail-head">
        <h1>Home sensors</h1>
        <p class="muted">A FloodMesh sensor placed in a basement or low room alerts your phone when standing water appears, so a burst pipe or seepage gets caught early. It runs on a rechargeable battery and keeps working through power outages.</p>
      </header>
      <button class="btn" data-action="goto" data-view="auth">Sign in</button>
      <p class="switch">No account yet? <button class="link-btn" data-action="auth-create">Create one</button></p>`;
  }
  const s = state.selectedId && sensorById(state.selectedId);
  if (s && s.mode === 'personal') return homeDetailView(s);
  return `
    <header class="detail-head">
      <h1>Home sensors</h1>
      <p class="muted">Only you can see these sensors. They never appear on the public map.</p>
    </header>
    <div class="sensor-list" data-live="home-list"></div>
    <section class="section">
      <h2>Add a sensor</h2>
      <form data-form="add-personal" class="form">
        <label>Name<input name="name" required maxlength="60" placeholder="Basement"></label>
        <label>Where is it installed?<input name="note" maxlength="120" placeholder="Next to the water heater"></label>
        <button type="submit" class="btn">Add sensor</button>
      </form>
      <div data-live="message"></div>
    </section>
    ${footer('home')}`;
}

function homeDetailView(s) {
  return `
    <button class="back" data-action="back">All home sensors</button>
    <header class="detail-head">
      <h1>${escapeHtml(s.name)}</h1>
      <p class="muted">${escapeHtml(s.location_note || '')}</p>
    </header>
    <div data-live="stats"></div>
    <div class="chart-wrap"><canvas id="chart" aria-label="Water on the floor over time"></canvas></div>
    ${sensorSettings(s, 'floor')}
    <p class="fine">${s.is_simulated ? 'Demo unit with simulated readings. ' : ''}The sensor recharges from any USB phone charger and keeps monitoring during a power outage.</p>
    ${footer('home')}`;
}

function sensorSettings(s, surface) {
  const surfaceWord = surface === 'floor' ? 'floor' : 'road surface';
  return `
    <section class="section">
      <h2>Calibration</h2>
      <p>Mount the sensor where it will stay, make sure the ${surfaceWord} below it is dry, then save the current reading as the dry level. Current dry level: ${fmtIn(s.mount_height_cm)} below the sensor.</p>
      <button class="btn btn-secondary" data-action="calibrate" data-id="${s.id}" ${s.is_simulated ? 'disabled' : ''}>Save current reading as dry ${surfaceWord}</button>
      <form data-form="alert-depth" data-id="${s.id}" class="form inline-form">
        <label>${surface === 'floor' ? 'Alert me when water reaches' : 'Mark road impassable at'}
          <span class="input-unit"><input name="depth" type="number" min="0.2" max="60" step="0.1" value="${cmToIn(s.alert_depth_cm).toFixed(1)}" required> in</span>
        </label>
        <button type="submit" class="btn btn-secondary">Save</button>
      </form>
      <div data-live="message"></div>
    </section>
    <section class="section">
      <h2>Device setup</h2>
      <p>Each sensor has a private key that lets it send readings to this account.</p>
      <button class="btn btn-secondary" data-action="show-key" data-id="${s.id}">Show device key</button>
      <div data-live="key"></div>
    </section>`;
}

function municipalView() {
  if (!isOfficial()) {
    return `
      <header class="detail-head">
        <h1>Municipal tools</h1>
        <p class="muted">Installing and managing street sensors requires a verified municipal account.</p>
      </header>`;
  }
  const s = state.selectedId && sensorById(state.selectedId);
  if (s && s.mode === 'street') {
    return `
      <button class="back" data-action="back">Sensor network</button>
      <header class="detail-head">
        <h1>${escapeHtml(s.name)}</h1>
        <p class="muted">${escapeHtml(s.location_note || '')}</p>
      </header>
      <div data-live="stats"></div>
      <div class="chart-wrap"><canvas id="chart" aria-label="Water level over the last hour"></canvas></div>
      <section class="section">
        <h2>Why this spot floods</h2>
        <div data-live="site-profile"></div>
      </section>
      ${s.owner_id === userId() ? sensorSettings(s, 'road') : '<p class="muted">This sensor is managed by another municipal account.</p>'}`;
  }
  return `
    <header class="detail-head">
      <h1>Street sensor network</h1>
      <p class="muted">${escapeHtml(AREA_NAME)}</p>
    </header>
    <div data-live="health"></div>
    <section class="section">
      <h2>Recommended sites</h2>
      <p class="muted small">Ranked from elevation, drainage, and road data. Each site is at least 850 ft from an existing sensor.</p>
      <div data-live="sites"></div>
    </section>
    <section class="section">
      <h2>Install a sensor somewhere else</h2>
      <p>Choose any location on the map, enter the mounting details, and the sensor gets a device key for its firmware.</p>
      <button class="btn btn-secondary" data-action="install-start">Place a new sensor</button>
    </section>`;
}

function installView() {
  return `
    <button class="back" data-action="back">Cancel</button>
    <header class="detail-head">
      <h1>Place a new sensor</h1>
      <p class="muted">Click the map where the sensor will be mounted. You can drag the pin to adjust it.</p>
    </header>
    <p class="install-point" data-live="install-point"></p>
    <form data-form="install" class="form">
      <label>Site name<input name="name" required maxlength="60" placeholder="Grove Ave underpass"></label>
      <label>Location details<input name="note" maxlength="120" placeholder="North side, on the retaining wall"></label>
      <label>Height of sensor above the road
        <span class="input-unit"><input name="mount" type="number" min="10" max="450" step="1" value="100" required> cm</span>
      </label>
      <label>Mark road impassable at
        <span class="input-unit"><input name="depth" type="number" min="0.5" max="60" step="0.5" value="6" required> in</span>
      </label>
      <button type="submit" class="btn">Create sensor</button>
    </form>
    <div data-live="message"></div>`;
}


// Risk, weather, points, and sites ------------------------------------------

function onRiskUpdate(kind) {
  if (kind === 'terrain' || kind === 'roads') updateSites();
  if (kind === 'terrain' && risk.terrainStatus === 'failed') map.setRiskStatus('Elevation data could not load. Showing sensors and reports only.');
  if (kind === 'terrain' && risk.ready) map.setRiskStatus('');
  refreshLive();
}

function updateSites() {
  state.sites = risk.sites(state.sensors.filter((s) => s.mode === 'street'));
  map.setSites(state.sites);
}

const OBS_STRENGTH = { flooding: 1, warning: 0.7, rising: 0.4 };

function observationPoints() {
  const points = [];
  for (const s of state.sensors) {
    if (s.mode !== 'street' || s.lat == null) continue;
    const ev = state.evals.get(s.id);
    const strength = ev && OBS_STRENGTH[ev.key];
    if (strength) points.push({ lat: s.lat, lng: s.lng, strength });
  }
  for (const r of activeReports()) points.push({ lat: r.lat, lng: r.lng, strength: 0.6 });
  return points;
}

function feet(n) {
  return `${Math.round(n).toLocaleString()} ft`;
}

function distanceFt(a, b) {
  const R = 20902231;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b[0] - a[0]);
  const dLng = toRad(b[1] - a[1]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a[0])) * Math.cos(toRad(b[0])) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function rainLine() {
  if (sim.running) return `Storm replay: ${sim.rainfall().toFixed(1)} in of rain per hour.`;
  const w = risk.weather;
  if (!w) return 'Loading the National Weather Service forecast...';
  if (w.error) return 'Weather forecast unavailable right now.';
  const parts = [];
  if (w.summary) parts.push(`${w.summary}${w.tempF != null ? `, ${w.tempF}°F` : ''}.`);
  if (w.rainChance != null) parts.push(`${w.rainChance}% chance of rain in the next 6 hours.`);
  if (w.rain24In != null) parts.push(`${w.rain24In < 0.05 ? 'Under 0.1' : w.rain24In.toFixed(1)} in expected over 24 hours.`);
  return parts.join(' ');
}

function sensorLevel() {
  const keys = state.sensors.filter((s) => s.mode === 'street').map((s) => state.evals.get(s.id)?.key);
  if (keys.includes('flooding')) return 'severe';
  if (keys.includes('warning')) return 'high';
  if (keys.includes('rising')) return 'moderate';
  return 'low';
}

function areaHtml() {
  const area = risk.areaLevel();
  const order = ['low', 'moderate', 'high', 'severe'];
  const fromSensors = sensorLevel();
  let level = area ? area.level : null;
  if (!level || order.indexOf(fromSensors) > order.indexOf(level.key)) {
    level = { low: { label: 'Low', color: '#2f7d4f' }, moderate: { label: 'Moderate', color: '#a87a00' }, high: { label: 'High', color: '#d0610b' }, severe: { label: 'Severe', color: '#c0392b' } }[fromSensors];
  }
  const flooding = state.sensors.filter((s) => s.mode === 'street' && state.evals.get(s.id)?.key === 'flooding').map((s) => s.name);
  const w = risk.weather;
  let reason;
  if (flooding.length) reason = `Sensors report water over the road at ${flooding.join(' and ')}.`;
  else if (sim.running) reason = 'Heavy rain in the replay. Low spots like the bottom of the Mt. Pleasant Ave hill fill first.';
  else if (w && !w.error && w.rain24In != null && w.rain24In >= 0.5) reason = 'Steady rain in the forecast. Low spots may start to collect water.';
  else if (w && !w.error && w.rain24In != null && w.rain24In >= 0.05) reason = 'Light rain in the forecast. Street flooding is unlikely.';
  else if (w && !w.error) reason = 'No meaningful rain in the forecast, and no sensor shows water on the road.';
  else reason = 'Based on sensor readings and terrain.';
  const alerts = w && !w.error && w.alerts.length
    ? `<div class="nws-alert">${icon('info')}<div><strong>${escapeHtml(w.alerts.map((a) => a.event).join(', '))}</strong><span>Issued by the National Weather Service for this area.</span></div></div>`
    : '';
  return `
    <section class="area-card" style="--c:${level.color}">
      <span class="area-label">Flood risk in this area right now</span>
      <span class="area-level">${level.label}</span>
      <p class="area-reason">${reason}</p>
      <p class="weather-line">${icon('rain')}<span>${escapeHtml(rainLine())}</span></p>
      ${alerts}
    </section>`;
}

function sparkline(sensor) {
  const list = state.readings.get(sensor.id) || [];
  const pts = list.slice(-60).map((r) => waterCm(sensor, r) ?? 0);
  if (pts.length < 2) return '<svg class="spark" viewBox="0 0 80 24" aria-hidden="true"></svg>';
  const max = Math.max(sensor.alert_depth_cm, ...pts) || 1;
  const step = 80 / (pts.length - 1);
  const line = pts.map((v, k) => `${(k * step).toFixed(1)},${(22 - (v / max) * 20).toFixed(1)}`).join(' ');
  const alertY = (22 - (sensor.alert_depth_cm / max) * 20).toFixed(1);
  return `<svg class="spark" viewBox="0 0 80 24" aria-hidden="true"><line x1="0" x2="80" y1="${alertY}" y2="${alertY}" class="spark-alert"/><polyline points="${line}" class="spark-line"/></svg>`;
}

function femaFor(lat, lng) {
  const key = `${lat.toFixed(5)},${lng.toFixed(5)}`;
  if (!state.femaCache.has(key)) {
    state.femaCache.set(key, { status: 'loading' });
    femaZoneAt(lat, lng)
      .then((zone) => state.femaCache.set(key, { status: 'ok', text: describeZone(zone) }))
      .catch(() => state.femaCache.set(key, { status: 'failed', text: 'FEMA flood map service did not respond' }))
      .finally(() => fillLive());
  }
  return state.femaCache.get(key);
}

function factorRows(lat, lng, info, { skipSensorId = null } = {}) {
  const rows = [];
  const add = (ic, title, text) => rows.push(`<li>${icon(ic)}<div><strong>${title}</strong><span>${text}</span></div></li>`);
  if (info && !info.outside) {
    const rel = (ft, radius) => (ft >= 1 ? `${Math.round(ft)} ft lower than` : ft <= -1 ? `${Math.round(-ft)} ft higher than` : 'about level with')
      + ` the ground within ${feet(Math.round(radius / 50) * 50)}`;
    add('mountain', `Elevation ${Math.round(info.elevFt)} ft`, `${rel(info.localFt, info.localRadiusFt)}, and ${rel(info.broadFt, info.broadRadiusFt)}.`);
    add('wave', 'Drainage', info.acres >= 0.5
      ? `Runoff from about ${info.acres >= 10 ? Math.round(info.acres) : info.acres.toFixed(1)} acres of surrounding land flows through this spot.`
      : 'Very little runoff flows here. Water tends to drain away from this spot.');
    add('drain', 'Ponding', info.pondFt >= 0.3
      ? `Sits in a dip that could hold about ${info.pondFt.toFixed(1)} ft of standing water if storm drains back up.`
      : 'Not in a closed dip, so water has a way to drain off.');
  }
  const fema = femaFor(lat, lng);
  add('shield', 'FEMA flood map', fema.status === 'loading' ? 'Checking the National Flood Hazard Layer...' : escapeHtml(fema.text));
  add('rain', 'Weather', escapeHtml(rainLine()));
  const street = state.sensors.filter((s) => s.mode === 'street' && s.lat != null && s.id !== skipSensorId);
  if (street.length) {
    const nearest = street
      .map((s) => ({ s, d: distanceFt([lat, lng], [s.lat, s.lng]) }))
      .sort((a, b) => a.d - b.d)[0];
    const ev = state.evals.get(nearest.s.id);
    add('sensor', 'Nearest other sensor', `${escapeHtml(nearest.s.name)}, ${feet(nearest.d)} away, ${ev ? STATUS[ev.key].label.toLowerCase() : 'no data'}${ev && ev.water != null && ev.key !== 'offline' ? ` at ${fmtIn(ev.water)}` : ''}.`);
  }
  const near = activeReports().filter((r) => distanceFt([lat, lng], [r.lat, r.lng]) <= 1000);
  add('pin', 'Community reports', near.length ? `${near.length} active report${near.length > 1 ? 's' : ''} within 1,000 ft.` : 'None within 1,000 ft.');
  return `<ul class="factors">${rows.join('')}</ul>`;
}

function openPoint(latlng) {
  state.view = 'point';
  state.selectedId = null;
  state.point = [latlng.lat, latlng.lng];
  state.pointTitle = null;
  map.setPin(latlng, false);
  renderAll();
}

function openSite(k) {
  const site = state.sites[k];
  if (!site) return;
  state.view = 'point';
  state.selectedId = null;
  state.point = [site.lat, site.lng];
  state.pointTitle = `Recommended site ${k + 1}${site.road ? `: ${site.road}` : ''}`;
  map.setPin(L.latLng(site.lat, site.lng), false);
  map.focus([site.lat, site.lng]);
  renderAll();
}

function pointView() {
  const [lat, lng] = state.point;
  return `
    <button class="back" data-action="point-back">Back to the map</button>
    <header class="detail-head">
      <h1>${escapeHtml(state.pointTitle || 'Flood risk at this spot')}</h1>
      <p class="muted mono">${lat.toFixed(5)}, ${lng.toFixed(5)}</p>
    </header>
    <div data-live="point"></div>
    <div class="point-actions">
      <button class="btn btn-secondary" data-action="report-here">Report flooding here</button>
      ${isOfficial() ? '<button class="btn" data-action="install-here">Install a sensor here</button>' : ''}
    </div>
    ${footer()}`;
}

function pointHtml() {
  const [lat, lng] = state.point;
  const info = risk.analyze(lat, lng);
  let head = '';
  if (!risk.ready) {
    head = `<p class="muted">${risk.terrainStatus === 'failed' ? 'Elevation data is unavailable, so only nearby readings are shown.' : 'Loading elevation data...'}</p>`;
  } else if (info.outside) {
    head = '<p class="muted">This spot is outside the area FloodMesh has analyzed. Terrain risk covers about a mile around the pilot sensors.</p>';
  } else {
    const rankText = rankSentence(info);
    head = `
      <div class="risk-pair">
        <div style="--c:${info.levelNow.color}"><span class="readout-label">Right now</span><span class="risk-word">${info.levelNow.label}</span></div>
        <div style="--c:${info.levelHeavy.color}"><span class="readout-label">During heavy rain</span><span class="risk-word">${info.levelHeavy.label}</span></div>
      </div>
      <p class="rank-line">${rankText}</p>`;
  }
  return `${head}<h2 class="factor-head">What goes into this</h2>${factorRows(lat, lng, info && !info.outside ? info : null)}
    <p class="fine">Terrain analysis uses USGS 3DEP elevation at about 50 ft resolution. It estimates where water collects; it is not an official flood determination.</p>`;
}

function topShare(rank) {
  const pct = Math.max(1, Math.ceil((1 - rank) * 100));
  return `Top ${pct}%`;
}

function rankSentence(info) {
  const where = info.rankAgainstRoads ? 'road spots' : 'spots';
  if (info.rank >= 0.99) return `One of the most flood-prone ${where} in the analyzed area (top 1%).`;
  if (info.rank >= 0.5) return `More flood-prone than ${Math.round(info.rank * 100)}% of ${where} in the analyzed area.`;
  return `Less flood-prone than ${Math.round((1 - info.rank) * 100)}% of ${where} in the analyzed area.`;
}

function siteProfileHtml(s) {
  if (s.lat == null) return '';
  const info = risk.analyze(s.lat, s.lng);
  const head = info && !info.outside
    ? `<p>Terrain flood risk here: <strong style="color:${info.levelHeavy.color}">${info.levelHeavy.label}</strong> during heavy rain. ${rankSentence(info)}</p>`
    : `<p class="muted">${risk.terrainStatus === 'failed' ? 'Elevation data unavailable.' : 'Loading elevation data...'}</p>`;
  return head + factorRows(s.lat, s.lng, info && !info.outside ? info : null, { skipSensorId: s.id });
}

function sitesHtml() {
  if (!risk.ready) return `<p class="muted">${risk.terrainStatus === 'failed' ? 'Site ranking needs elevation data, which could not load.' : 'Ranking locations from elevation data...'}</p>`;
  if (!state.sites.length) return '<p class="muted">Every low spot in the analyzed area is already within range of a sensor.</p>';
  return `<ol class="site-list">${state.sites.map((site, k) => `
    <li>
      <span class="site-marker small"><span>${k + 1}</span></span>
      <div class="site-text">
        <strong>${escapeHtml(site.road || 'Unnamed location')}</strong>
        <span>${topShare(site.rank)} of road spots for flood risk. Runoff from about ${site.acres >= 10 ? Math.round(site.acres) : site.acres.toFixed(1)} acres drains here.</span>
        <div class="site-actions">
          <button class="link-btn" data-action="site" data-k="${k}">View details</button>
          ${isOfficial() ? `<button class="link-btn" data-action="install-site" data-k="${k}">Install here</button>` : ''}
        </div>
      </div>
    </li>`).join('')}</ol>`;
}

// Welcome --------------------------------------------------------------------

function showWelcome(scrollToHow = false) {
  const el = document.getElementById('welcome');
  el.innerHTML = welcomeHtml();
  el.hidden = false;
  document.body.classList.add('welcome-open');
  el.scrollTop = 0;
  const how = el.querySelector('#how-it-works');
  if (scrollToHow && how && how.scrollIntoView) how.scrollIntoView();
}

function hideWelcome(go) {
  const el = document.getElementById('welcome');
  el.hidden = true;
  document.body.classList.remove('welcome-open');
  try {
    localStorage.setItem('floodmesh-welcomed', '1');
  } catch {
    /* ignore */
  }
  if (go === 'auth') {
    state.authMode = 'signin';
    goTo('auth');
  } else if (go === 'home') {
    goTo('home');
  } else {
    goTo('public');
  }
  map.resize();
}

// Live regions -----------------------------------------------------------

function refreshLive() {
  const now = Date.now();
  state.evals = new Map(state.sensors.map((s) => [s.id, evaluate(s, latestOf(s.id), now)]));
  map.setSensors(state.sensors.filter((s) => s.mode === 'street'), state.evals, state.selectedId);
  map.setReports(activeReports());
  risk.replayRain = sim.running ? sim.rainfall() : null;
  risk.setObservations(observationPoints());
  const image = risk.render();
  if (image) map.setRiskImage(image.url, image.bounds);
  fillLive();
  renderReplayStatus();
  checkAlerts();
}

function live(name) {
  return panel.querySelector(`[data-live="${name}"]`);
}

function fillLive() {
  const items = state.sensors.map((s) => ({ sensor: s, ev: state.evals.get(s.id) }));
  const street = items.filter((i) => i.sensor.mode === 'street');

  const summary = live('summary');
  if (summary) summary.textContent = state.ready ? summarize(items) : 'Loading sensors...';

  const area = live('area');
  if (area) area.innerHTML = areaHtml();

  const sites = live('sites');
  if (sites) sites.innerHTML = sitesHtml();

  const point = live('point');
  if (point && state.point) point.innerHTML = pointHtml();

  const list = live('street-list');
  if (list) list.innerHTML = street.map(sensorRow).join('') || '<p class="muted">No street sensors yet.</p>';

  const reports = live('report-list');
  if (reports) {
    const active = activeReports();
    reports.innerHTML = active.length
      ? active.map((r) => `
          <button class="report-row" data-action="focus-report" data-id="${r.id}">
            <span class="report-kind">${escapeHtml(REPORT_KINDS[r.kind] || 'Report')}</span>
            <span class="report-meta">${fmtAge((Date.now() - Date.parse(r.created_at)) / 1000)}${r.note ? `, "${escapeHtml(r.note)}"` : ''}</span>
          </button>`).join('')
      : '<p class="muted">No active reports. If you see water on a road, report it so drivers can avoid it.</p>';
  }

  const home = live('home-list');
  if (home) {
    const mine = items.filter((i) => i.sensor.mode === 'personal' && i.sensor.owner_id === userId());
    home.innerHTML = mine.map(sensorRow).join('') || '<p class="muted">No home sensors yet. Add one below.</p>';
  }

  const health = live('health');
  if (health) health.innerHTML = healthTable(street);

  const s = state.selectedId && sensorById(state.selectedId);
  const stats = live('stats');
  if (s && stats) stats.innerHTML = statsHtml(s, state.evals.get(s.id));

  const profile = live('site-profile');
  if (s && profile) profile.innerHTML = siteProfileHtml(s);

  const actions = live('detail-actions');
  if (s && actions) {
    const muted = state.muted.has(s.id);
    actions.innerHTML = `<button class="btn btn-secondary" data-action="mute" data-id="${s.id}">${muted ? 'Turn on alerts for this sensor' : 'Turn off alerts for this sensor'}</button>`;
  }

  if (s) updateChart(s);
}

function sensorRow({ sensor: s, ev }) {
  const color = STATUS[ev.key].color;
  const value = ev.key === 'offline' || ev.key === 'nodata' ? (ev.ageSec != null ? `Last seen ${fmtAge(ev.ageSec)}` : '') : fmtIn(ev.water);
  return `
    <button class="sensor-row" style="--c:${color}" data-action="select" data-id="${s.id}">
      <span class="sensor-name">${escapeHtml(s.name)}</span>
      <span class="sensor-value">${value}</span>
      <span class="sensor-note">${escapeHtml(s.location_note || '')}</span>
      <span class="sensor-status">${statusLabel(s, ev.key)}</span>
      <span class="sensor-spark">${sparkline(s)}</span>
    </button>`;
}

function healthTable(street) {
  if (!street.length) return '<p class="muted">No street sensors installed yet.</p>';
  const rows = street.map(({ sensor: s, ev }) => `
    <tr data-action="select" data-id="${s.id}">
      <td>${escapeHtml(s.name)}${s.is_simulated ? '<span class="sub">Simulated</span>' : ''}</td>
      <td><span class="dot" style="--c:${STATUS[ev.key].color}"></span>${STATUS[ev.key].label}</td>
      <td class="num">${ev.water == null ? '' : fmtIn(ev.water)}</td>
      <td class="num">${ev.ageSec == null ? 'Never' : fmtAge(ev.ageSec)}</td>
      <td class="num">${ev.battery == null ? '' : `${Math.round(ev.battery)}%`}</td>
    </tr>`).join('');
  return `
    <table class="health">
      <thead><tr><th>Sensor</th><th>Status</th><th>Water</th><th>Last reading</th><th>Battery</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

function readout(label, value, sub = '') {
  return `<div class="readout"><span class="readout-label">${label}</span><span class="readout-value">${value}</span>${sub ? `<span class="readout-sub">${sub}</span>` : ''}</div>`;
}

function statsHtml(s, ev) {
  const color = STATUS[ev.key].color;
  const personal = s.mode === 'personal';
  const rows = [
    readout(personal ? 'Water on floor' : 'Water above road', fmtIn(ev.water), fmtCm(ev.water)),
    readout('Trend', fmtRise(ev.rise)),
  ];
  if (ev.etaMin != null && ev.key !== 'offline') rows.push(readout(personal ? 'Reaches alert level in' : 'Impassable in', fmtEta(ev.etaMin)));
  if (ev.temp != null) rows.push(readout('Air temperature', fmtTempF(ev.temp)));
  if (ev.battery != null) rows.push(readout('Battery', `${Math.round(ev.battery)}%`, ev.battery < LOW_BATTERY_PCT ? 'Recharge soon' : 'USB rechargeable'));

  let updated = ev.ageSec == null ? 'Waiting for the first reading' : `Updated ${fmtAge(ev.ageSec)}`;
  if (sim.drives(s)) updated = `Storm replay, ${fmtClock(sim.clock().toISOString())}`;
  return `
    <div class="status-line" style="--c:${color}">
      <span class="status-word">${statusLabel(s, ev.key)}</span>
      <span class="status-time">${updated}</span>
    </div>
    <div class="readouts">${rows.join('')}</div>`;
}

function fillInstallPoint() {
  const el = live('install-point');
  if (!el) return;
  const p = state.installPoint;
  el.textContent = p ? `Location: ${p.lat.toFixed(6)}, ${p.lng.toFixed(6)}` : 'No location chosen yet.';
}

function setMessage(text, isError = false) {
  const els = panel.querySelectorAll('[data-live="message"]');
  els.forEach((el) => {
    el.className = `message${isError ? ' error' : ''}`;
    el.textContent = text;
  });
}

function renderReplayStatus() {
  const el = document.getElementById('replay-status');
  if (!sim.running) {
    el.hidden = true;
    return;
  }
  el.hidden = false;
  el.innerHTML = `<span class="pulse"></span>Storm replay ${fmtClock(sim.clock().toISOString())}, ${sim.rainfall().toFixed(1)} in/hr rain
    <button class="link-btn" data-action="replay-stop">Stop</button>`;
}

// Chart ------------------------------------------------------------------

function chartSeries(sensor) {
  const list = state.readings.get(sensor.id) || [];
  const cutoff = sensor.is_simulated || sim.drives(sensor) ? 0 : Date.now() - HISTORY_MINUTES * 60000;
  const points = list.filter((r) => Date.parse(r.created_at) >= cutoff);
  const step = Math.max(1, Math.ceil(points.length / 240));
  const sampled = points.filter((_, i) => i % step === 0 || i === points.length - 1);
  return {
    labels: sampled.map((r) => fmtClock(r.label_time || r.created_at)),
    water: sampled.map((r) => Number(cmToIn(waterCm(sensor, r) ?? 0).toFixed(2))),
    alert: Number(cmToIn(sensor.alert_depth_cm).toFixed(2)),
  };
}

function mountChart(sensor) {
  const canvas = panel.querySelector('#chart');
  if (!canvas || !window.Chart) return;
  const series = chartSeries(sensor);
  state.chart = new window.Chart(canvas, {
    type: 'line',
    data: {
      labels: series.labels,
      datasets: [
        {
          label: 'Water depth (in)',
          data: series.water,
          borderColor: '#1d6fa5',
          backgroundColor: 'rgba(29, 111, 165, 0.12)',
          fill: true,
          pointRadius: 0,
          borderWidth: 2,
          tension: 0.25,
        },
        {
          label: sensor.mode === 'personal' ? 'Alert level' : 'Impassable',
          data: series.labels.map(() => series.alert),
          borderColor: '#c0392b',
          borderDash: [6, 4],
          borderWidth: 1.5,
          pointRadius: 0,
          fill: false,
        },
      ],
    },
    options: {
      animation: false,
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: { legend: { display: false } },
      scales: {
        x: { ticks: { maxTicksLimit: 6, maxRotation: 0 }, grid: { display: false } },
        y: { beginAtZero: true, suggestedMax: series.alert * 1.3, title: { display: true, text: 'inches' } },
      },
    },
  });
  state.chartFor = sensor.id;
}

function updateChart(sensor) {
  if (!state.chart || state.chartFor !== sensor.id) return;
  const series = chartSeries(sensor);
  state.chart.data.labels = series.labels;
  state.chart.data.datasets[0].data = series.water;
  state.chart.data.datasets[1].data = series.labels.map(() => series.alert);
  state.chart.options.scales.y.suggestedMax = series.alert * 1.3;
  state.chart.update('none');
}

function destroyChart() {
  if (state.chart) state.chart.destroy();
  state.chart = null;
  state.chartFor = null;
}

// Demo controls ----------------------------------------------------------

function renderDemo() {
  const el = document.getElementById('demo');
  const home = state.sensors.find((s) => s.mode === 'personal' && s.is_simulated && s.owner_id === userId());
  el.innerHTML = `
    <div class="demo-head">
      <h2>Demo controls</h2>
      <button class="link-btn" data-demo="close">Close</button>
    </div>
    <p>Storm replay plays a three-hour storm at ${REPLAY.speed} times speed through the simulated street sensors.</p>
    <label class="check"><input type="checkbox" id="demo-include-real" ${sim.running ? 'disabled' : ''} ${sim.includeReal ? 'checked' : ''}> Also drive the Mt. Pleasant Ave sensor</label>
    <button class="btn" data-demo="${sim.running ? 'replay-stop' : 'replay-start'}">${sim.running ? 'Stop storm replay' : 'Start storm replay'}</button>
    <h3>Home sensor</h3>
    ${home
      ? `<div class="demo-row">
          <button class="btn btn-secondary" data-demo="basement">Basement water</button>
          <button class="btn btn-secondary" data-demo="battery">Low battery</button>
          <button class="btn btn-secondary" data-demo="reset">Reset</button>
        </div>`
      : '<p class="muted">Sign in with the homeowner demo account to use these.</p>'}`;
}

// Actions ----------------------------------------------------------------

function goTo(view, selectedId = null) {
  if ((state.view === 'report' || state.view === 'install' || state.view === 'point') && view !== state.view) {
    map.clearPin();
    state.installPoint = null;
  }
  if (view !== 'point') state.point = null;
  state.view = view;
  state.selectedId = selectedId;
  renderAll();
}

function selectSensor(id) {
  if (state.view === 'install' || state.view === 'report') return;
  const s = sensorById(id);
  if (!s) return;
  let view = 'public';
  if (s.mode === 'personal') view = 'home';
  else if (state.view === 'municipal' && isOfficial()) view = 'municipal';
  goTo(view, id);
  if (s.lat != null) map.focus([s.lat, s.lng]);
}

async function handleAction(action, el) {
  switch (action) {
    case 'select':
      selectSensor(el.dataset.id);
      break;
    case 'back':
      goTo(state.view === 'report' ? 'public' : state.view === 'install' ? 'municipal' : state.view);
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
    case 'focus-report':
      map.openReport(Number(el.dataset.id));
      break;
    case 'install-start':
      goTo('install');
      fillInstallPoint();
      break;
    case 'mute':
      if (state.muted.has(el.dataset.id)) state.muted.delete(el.dataset.id);
      else state.muted.add(el.dataset.id);
      saveMuted();
      fillLive();
      break;
    case 'calibrate':
      await calibrate(el.dataset.id);
      break;
    case 'show-key':
      await revealKey(el.dataset.id);
      break;
    case 'copy-key':
      try {
        await navigator.clipboard.writeText(el.dataset.key);
        el.textContent = 'Copied';
      } catch {
        el.textContent = 'Select and copy manually';
      }
      break;
    case 'signout':
      await db.auth.signOut();
      state.session = null;
      await onIdentityChange();
      goTo('public');
      break;
    case 'alerts-enable':
      await enableBrowserAlerts();
      renderPanel();
      break;
    case 'demo-toggle':
      toggleDemo();
      break;
    case 'replay-stop':
      sim.stop();
      break;
    case 'point-back':
      goTo('public');
      break;
    case 'site':
      openSite(Number(el.dataset.k));
      break;
    case 'install-site': {
      const site = state.sites[Number(el.dataset.k)];
      if (!site) break;
      goTo('install');
      setInstallPoint(L.latLng(site.lat, site.lng));
      const name = panel.querySelector('[name="name"]');
      if (name && site.road) name.value = `${site.road} low point`;
      break;
    }
    case 'install-here': {
      const [lat, lng] = state.point;
      goTo('install');
      setInstallPoint(L.latLng(lat, lng));
      break;
    }
    case 'report-here': {
      const [lat, lng] = state.point;
      goTo('report');
      map.setPin(L.latLng(lat, lng), true);
      break;
    }
    case 'how':
      showWelcome(true);
      break;
    default:
      break;
  }
}

async function handleForm(name, form) {
  switch (name) {
    case 'auth':
      return submitAuth(form);
    case 'report':
      return submitReport(form);
    case 'add-personal':
      return submitPersonal(form);
    case 'install':
      return submitInstall(form);
    case 'alert-depth':
      return submitAlertDepth(form);
    default:
      return undefined;
  }
}

async function submitAuth(form) {
  const email = field(form, 'email').trim();
  const password = field(form, 'password');
  setMessage('Working...');
  let result;
  if (state.authMode === 'signin') {
    result = await db.auth.signInWithPassword({ email, password });
  } else {
    result = await db.auth.signUp({ email, password, options: { data: { display_name: field(form, 'name').trim() } } });
  }
  if (result.error) {
    setMessage(result.error.message, true);
    return;
  }
  if (!result.data.session) {
    setMessage('Account created. Check your email to confirm it, then sign in.');
    return;
  }
  state.session = result.data.session;
  await onIdentityChange();
  goTo(isOfficial() ? 'municipal' : 'home');
}

async function submitReport(form) {
  const point = map.getPin();
  if (!point) {
    setMessage('Place the pin on the map first.', true);
    return;
  }
  const note = field(form, 'note').trim();
  const row = {
    lat: point.lat,
    lng: point.lng,
    kind: field(form, 'kind'),
    note: note ? note.slice(0, 280) : null,
    reporter_id: userId(),
  };
  setMessage('Sending...');
  state.reportPending = true;
  const { data, error } = await db.from('reports').insert(row).select().single();
  setTimeout(() => { state.reportPending = false; }, 3000);
  if (error) {
    setMessage(`Could not send the report: ${error.message}`, true);
    return;
  }
  state.myReports.add(data.id);
  addReport(data);
  map.clearPin();
  goTo('public');
  notify({ title: 'Report received', body: 'Thanks. Your report is on the map and will expire in four hours.', level: 'info' });
}

async function submitPersonal(form) {
  setMessage('Adding...');
  const { data, error } = await db
    .from('sensors')
    .insert({
      mode: 'personal',
      owner_id: userId(),
      name: field(form, 'name').trim(),
      location_note: field(form, 'note').trim() || null,
      mount_height_cm: 100,
      alert_depth_cm: 2,
    })
    .select()
    .single();
  if (error) {
    setMessage(`Could not add the sensor: ${error.message}`, true);
    return;
  }
  state.sensors.push(data);
  goTo('home', data.id);
  await revealKey(data.id);
}

async function submitInstall(form) {
  const point = state.installPoint;
  if (!point) {
    setMessage('Click the map to choose where the sensor goes.', true);
    return;
  }
  setMessage('Creating...');
  const { data, error } = await db
    .from('sensors')
    .insert({
      mode: 'street',
      owner_id: userId(),
      name: field(form, 'name').trim(),
      location_note: field(form, 'note').trim() || null,
      lat: point.lat,
      lng: point.lng,
      mount_height_cm: Number(field(form, 'mount')),
      alert_depth_cm: Number(field(form, 'depth')) * 2.54,
    })
    .select()
    .single();
  if (error) {
    setMessage(`Could not create the sensor: ${error.message}`, true);
    return;
  }
  state.sensors.push(data);
  map.clearPin();
  state.installPoint = null;
  updateSites();
  goTo('municipal', data.id);
  await revealKey(data.id);
}

async function submitAlertDepth(form) {
  const id = form.dataset.id;
  const cm = Number(field(form, 'depth')) * 2.54;
  const { error } = await db.from('sensors').update({ alert_depth_cm: cm }).eq('id', id);
  if (error) {
    setMessage(`Could not save: ${error.message}`, true);
    return;
  }
  const s = sensorById(id);
  if (s) s.alert_depth_cm = cm;
  setMessage(`Saved. Alerts now trigger at ${fmtIn(cm)}.`);
  refreshLive();
}

async function calibrate(id) {
  const s = sensorById(id);
  const r = latestRealOf(id);
  if (!s || !r || Date.now() - Date.parse(r.created_at) > 60000) {
    setMessage('Waiting for a fresh reading from the sensor. Make sure it is powered and online, then try again.', true);
    return;
  }
  const mount = Number((r.distance_mm / 10).toFixed(1));
  const { error } = await db.from('sensors').update({ mount_height_cm: mount }).eq('id', id);
  if (error) {
    setMessage(`Could not save: ${error.message}`, true);
    return;
  }
  s.mount_height_cm = mount;
  renderPanel();
  setMessage(`Saved. The dry level is ${fmtIn(mount)} below the sensor.`);
}

async function revealKey(id) {
  const el = live('key');
  if (!el) return;
  el.textContent = 'Loading...';
  let key = state.keys.get(id);
  if (!key) {
    const { data, error } = await db.from('sensor_keys').select('device_key').eq('sensor_id', id).maybeSingle();
    if (error || !data) {
      el.textContent = 'Could not load the device key.';
      return;
    }
    key = data.device_key;
    state.keys.set(id, key);
  }
  el.innerHTML = `
    <p>Paste this into <code>DEVICE_KEY</code> in the firmware and upload it to the sensor.</p>
    <div class="key-row">
      <code class="key">${escapeHtml(key)}</code>
      <button class="btn btn-secondary btn-small" data-action="copy-key" data-key="${escapeHtml(key)}">Copy</button>
    </div>`;
}

function toggleDemo(force) {
  const el = document.getElementById('demo');
  el.hidden = force === undefined ? !el.hidden : !force;
  if (!el.hidden) renderDemo();
}

function handleDemo(action) {
  switch (action) {
    case 'close':
      toggleDemo(false);
      break;
    case 'replay-start':
      sim.start(document.getElementById('demo-include-real')?.checked);
      break;
    case 'replay-stop':
      sim.stop();
      break;
    case 'basement':
      sim.basementWater();
      break;
    case 'battery':
      sim.lowBattery();
      break;
    case 'reset':
      sim.resetHome();
      break;
    default:
      break;
  }
}

// Events -----------------------------------------------------------------

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

document.getElementById('tabs').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-view]');
  if (btn) goTo(btn.dataset.view);
});

document.getElementById('account-btn').addEventListener('click', () => {
  state.authMode = 'signin';
  goTo(state.session ? 'account' : 'auth');
});

document.getElementById('replay-status').addEventListener('click', (e) => {
  if (e.target.closest('[data-action="replay-stop"]')) sim.stop();
});

document.getElementById('welcome').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-welcome]');
  if (!btn) return;
  if (btn.dataset.welcome === 'how') {
    const how = document.getElementById('how-it-works');
    if (how && how.scrollIntoView) how.scrollIntoView({ behavior: 'smooth' });
  } else {
    hideWelcome(btn.dataset.welcome);
  }
});

document.getElementById('how-btn').addEventListener('click', () => showWelcome(true));

document.getElementById('demo').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-demo]');
  if (btn) handleDemo(btn.dataset.demo);
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !document.getElementById('welcome').hidden) {
    hideWelcome('public');
    return;
  }
  if (e.target instanceof Element && e.target.closest('input, textarea, select')) return;
  if (e.shiftKey && e.key.toLowerCase() === 'd') toggleDemo();
});

// Start ------------------------------------------------------------------

async function start() {
  if (window.Chart) {
    window.Chart.defaults.font.family = "'Montserrat', system-ui, sans-serif";
    window.Chart.defaults.color = '#4b5966';
  }
  renderAll();
  const { data } = await db.auth.getSession();
  state.session = data.session;
  db.auth.onAuthStateChange((_event, session) => {
    state.session = session;
    // Supabase recommends deferring async work out of this callback.
    setTimeout(() => onIdentityChange(), 0);
  });
  let welcomed = false;
  try {
    welcomed = localStorage.getItem('floodmesh-welcomed') === '1';
  } catch {
    welcomed = false;
  }
  if (!welcomed) showWelcome();
  risk.init();
  await onIdentityChange(true);
  setInterval(refreshLive, 1000);
  setInterval(() => risk.refreshWeather(), 15 * 60000);
  setInterval(pollReadings, 15000);
  setInterval(() => loadReports(), 60000);
  window.addEventListener('resize', () => map.resize());
}

start();
