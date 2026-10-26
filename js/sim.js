import { REPLAY } from './config.js';
import { replayLevel, replayRate, replayRainfall } from './logic.js';

let counter = 0;

export class Simulator {
  constructor({ getSensors, getProfile, emit, onChange }) {
    this.getSensors = getSensors;
    this.getProfile = getProfile;
    this.emit = emit;
    this.onChange = onChange;
    this.replay = null;
    this.home = { water: 0, target: 0, battery: 78 };
    this.ticks = 0;
    this.timer = setInterval(() => this.tick(), 1000);
  }

  get running() {
    return this.replay !== null;
  }

  start() {
    const start = new Date();
    start.setHours(REPLAY.stormStartHour, 0, 0, 0);
    this.replay = { startedAt: Date.now(), stormStart: start.getTime(), profiles: new Map() };
    this.onChange('start');
    this.tick();
  }

  stop() {
    if (!this.replay) return;
    this.replay = null;
    this.onChange('stop');
  }

  minute(now = Date.now()) {
    if (!this.replay) return 0;
    return ((now - this.replay.startedAt) / 1000) * (REPLAY.speed / 60);
  }

  clock(now = Date.now()) {
    return this.replay ? new Date(this.replay.stormStart + this.minute(now) * 60000) : null;
  }

  rainfall(now = Date.now()) {
    return this.replay ? replayRainfall(this.minute(now)) : 0;
  }

  drives(sensor) {
    return this.replay !== null && sensor.mode === 'street';
  }

  profileFor(sensor) {
    let p = this.replay.profiles.get(sensor.id);
    if (!p) {
      p = this.getProfile(sensor);
      this.replay.profiles.set(sensor.id, p);
    }
    return p;
  }

  basementWater() {
    this.home.target = 3.2;
  }

  lowBattery() {
    this.home.battery = 14;
  }

  resetHome() {
    this.home = { water: 0, target: 0, battery: 78 };
    this.primeIdle();
  }

  primeIdle() {
    const now = Date.now();
    for (const s of this.getSensors()) {
      if (s.is_simulated && s.mode === 'personal') this.emitHome(s, now, 0);
    }
  }

  tick() {
    const now = Date.now();
    this.ticks += 1;
    if (this.replay && this.minute(now) >= REPLAY.durationMin) this.stop();
    const h = this.home;
    let homeRate = 0;
    if (h.water < h.target) {
      h.water = Math.min(h.target, h.water + 0.16);
      homeRate = 0.16 * 60;
    } else if (h.water > h.target) {
      h.water = Math.max(h.target, h.water - 0.5);
      homeRate = -30;
    }
    for (const s of this.getSensors()) {
      if (this.drives(s)) {
        const minute = this.minute(now);
        const profile = this.profileFor(s);
        const noise = (Math.random() - 0.5) * 0.3;
        this.emit(this.reading(s, now, Math.max(0, replayLevel(profile, minute) + noise), replayRate(profile, minute), {
          label_time: this.clock(now).toISOString(),
          temp_c: 14.5,
        }));
      } else if (s.is_simulated && s.mode === 'personal' && (homeRate !== 0 || this.ticks % 5 === 0)) {
        this.emitHome(s, now, homeRate);
      }
    }
  }

  emitHome(sensor, now, rate) {
    this.emit(this.reading(sensor, now, this.home.water, rate, { temp_c: 18.5, battery_pct: this.home.battery }));
  }

  reading(sensor, now, water, rise, extra = {}) {
    counter += 1;
    const iso = new Date(now).toISOString();
    return {
      id: `sim-${counter}`,
      sensor_id: sensor.id,
      created_at: iso,
      label_time: iso,
      water_cm: water,
      distance_mm: null,
      rise_cm_per_min: rise,
      temp_c: null,
      battery_pct: null,
      battery_v: null,
      simulated: true,
      ...extra,
    };
  }
}
