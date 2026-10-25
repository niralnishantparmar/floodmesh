# FloodMesh

Street-level flood monitoring for Edison, New Jersey.

FloodMesh is a network of low-cost water level sensors and a web app that shows, in real time, how much water is on the road at known trouble spots. The pilot area is the bottom of the hill on Mt. Pleasant Ave, near John Adams Middle School and J.P. Stevens High School.

The same sensor also works indoors. A homeowner can place one in a basement and get an alert when standing water appears, whether from heavy rain or a burst pipe.

## What the app does

**For residents and drivers**
- Flood risk heatmap built from USGS elevation data, scaled by the National Weather Service rain forecast and live readings
- Click any spot for a breakdown: elevation relative to the surrounding ground, how much land drains there, whether it sits in a dip, its FEMA flood zone, the weather, and nearby sensors and reports
- Live map of street sensors, drawn as gauges that fill as water approaches the flooding line
- Water depth above the road, trend, and an estimate of when the road becomes impassable
- In-app alerts when a sensor starts rising or floods
- Community reports: drag a pin to a flooded road or blocked drain and submit it; reports expire after four hours

**For homeowners**
- Private dashboard for sensors installed at home
- Water-detected, low-battery, and offline alerts
- Calibration from the app (no reflashing needed)

**For municipal staff**
- Ranked list of road locations that most need a sensor, skipping areas existing sensors already cover
- Network health table: status, last reading, and battery for every street sensor
- Install a new sensor by placing it on the map; the app issues its device key
- Street sensors can only be created by accounts verified as municipal staff

## How it works

```
A02YYUW ultrasonic + DS18B20 temperature
        |
ESP32-S3: median filter, rise rate by least squares, Wi-Fi upload every 10 s
        |
Supabase (Postgres): submit_reading() checks the device key and computes depth
        |
Web app: live updates, status logic, alerts, map
```

The sensor measures the distance from its face down to the water. Depth is the dry-level distance minus the current distance, so recalibrating in the app corrects all past readings too.

### Flood risk model (`js/risk.js`)

Elevation comes from AWS Terrain Tiles (USGS 3DEP, about 10 m source resolution), resampled to a 14.5 m grid over a 3 km square around the pilot sensors. Each cell is scored from four terrain signals:

- How much lower it is than the ground within 500 ft (30%)
- How much lower it is than the ground within 1,600 ft (20%)
- How much upstream land drains through it, from D8 flow accumulation after priority-flood sink filling (30%)
- Whether it sits in a closed dip that holds water, and how deep (20%)

The terrain score is scaled by expected rainfall intensity from the NWS forecast (or the replay), and every sensor reading water or community report adds a hotspot around it. Recommended sensor sites are the highest-scoring road cells (roads from OpenStreetMap) that are at least 850 ft from an existing sensor and 720 ft from each other.

### Water level forecast (`model/train_forecast.py`, `js/forecast.js`)

A small neural network (two hidden layers, 32 and 16 units) predicts how much the water will rise or fall over the next 30 and 60 minutes. It is trained on several years of 15-minute gage height readings from a USGS stream gauge near Edison, paired with hourly rainfall from Open-Meteo. Inputs are the level changes over the last 15, 30, 60, and 120 minutes, how far the water already sits above its recent low, and rainfall over the past 1, 3, and 6 hours plus the next hour. Levels are scaled to each site so the same model can run on a stream gauge or a street sensor, where the scale is the flooding line.

The model is tested on a year it never saw during training and compared against two simple baselines: assuming the current trend continues, and assuming no change. The trained weights are exported to `model/forecast.json` and run directly in the browser.

To retrain:

```
cd model
python3 -m venv fm-env
source fm-env/bin/activate
pip install numpy scikit-learn
python3 train_forecast.py
```

Status rules (in `js/logic.js`):
- **Flooding**: depth at or above the impassable threshold (6 in by default for streets)
- **Warning**: projected to reach the threshold within 30 minutes, or depth above 60% of the threshold
- **Rising**: rising faster than 0.2 cm per minute
- **Offline**: no reading for two minutes

## Hardware

| Part | Purpose |
|---|---|
| ESP32-S3 DevKitC-1 (N16R8) | Microcontroller with Wi-Fi |
| A02YYUW waterproof ultrasonic, UART controlled | Water level, 3 to 450 cm range |
| DS18B20 waterproof probe with adapter board | Air temperature |
| Waveshare Solar Power Manager | Solar charging, battery protection, 5 V output |
| 6 V 1 W solar panel | Outdoor charging |
| 3.7 V 18650 Li-ion pack | Runs the sensor overnight and through outages |
| 1 kΩ resistor | Protects the ESP32 transmit pin on the sensor line |

The DS18B20 reports air temperature, which affects the speed of sound the ultrasonic sensor relies on, and powers the ice warning when water sits on the road below freezing.

Wiring: sensor TX to GPIO 18, sensor RX through 1 kΩ to GPIO 17, DS18B20 data to GPIO 4, both sensors on 3V3 and GND.

## Repository layout

```
index.html, css/, js/          Web app (no build step)
firmware/FloodMesh_node/       ESP32 firmware (Arduino)
supabase/schema.sql            Tables, row level security, device upload function
supabase/seed.sql              Pilot sensors for the Mt. Pleasant Ave area
```

## Running it

1. Create a Supabase project and run `supabase/schema.sql`, then `supabase/seed.sql`.
2. Put the project URL and publishable key in `js/config.js`.
3. Serve the folder (GitHub Pages, or `python3 -m http.server` locally).
4. In the firmware, set the Wi-Fi name, password, and the sensor's device key, then upload.

## Data and libraries

- Elevation: USGS 3DEP via AWS Terrain Tiles
- Weather and alerts: National Weather Service API
- Hourly rainfall: Open-Meteo (CC BY 4.0)
- Stream gauge history: U.S. Geological Survey
- Flood zones: FEMA National Flood Hazard Layer
- Roads and map tiles: © OpenStreetMap contributors
- [Leaflet](https://leafletjs.com) for the map, [Chart.js](https://www.chartjs.org) for charts
- [Supabase](https://supabase.com) for the database, authentication, and live updates

## Status

This is a working prototype. One physical sensor is deployed for testing; the two school sites run on simulated data to demonstrate the network. Storm replay plays a three-hour storm at 60 times speed for demonstrations. Alerts are shown inside the app while it is open; background push notifications are planned for a mobile release.
