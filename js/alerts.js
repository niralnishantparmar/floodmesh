import { LOW_BATTERY_PCT } from './config.js';
import { STATUS, fmtIn, fmtEta, fmtAge, fmtTempF } from './logic.js';

export function createAlertTracker() {
  return {
    prev: new Map(),
    lowBattery: new Set(),
    forecastWarned: new Set(),
    iceWarned: new Set(),
    reset() {
      this.prev.clear();
      this.lowBattery.clear();
      this.forecastWarned.clear();
      this.iceWarned.clear();
    },
    forget(id) {
      this.prev.delete(id);
      this.forecastWarned.delete(id);
      this.iceWarned.delete(id);
    },
  };
}

export function checkAlerts({ sensors, evals, forecasts, muted, uid, official, tracker, notify }) {
  for (const s of sensors) {
    const ev = evals.get(s.id);
    if (!ev) continue;
    const prev = tracker.prev.get(s.id);
    tracker.prev.set(s.id, ev.key);
    const owned = uid != null && s.owner_id === uid;
    const watching = s.mode === 'street' && !muted.has(s.id);

    if (s.mode === 'personal' && owned && ev.battery != null) {
      if (ev.battery < LOW_BATTERY_PCT && !tracker.lowBattery.has(s.id)) {
        tracker.lowBattery.add(s.id);
        if (prev !== undefined) {
          notify({
            title: `${s.name}: battery low`,
            body: `The battery is down to ${Math.round(ev.battery)}%, so plug the sensor into any USB phone charger to keep it monitoring.`,
            level: 'warning',
          });
        }
      } else if (ev.battery >= LOW_BATTERY_PCT + 5) {
        tracker.lowBattery.delete(s.id);
      }
    }

    if (watching && prev !== undefined) {
      const fc = forecasts.get(s.id);
      if (fc && fc.crossMin != null && fc.crossMin <= 45 && ev.key !== 'flooding' && !tracker.forecastWarned.has(s.id)) {
        tracker.forecastWarned.add(s.id);
        notify({
          title: `Flooding expected at ${s.name}`,
          body: `The forecast model expects the water to reach ${fmtIn(s.alert_depth_cm)} in about ${Math.max(1, Math.round(fc.crossMin))} minutes, so plan another route if you can.`,
          level: 'warning',
        });
      } else if (tracker.forecastWarned.has(s.id) && ev.water != null && ev.water < s.alert_depth_cm * 0.3 && (!fc || fc.crossMin == null)) {
        tracker.forecastWarned.delete(s.id);
      }
      if (ev.ice && !tracker.iceWarned.has(s.id)) {
        tracker.iceWarned.add(s.id);
        notify({
          title: `Ice possible at ${s.name}`,
          body: `The air there is ${fmtTempF(ev.temp)} and there is still water on the road, so the surface could freeze.`,
          level: 'warning',
        });
      } else if (!ev.ice) {
        tracker.iceWarned.delete(s.id);
      }
    }

    if (prev === undefined || prev === 'nodata' || prev === ev.key) continue;
    const rank = STATUS[ev.key].rank;
    const prevRank = STATUS[prev].rank;

    if (s.mode === 'street') {
      if (watching) {
        if (ev.key === 'warning' && prevRank < 2) {
          notify({
            title: `Water rising at ${s.name}`,
            body: `There is ${fmtIn(ev.water)} of water on the road now, and at this rate it could become impassable in ${fmtEta(ev.etaMin) || 'the next half hour'}.`,
            level: 'warning',
          });
        } else if (ev.key === 'flooding') {
          notify({
            title: `Flooding at ${s.name}`,
            body: `The sensor reads ${fmtIn(ev.water)} of water above the road surface, so it's best to take another route for now.`,
            level: 'danger',
          });
        } else if (prev === 'flooding' && rank >= 0) {
          notify({
            title: `Water dropping at ${s.name}`,
            body: `The water has dropped back below ${fmtIn(s.alert_depth_cm)}, though there may still be debris on the road.`,
            level: 'info',
          });
        }
      }
      if ((owned || official) && ev.key === 'offline') {
        notify({
          title: `${s.name} stopped reporting`,
          body: `It hasn't sent a reading in ${fmtAge(ev.ageSec).replace(' ago', '')}, so it's worth checking the power and Wi-Fi at the site.`,
          level: 'warning',
        });
      }
    } else if (owned) {
      if (ev.key === 'flooding') {
        notify({
          title: `Water detected: ${s.name}`,
          body: `The sensor is picking up ${fmtIn(ev.water)} of standing water, which could mean a leak or a burst pipe nearby.`,
          level: 'danger',
        });
      } else if (ev.key === 'offline') {
        notify({
          title: `${s.name} is offline`,
          body: 'It hasn\'t checked in recently, so make sure it has power and is within range of your Wi-Fi.',
          level: 'warning',
        });
      } else if (prev === 'flooding') {
        notify({ title: `${s.name} is dry again`, body: 'The sensor no longer detects standing water.', level: 'info' });
      }
    }
  }
}
