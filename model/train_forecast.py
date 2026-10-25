import argparse
import datetime as dt
import json
import math
import sys
import time
import urllib.parse
import urllib.request

import numpy as np
from sklearn.neural_network import MLPRegressor
from sklearn.preprocessing import StandardScaler

CANDIDATES = [
    ("01403358", "Bound Brook at Clinton Avenue near New Market, NJ"),
    ("01404050", "Ambrose Brook near Middlesex, NJ"),
    ("01403390", "Bound Brook upstream of Green Brook at Middlesex, NJ"),
    ("01403060", "Raritan River below Calco Dam at Bound Brook, NJ"),
]
FEATURES = ["d15", "d30", "d60", "d120", "above_min", "rain_1h", "rain_3h", "rain_6h", "rain_next_1h"]
TARGETS = ["f30", "f60"]
STEP = 900
MIN_YEARS_OF_DATA = 3


def get_json(url, tries=3):
    last = None
    for attempt in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "FloodMesh student project (Congressional App Challenge)"})
            with urllib.request.urlopen(req, timeout=120) as res:
                return json.loads(res.read().decode("utf-8"))
        except Exception as err:
            last = err
            time.sleep(3 * (attempt + 1))
    raise RuntimeError("Request failed after {} tries: {}\n{}".format(tries, url, last))


def parse_time(text):
    text = text.replace("Z", "+00:00")
    if "." in text[19:]:
        head, rest = text[:19], text[19:]
        offset = rest[rest.find("+"):] if "+" in rest else rest[rest.rfind("-"):]
        text = head + offset
    return dt.datetime.fromisoformat(text).timestamp()


def usgs_year(site, year):
    query = urllib.parse.urlencode({
        "format": "json",
        "sites": site,
        "parameterCd": "00065",
        "startDT": "{}-01-01".format(year),
        "endDT": "{}-12-31".format(year),
        "siteStatus": "all",
    })
    data = get_json("https://waterservices.usgs.gov/nwis/iv/?" + query)
    series = data.get("value", {}).get("timeSeries", [])
    if not series:
        return [], None
    ts = series[0]
    no_data = float(ts["variable"].get("noDataValue", -999999))
    blocks = sorted(ts["values"], key=lambda b: len(b.get("value", [])), reverse=True)
    points = []
    for v in blocks[0].get("value", []):
        try:
            value = float(v["value"])
        except (TypeError, ValueError):
            continue
        if value == no_data or value < -100:
            continue
        points.append((parse_time(v["dateTime"]), value))
    geo = ts["sourceInfo"]["geoLocation"]["geogLocation"]
    return points, (float(geo["latitude"]), float(geo["longitude"]))


def download_gauge(site, name, first_year, last_year):
    print("Checking {} ({})".format(name, site))
    points, location = [], None
    for year in range(first_year, last_year + 1):
        year_points, loc = usgs_year(site, year)
        print("  {}: {} readings".format(year, len(year_points)))
        points.extend(year_points)
        location = location or loc
    return points, location


def open_meteo_rain(lat, lng, first_year, last_year):
    query = urllib.parse.urlencode({
        "latitude": "{:.4f}".format(lat),
        "longitude": "{:.4f}".format(lng),
        "start_date": "{}-01-01".format(first_year),
        "end_date": "{}-12-31".format(last_year),
        "hourly": "precipitation",
        "timezone": "GMT",
    })
    data = get_json("https://archive-api.open-meteo.com/v1/archive?" + query)
    hours = {}
    for t, mm in zip(data["hourly"]["time"], data["hourly"]["precipitation"]):
        stamp = dt.datetime.strptime(t, "%Y-%m-%dT%H:%M").replace(tzinfo=dt.timezone.utc).timestamp()
        hours[int(stamp)] = float(mm) if mm is not None else 0.0
    return hours


