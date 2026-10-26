import { SUPABASE_URL, SUPABASE_KEY, HISTORY_MINUTES } from './config.js';

export const db = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

function unwrap({ data, error }, fallback = null) {
  if (error) throw new Error(error.message || 'Request failed');
  return data ?? fallback;
}

export async function fetchProfile(uid) {
  return unwrap(await db.from('profiles').select('*').eq('id', uid).maybeSingle());
}

export async function fetchSensors() {
  return unwrap(await db.from('sensors').select('*').order('created_at', { ascending: true }), []);
}

export async function fetchRecentReadings(ids) {
  if (!ids.length) return [];
  const since = new Date(Date.now() - HISTORY_MINUTES * 60000).toISOString();
  const rows = unwrap(await db
    .from('readings')
    .select('*')
    .in('sensor_id', ids)
    .gte('created_at', since)
    .order('created_at', { ascending: true })
    .limit(1000), []);
  const seen = new Set(rows.map((r) => r.sensor_id));
  for (const id of ids.filter((x) => !seen.has(x))) {
    const last = unwrap(await db.from('readings').select('*').eq('sensor_id', id).order('created_at', { ascending: false }).limit(1), []);
    rows.push(...last);
  }
  return rows;
}

export async function fetchNewReadings(ids, afterIso) {
  if (!ids.length) return [];
  let query = db.from('readings').select('*').in('sensor_id', ids).order('created_at', { ascending: true }).limit(500);
  query = afterIso ? query.gt('created_at', afterIso) : query.gte('created_at', new Date(Date.now() - HISTORY_MINUTES * 60000).toISOString());
  return unwrap(await query, []);
}

export async function fetchReports() {
  return unwrap(await db.from('reports').select('*').order('created_at', { ascending: false }).limit(300), []);
}

export async function fileReport({ lat, lng, kind, note, token }) {
  return unwrap(await db.rpc('file_report', { p_lat: lat, p_lng: lng, p_kind: kind, p_note: note || null, p_token: token }));
}

export async function deleteReport(id, token) {
  return unwrap(await db.rpc('delete_report', { p_id: id, p_token: token || null }), false);
}

export async function clearReport(id, voter) {
  return unwrap(await db.rpc('clear_report', { p_id: id, p_voter: voter }), 0);
}

export async function checkPairingCode(code) {
  return unwrap(await db.rpc('check_pairing_code', { p_pairing_code: code }), false);
}

export async function claimDevice({ code, mode, name, note, lat, lng, alertCm }) {
  return unwrap(await db.rpc('claim_device', {
    p_pairing_code: code,
    p_mode: mode,
    p_name: name,
    p_location_note: note || null,
    p_lat: lat ?? null,
    p_lng: lng ?? null,
    p_alert_depth_cm: alertCm ?? null,
  }));
}

export async function fetchSensor(id) {
  return unwrap(await db.from('sensors').select('*').eq('id', id).maybeSingle());
}

export async function updateSensor(id, fields) {
  return unwrap(await db.from('sensors').update(fields).eq('id', id).select().maybeSingle());
}

export async function removeSensor(id) {
  unwrap(await db.from('sensors').delete().eq('id', id));
}

export function subscribe({ onReading, onReport, onReportChange, onReportGone }) {
  return db
    .channel('floodmesh-live')
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'readings' }, (p) => onReading(p.new))
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'reports' }, (p) => onReport(p.new))
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'reports' }, (p) => onReportChange(p.new))
    .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'reports' }, (p) => onReportGone(p.old))
    .subscribe();
}

export function unsubscribe(channel) {
  if (channel) db.removeChannel(channel);
}

export const auth = {
  session: async () => (await db.auth.getSession()).data.session,
  onChange: (fn) => db.auth.onAuthStateChange((_event, session) => fn(session)),
  signIn: (email, password) => db.auth.signInWithPassword({ email, password }),
  signUp: (email, password, name) => db.auth.signUp({ email, password, options: { data: { display_name: name } } }),
  signOut: () => db.auth.signOut(),
};
