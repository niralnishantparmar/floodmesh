# FloodMesh

A live map of street flooding, built from low-cost water sensors, public elevation data, and a forecast that looks an hour ahead.

Search for any address to see which nearby spots collect water first in a heavy storm. Wherever FloodMesh sensors are installed, the map also shows the actual water level on the road, updated every ten seconds, along with a prediction of where it is headed. The pilot sensor sits at the bottom of the Mt. Pleasant Ave hill in Edison, New Jersey.

## What it does

**For drivers and residents**
- Flood risk shading for anywhere in the world, from elevation data, scaled by the rain forecast and by live readings
- Click any spot for an explanation: how much lower it sits than the ground around it, how much land drains toward it, whether it is in a dip that holds water, its FEMA flood zone, the weather, and nearby sensors and reports
- Live sensor readings with a 30 and 60 minute forecast, and alerts when water starts rising
- Community reports of flooded roads. Whoever sent a report can remove it, town staff can remove any report, and a report disappears once two people mark the water as gone

**For homeowners**
- A sensor in a basement or crawl space that alerts your phone when standing water appears, with low battery and offline alerts
- Home sensors are private to the owner and never appear on the public map

**For town staff**
- A table of every street sensor with its status and last reading
- Suggested sensor locations: the most flood-prone road spots in view that no sensor covers yet
- Street sensors can only be added by accounts verified as town staff

## Connecting a sensor

1. Plug the sensor in. It opens a Wi-Fi network named FloodMesh followed by four letters.
2. Join that network on a phone. A setup page opens; choose the home Wi-Fi network and enter its password.
3. The page shows a six-character pairing code. In the app, choose **Add a sensor**, enter the code, name the sensor, and save its dry level.

Holding the sensor's BOOT button for three seconds clears its Wi-Fi settings and starts setup over. Removing a sensor in the app frees it to be paired again.

## How it works

```
Ultrasonic distance + air temperature
        |
ESP32-S3: median filter, rise rate by least squares, upload every 10 s
        |
Supabase (Postgres): device pairing, readings, accounts, row level security, live updates
        |
Web app: status rules, forecast model, terrain risk model, alerts, map
```

### Terrain flood model (`js/risk.js`, `js/insight.js`)

Elevation comes from AWS Terrain Tiles (USGS 3DEP in the United States, other public sources elsewhere). The app analyzes whatever area is on screen, choosing a grid between about 50 and 400 feet per cell depending on zoom. Each cell is scored from four signals: how much lower it is than the ground within 500 ft (30%), how much lower it is than the ground within 1,600 ft (20%), how much upstream land drains through it, using D8 flow accumulation after priority-flood sink filling (30%), and whether it sits in a closed dip and how deep (20%). Only the highest-scoring ground is shaded. The score is scaled by forecast rainfall from Open-Meteo, and every sensor showing water or resident report adds a hotspot.

### Water level forecast (`model/train_forecast.py`, `js/forecast.js`)

A small neural network (two hidden layers of 32 and 16 units) predicts how much the water will rise or fall over the next 30 and 60 minutes. It was trained on seven years (2019 to 2025) of 15-minute gage height readings from the USGS gauge on the Raritan River below Calco Dam at Bound Brook, NJ, paired with hourly rainfall. Inputs are the level changes over the last 15, 30, 60, and 120 minutes, how far the water sits above its recent low, and rainfall over the past 1, 3, and 6 hours and the next hour. Levels are scaled to each site, so the same model runs on a river gauge or a street sensor, where the scale is the flooding line.

Tested on 2025, a year held out from training, against the baseline of assuming the current trend continues:

| Horizon | Model error | Trend continues | Improvement |
|---|---|---|---|
| 30 minutes | 0.012 ft | 0.013 ft | 9% |
| 60 minutes | 0.025 ft | 0.032 ft | 24% |
| 60 minutes, while water is rising | 0.101 ft | 0.172 ft | 41% |

No public record of street flooding exists to train on yet, so the model learned from a river and applies the same pattern to street sensors. It will be retrained on FloodMesh readings once sensors have logged a season of storms.

To retrain:

```
cd model
python3 -m venv fm-env
source fm-env/bin/activate
pip install numpy scikit-learn
python3 train_forecast.py
```

### Status rules (`js/logic.js`)

- **Flooding**: depth at or above the flooding line (6 in by default for streets)
- **Warning**: projected to reach the line within 30 minutes, or above 60% of it
- **Rising**: rising faster than 0.2 cm per minute
- **Offline**: no reading for two minutes
- **Ice risk**: air at or below about 34°F with water on the road

## Hardware

| Part | Purpose |
|---|---|
| ESP32-S3 DevKitC-1 (N16R8) | Microcontroller with Wi-Fi |
| A02YYUW waterproof ultrasonic sensor, UART controlled | Water level, 3 to 450 cm range |
| DS18B20 waterproof probe with adapter board | Air temperature for ice warnings |
| Waveshare Solar Power Manager | Solar charging, battery protection, 5 V output |
| 6 V 1 W solar panel | Outdoor charging |
| 3.7 V 18650 Li-ion pack | Overnight and outage power |
| 1 kΩ resistor | Protects the ESP32 transmit pin on the sensor line |

Wiring: sensor TX to GPIO 18, sensor RX through 1 kΩ to GPIO 17, DS18B20 data to GPIO 4, both sensors on 3V3 and GND. Parts cost about $70.

## Repository layout

```
index.html, css/, js/          Web app, no build step
firmware/FloodMesh_node/       ESP32 firmware with phone-based Wi-Fi setup and pairing
model/                         Forecast training script and trained weights
supabase/schema.sql            Full database: tables, row level security, pairing and report functions
supabase/update_1.sql          Upgrade for databases created from the first schema
supabase/seed.sql              Optional demo basement sensor
```

## Running it

1. Create a Supabase project and run `supabase/schema.sql` (or `update_1.sql` on an older database).
2. Put the project URL and publishable key in `js/config.js` and in the firmware.
3. Serve the folder with GitHub Pages, or locally with `python3 -m http.server`.
4. Flash `firmware/FloodMesh_node/FloodMesh_node.ino` with the Arduino IDE (board: ESP32S3 Dev Module).

## Limits and next steps

- Alerts appear while the app is open. Background push notifications need a mobile app.
- Place search uses the public Nominatim service, which allows about one request per second; a larger deployment would run its own geocoder.
- The forecast was trained on river data and should be retrained on street readings.
- The terrain model does not know about storm drain capacity, which local public works data could add.

## Data and libraries

- Elevation: USGS 3DEP via AWS Terrain Tiles
- Weather: Open-Meteo (CC BY 4.0) and the National Weather Service
- Flood zones: FEMA National Flood Hazard Layer
- River data: U.S. Geological Survey
- Roads, place search, and map tiles: OpenStreetMap contributors
- Leaflet, Chart.js, Supabase, scikit-learn