def synthetic_data(first_year, last_year, seed=11):
    rng = np.random.default_rng(seed)
    start = dt.datetime(first_year, 1, 1, tzinfo=dt.timezone.utc).timestamp()
    end = dt.datetime(last_year, 12, 31, 23, tzinfo=dt.timezone.utc).timestamp()
    hours = {}
    t = start
    storm = 0
    while t <= end:
        if storm <= 0 and rng.random() < 0.012:
            storm = int(rng.integers(3, 14))
            intensity = rng.gamma(2.0, 2.5)
        if storm > 0:
            hours[int(t)] = max(0.0, intensity * rng.uniform(0.3, 1.4))
            storm -= 1
        else:
            hours[int(t)] = 0.0
        t += 3600
    points = []
    level, store = 2.0, 0.0
    t = start
    while t <= end:
        rain = hours.get(int(t // 3600 * 3600), 0.0) / 4.0
        store += rain
        outflow = 0.06 * store
        store -= outflow
        level += 0.004 * outflow * 10 - 0.02 * (level - 2.0)
        points.append((t, level + rng.normal(0, 0.003)))
        t += STEP
    return points, (40.5700, -74.4100), hours


def build_series(points):
    points.sort()
    t0 = int(points[0][0] // STEP * STEP)
    t1 = int(points[-1][0] // STEP * STEP)
    n = (t1 - t0) // STEP + 1
    level = np.full(n, np.nan)
    for t, v in points:
        k = int(round((t - t0) / STEP))
        if 0 <= k < n:
            level[k] = v
    good = ~np.isnan(level)
    idx = np.arange(n)
    gaps = np.where(good)[0]
    for a, b in zip(gaps[:-1], gaps[1:]):
        if 1 < b - a <= 4:
            level[a + 1:b] = np.interp(idx[a + 1:b], [a, b], [level[a], level[b]])
    return t0, level


def rolling_min(values, window):
    out = np.full(len(values), np.nan)
    for k in range(window, len(values)):
        chunk = values[k - window:k + 1]
        if not np.isnan(chunk).any():
            out[k] = chunk.min()
    return out


def rain_features(t0, n, hours):
    r1 = np.zeros(n)
    r3 = np.zeros(n)
    r6 = np.zeros(n)
    nxt = np.zeros(n)
    for k in range(n):
        t = t0 + k * STEP
        h = int(t // 3600 * 3600)
        past = [hours.get(h - 3600 * j, 0.0) for j in range(6)]
        r1[k] = past[0]
        r3[k] = sum(past[:3])
        r6[k] = sum(past)
        nxt[k] = hours.get(h + 3600, 0.0)
    return r1, r3, r6, nxt


def make_dataset(t0, level, hours, rng):
    n = len(level)
    mins = rolling_min(level, 96)
    above = level - mins
    valid_above = above[~np.isnan(above)]
    scale = max(0.05, float(np.percentile(valid_above, 95)))
    u = level / scale
    r1, r3, r6, nxt = rain_features(t0, n, hours)
    rows, targets, years, active = [], [], [], []
    for k in range(96, n - 4):
        window = [u[k], u[k - 1], u[k - 2], u[k - 4], u[k - 8], u[k + 2], u[k + 4]]
        if any(math.isnan(x) for x in window) or math.isnan(above[k]):
            continue
        d15, d30, d60, d120 = u[k] - u[k - 1], u[k] - u[k - 2], u[k] - u[k - 4], u[k] - u[k - 8]
        f30, f60 = u[k + 2] - u[k], u[k + 4] - u[k]
        busy = r6[k] >= 1.0 or abs(d60) >= 0.02 or abs(f60) >= 0.02
        if not busy and rng.random() > 0.1:
            continue
        rows.append([d15, d30, d60, d120, above[k] / scale, r1[k], r3[k], r6[k], nxt[k]])
        targets.append([f30, f60])
        years.append(dt.datetime.fromtimestamp(t0 + k * STEP, dt.timezone.utc).year)
        active.append(busy)
    return np.array(rows), np.array(targets), np.array(years), np.array(active), scale


def mae(a, b):
    return float(np.mean(np.abs(a - b)))


def main():
    parser = argparse.ArgumentParser(description="Train the FloodMesh water level forecast model.")
    parser.add_argument("--first-year", type=int, default=2019)
    parser.add_argument("--last-year", type=int, default=2025)
    parser.add_argument("--site", help="Use this USGS site number instead of trying the default list")
    parser.add_argument("--out", default="forecast.json")
    parser.add_argument("--synthetic", action="store_true", help="Pipeline test with made-up data. The app will not load this model.")
    args = parser.parse_args()
    rng = np.random.default_rng(7)

    if args.synthetic:
        points, location, hours = synthetic_data(args.first_year, args.last_year)
        site, name = "synthetic", "Synthetic test stream"
    else:
        options = [(args.site, "USGS site " + args.site)] if args.site else CANDIDATES
        chosen = None
        for site, name in options:
            try:
                points, location = download_gauge(site, name, args.first_year, args.last_year)
            except RuntimeError as err:
                print("  Could not download: {}".format(err))
                continue
            years_covered = len({dt.datetime.fromtimestamp(t, dt.timezone.utc).year for t, _ in points})
            if location and len(points) > 35000 * MIN_YEARS_OF_DATA / 1.0 and years_covered >= MIN_YEARS_OF_DATA:
                chosen = (site, name)
                break
            print("  Not enough 15-minute data here, trying the next gauge.")
        if not chosen:
            sys.exit("None of the gauges had enough data. Try a different --site or a shorter year range.")
        site, name = chosen
        print("Using {} ({}) with {} readings".format(name, site, len(points)))
        print("Downloading hourly rainfall from Open-Meteo for {:.4f}, {:.4f}".format(*location))
        hours = open_meteo_rain(location[0], location[1], args.first_year, args.last_year)

    t0, level = build_series(points)
    X, Y, years, active, scale = make_dataset(t0, level, hours, rng)
    print("Built {} training examples. Storm scale for this gauge: {:.2f} ft".format(len(X), scale))

    test_year = args.last_year
    test = years == test_year
    if test.sum() < 500:
        cut = int(len(X) * 0.85)
        test = np.zeros(len(X), dtype=bool)
        test[cut:] = True
        test_label = "the most recent 15% of the record"
    else:
        test_label = str(test_year)
    train = ~test

    xs = StandardScaler().fit(X[train])
    ys = StandardScaler().fit(Y[train])
    model = MLPRegressor(
        hidden_layer_sizes=(32, 16),
        activation="relu",
        alpha=1e-3,
        batch_size=256,
        learning_rate_init=1e-3,
        max_iter=300,
        early_stopping=True,
        validation_fraction=0.1,
        n_iter_no_change=15,
        random_state=7,
    )
    print("Training the neural network...")
    model.fit(xs.transform(X[train]), ys.transform(Y[train]))

    eval_mask = test & active
    pred = ys.inverse_transform(model.predict(xs.transform(X[eval_mask])))
    truth = Y[eval_mask]
    trend = np.stack([X[eval_mask][:, 1], X[eval_mask][:, 2]], axis=1)
    still = np.zeros_like(truth)
    rising = truth[:, 1] > 0.1
    metrics = {
        "test_period": test_label,
        "test_examples": int(eval_mask.sum()),
        "mae_ft": {
            "model_30": mae(pred[:, 0], truth[:, 0]) * scale,
            "trend_30": mae(trend[:, 0], truth[:, 0]) * scale,
            "still_30": mae(still[:, 0], truth[:, 0]) * scale,
            "model_60": mae(pred[:, 1], truth[:, 1]) * scale,
            "trend_60": mae(trend[:, 1], truth[:, 1]) * scale,
            "still_60": mae(still[:, 1], truth[:, 1]) * scale,
        },
        "rising_examples": int(rising.sum()),
        "rising_mae_ft": {
            "model_60": mae(pred[rising, 1], truth[rising, 1]) * scale if rising.any() else None,
            "trend_60": mae(trend[rising, 1], truth[rising, 1]) * scale if rising.any() else None,
        },
    }
    m = metrics["mae_ft"]
    metrics["improvement_vs_trend_30"] = 1 - m["model_30"] / m["trend_30"] if m["trend_30"] else None
    metrics["improvement_vs_trend_60"] = 1 - m["model_60"] / m["trend_60"] if m["trend_60"] else None

    out = {
        "version": 1,
        "synthetic": bool(args.synthetic),
        "trained_at": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%d"),
        "site": {"id": site, "name": name, "lat": location[0], "lng": location[1]},
        "years": [args.first_year, args.last_year],
        "scale_ft": scale,
        "features": FEATURES,
        "targets": TARGETS,
        "x_mean": xs.mean_.round(6).tolist(),
        "x_std": xs.scale_.round(6).tolist(),
        "y_mean": ys.mean_.round(6).tolist(),
        "y_std": ys.scale_.round(6).tolist(),
        "layers": [{"W": W.round(6).tolist(), "b": b.round(6).tolist()} for W, b in zip(model.coefs_, model.intercepts_)],
        "train_examples": int(train.sum()),
        "metrics": metrics,
    }
    with open(args.out, "w") as f:
        json.dump(out, f)

    print("")
    print("Saved {}".format(args.out))
    print("Tested on {} ({} storm-period examples)".format(test_label, metrics["test_examples"]))
    print("Average error predicting 30 min ahead: model {:.3f} ft, trend continues {:.3f} ft, no change {:.3f} ft".format(m["model_30"], m["trend_30"], m["still_30"]))
    print("Average error predicting 60 min ahead: model {:.3f} ft, trend continues {:.3f} ft, no change {:.3f} ft".format(m["model_60"], m["trend_60"], m["still_60"]))
    if metrics["improvement_vs_trend_60"] is not None:
        print("At 60 minutes the model's error is {:.0%} lower than assuming the current trend continues.".format(metrics["improvement_vs_trend_60"]))


if __name__ == "__main__":
    main()
