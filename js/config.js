// Supabase project. The publishable key is meant to be public; access is
// controlled by the row level security rules in supabase/schema.sql.
export const SUPABASE_URL = 'https://nqwgfnpksaqsvyzitwax.supabase.co';
export const SUPABASE_KEY = 'sb_publishable_eI3c2zcEgRGGSH2K75bmZw_GYwGLi2l';

// Optional. CARTO's light basemap needs a free key (carto.com/basemaps/apikey).
// Leave blank to use OpenStreetMap's standard tiles, which need no key.
export const CARTO_KEY = '';

export const AREA_NAME = 'Mt. Pleasant Ave area, Edison, NJ';
export const MAP_CENTER = [40.5784, -74.3657];
export const MAP_ZOOM = 16;

// Area analyzed for terrain flood risk: roughly 3 km square around the pilot sensors.
export const RISK_BOUNDS = [[40.5649, -74.3832], [40.5919, -74.3482]];

// Devices post every 10 seconds, so two minutes of silence means trouble.
export const OFFLINE_AFTER_SEC = 120;
export const HISTORY_MINUTES = 60;

// Status thresholds
export const RISING_CM_PER_MIN = 0.2;
export const WARNING_ETA_MIN = 30;
export const LOW_BATTERY_PCT = 20;

// Storm replay: one real second equals one storm minute.
export const REPLAY = {
  speed: 60,
  durationMin: 180,
  stormStartHour: 13,
  rainPeakMin: 70,
  rainPeakInPerHr: 1.8,
  realSensorProfile: { peak: 30, center: 85, sd: 22 },
};

// How each simulated street sensor responds during the replay (water depth in cm).
export const SIM_PROFILES = [
  { match: 'Stevens', peak: 24, center: 95, sd: 28 },
  { match: 'Adams', peak: 12, center: 110, sd: 30 },
];
export const SIM_DEFAULT_PROFILE = { peak: 6, center: 100, sd: 30 };
