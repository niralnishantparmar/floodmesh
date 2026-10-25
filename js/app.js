import {
  SUPABASE_URL, SUPABASE_KEY, AREA_NAME, MAP_CENTER, MAP_ZOOM, HISTORY_MINUTES, LOW_BATTERY_PCT, REPLAY,
} from './config.js';
import {
  STATUS, REPORT_KINDS, statusLabel, waterCm, evaluate, summarize, cmToIn,
  fmtIn, fmtCm, fmtRise, fmtEta, fmtAge, fmtClock, fmtTempF, escapeHtml,
} from './logic.js';
import { Simulator } from './sim.js';
import { notify, browserAlertState, enableBrowserAlerts } from './notify.js';
import { MapView } from './mapview.js';

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
  onMapClick: (latlng) => {
    if (state.view !== 'install') return;
    state.installPoint = latlng;
    map.setPin(latlng, true).off('dragend').on('dragend', (e) => {
      state.installPoint = e.target.getLatLng();
      fillInstallPoint();
    });
    fillInstallPoint();
  },
});

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
  state.ready = true;
  renderAll();
}

function onReplayChange(kind) {
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
  if (view === 'report') return 'public';
  if (view === 'install') return 'municipal';
  return view;
}

function renderPanel() {
  destroyChart();
  const views = {
    public: () => (state.selectedId ? streetDetailView() : publicListView()),
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
    <p class="summary" data-live="summary"></p>
    <div class="sensor-list" data-live="street-list"></div>
    <section class="section">
      <div class="section-head">
        <h2>Community reports</h2>
        <button class="btn btn-secondary btn-small" data-action="report-start">Report flooding</button>
      </div>
      <div data-live="report-list"></div>
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
      ${s.owner_id === userId() ? sensorSettings(s, 'road') : '<p class="muted">This sensor is managed by another municipal account.</p>'}`;
  }
  return `
    <header class="detail-head">
      <h1>Street sensor network</h1>
      <p class="muted">${escapeHtml(AREA_NAME)}</p>
    </header>
    <div data-live="health"></div>
    <section class="section">
      <h2>Install a sensor</h2>
      <p>Choose a location on the map, enter the mounting details, and the sensor gets a device key for its firmware.</p>
      <button class="btn" data-action="install-start">Place a new sensor</button>
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

// Live regions -----------------------------------------------------------

function refreshLive() {
  const now = Date.now();
  state.evals = new Map(state.sensors.map((s) => [s.id, evaluate(s, latestOf(s.id), now)]));
  map.setSensors(state.sensors.filter((s) => s.mode === 'street'), state.evals, state.selectedId);
  map.setReports(activeReports());
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
  if ((state.view === 'report' || state.view === 'install') && view !== state.view) {
    map.clearPin();
    state.installPoint = null;
  }
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

document.getElementById('demo').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-demo]');
  if (btn) handleDemo(btn.dataset.demo);
});

document.addEventListener('keydown', (e) => {
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
  await onIdentityChange(true);
  setInterval(refreshLive, 1000);
  setInterval(pollReadings, 15000);
  setInterval(() => loadReports(), 60000);
  window.addEventListener('resize', () => map.resize());
}

start();
