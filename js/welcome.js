import { LOGO } from './brand.js';

const DROPS = [
  [36, 30], [92, 62], [150, 24], [208, 70], [262, 36], [318, 80], [372, 28], [430, 64], [486, 34],
  [70, 108], [128, 128], [186, 104], [244, 132], [300, 112], [356, 140], [412, 104], [468, 96],
  [20, 160], [96, 172], [520, 70], [548, 112],
];

const drops = DROPS.map(([x, y], k) => `<path class="drop" style="animation-delay:${(-(k * 0.37) % 1.4).toFixed(2)}s" d="M${x} ${y}l-4 10"/>`).join('');

export const ILLUSTRATION = `
<svg class="art" viewBox="0 0 640 360" role="img" aria-label="A street at the bottom of a hill, with rainwater pooled under a sensor mounted on a pole">
  <rect width="640" height="360" fill="#e7f1f8"/>
  <g fill="#ffffff"><ellipse cx="120" cy="36" rx="56" ry="18"/><ellipse cx="158" cy="28" rx="38" ry="20"/><ellipse cx="430" cy="32" rx="46" ry="15"/></g>
  <g stroke="#8fb6d1" stroke-width="1.8" stroke-linecap="round">${drops}</g>
  <g class="tide">
    <rect x="250" y="246" width="320" height="70" fill="#2f7fc1"/>
    <line x1="250" y1="246" x2="570" y2="246" stroke="#ffffff" stroke-width="1.6" stroke-opacity="0.75"/>
  </g>
  <path d="M0 140 C 130 150, 250 238, 380 262 S 520 256, 640 200 L640 360 L0 360 Z" fill="#e9dcbc"/>
  <path d="M0 140 C 130 150, 250 238, 380 262 S 520 256, 640 200" fill="none" stroke="#0f2740" stroke-width="6" stroke-linecap="round"/>
  <path d="M0 140 C 130 150, 250 238, 380 262 S 520 256, 640 200" fill="none" stroke="#f5c242" stroke-width="1.2" stroke-dasharray="9 11" transform="translate(0 -1)"/>
  <g transform="translate(176 196) rotate(24)">
    <path d="M-30 -2 L-24 -14 L8 -14 L16 -2 Z" fill="#ec6a4c"/>
    <rect x="-34" y="-4" width="54" height="11" rx="3" fill="#ec6a4c"/>
    <path d="M-21 -12 L-17 -5 L2 -5 L6 -12 Z" fill="#e3f1fb"/>
    <circle cx="-22" cy="8" r="5" fill="#0f2740"/><circle cx="10" cy="8" r="5" fill="#0f2740"/>
  </g>
  <rect x="560" y="110" width="5" height="128" fill="#3a4b5c"/>
  <rect x="436" y="112" width="129" height="4" fill="#3a4b5c"/>
  <polygon points="540,94 588,82 592,90 544,102" fill="#163e66" stroke="#e7f1f8" stroke-width="1.5"/>
  <rect x="552" y="100" width="22" height="14" rx="2" fill="#0f2740"/>
  <rect x="426" y="116" width="30" height="16" rx="3" fill="#0f2740"/>
  <g fill="none" stroke="#2f7fc1" stroke-width="2" stroke-linecap="round">
    <path class="ping" d="M430 148 Q441 154 452 148"/>
    <path class="ping" style="animation-delay:.25s" d="M424 170 Q441 180 458 170"/>
    <path class="ping" style="animation-delay:.5s" d="M418 193 Q441 205 464 193"/>
    <path class="ping" style="animation-delay:.75s" d="M412 216 Q441 230 470 216"/>
  </g>
  <g font-family="'Public Sans', sans-serif" font-size="12.5" font-weight="600" fill="#0f2740">
    <text x="244" y="114">The sensor measures the gap</text>
    <text x="244" y="130">down to the water</text>
    <path d="M400 124 L424 124" stroke="#0f2740" stroke-width="1"/>
    <text x="308" y="330">Water collects where the ground dips</text>
    <path d="M400 316 L412 256" stroke="#0f2740" stroke-width="1"/>
  </g>
</svg>`;

const STEPS = [
  ['Measure', 'A sensor above a road or basement floor measures the distance down to the surface. When water collects, that distance shrinks and the sensor reports it every ten seconds.'],
  ['Map', 'Elevation data shows the low spots and drainage paths where water gathers, and the rain forecast shows how likely they are to fill up.'],
  ['Predict', 'A neural network trained on seven years of river readings and rainfall estimates where the water will be in 30 and 60 minutes.'],
  ['Alert', 'People watching a sensor hear about rising water before the road goes under, and residents can report flooding they see.'],
];

const PHOTOS = [
  ['sensor.jpg', 'The FloodMesh prototype in its 3D-printed case.'],
  ['inside.jpg', 'Inside: the ESP32-S3, the solar charger, and the battery.'],
  ['test.jpg', 'Testing the sensor over a tub of water.'],
  ['street.jpg', 'The bottom of the Mt. Pleasant Ave hill in Edison, where the first sensor goes.'],
  ['setup.jpg', 'Connecting a sensor to Wi-Fi from a phone.'],
  ['alert.jpg', 'A flooding alert arriving in the app.'],
];

const LANES = [
  ['On the street', 'The sensor itself, built from parts that cost about $70.', [
    ['ESP32-S3 microcontroller', 'Reads the sensors, filters out splashes, and sends a reading every 10 seconds over Wi-Fi.'],
    ['Waterproof ultrasonic sensor', 'Measures the distance down to the water from up to 15 feet away.'],
    ['Temperature probe', 'Tracks the air temperature so the app can warn about ice.'],
    ['Solar charger and battery', 'Keeps the sensor running through cloudy days and power outages.'],
    ['Phone setup page', 'Lets anyone connect the sensor to Wi-Fi and pair it without touching code.'],
  ]],
  ['In the cloud', 'Where readings are stored, protected, and turned into predictions.', [
    ['Supabase and Postgres', 'Stores readings, sensors, and accounts, and pushes new readings to the map the moment they arrive.'],
    ['Row-level security', 'Keeps home sensors private and limits street sensors to verified town staff.'],
    ['Server-side checks', 'Handle sensor pairing, report removal, and spam limits so they can\'t be bypassed.'],
    ['Neural network forecast', 'Trained in Python with scikit-learn on seven years of USGS river readings.'],
  ]],
  ['On your screen', 'A web app that runs on any phone or laptop with nothing to install.', [
    ['JavaScript web app', 'Hosted on GitHub Pages and built without a framework, so it loads quickly.'],
    ['Leaflet maps', 'Draws the map, the sensors, resident reports, and the risk shading.'],
    ['Terrain flood model', 'Finds low spots and drainage paths from elevation data, right in the browser.'],
    ['Chart.js', 'Plots each sensor\'s water level along with its forecast for the next hour.'],
  ]],
];

const SOURCES = [
  ['USGS 3DEP', 'elevation'],
  ['USGS river gauges', 'forecast training data'],
  ['Open-Meteo', 'rainfall and forecasts'],
  ['National Weather Service', 'flood watches and warnings'],
  ['FEMA', 'official flood zones'],
  ['OpenStreetMap', 'roads, places, and the base map'],
];

const WHO = [
  ['Drivers and residents', 'Look up any address, check your route before heading out, and report flooding you come across.', 'Open the map', 'map'],
  ['Homeowners', 'A sensor in the basement alerts your phone at the first sign of standing water, even during a power outage.', 'Add a home sensor', 'mine'],
  ['Town staff', 'See every street sensor at a glance, add new ones in minutes, and find the low spots that still need coverage.', 'Staff sign in', 'auth'],
];

export function welcomeHtml() {
  const steps = STEPS.map(([title, text], k) => `<div><span class="num">0${k + 1}</span><h3><span>${title}</span></h3><p>${text}</p></div>`).join('');
  const photos = PHOTOS.map(([file, caption]) => `<figure><img src="img/${file}" alt="${caption}" loading="lazy" onerror="this.parentElement.remove()"><figcaption>${caption}</figcaption></figure>`).join('');
  const lanes = LANES.map(([title, intro, parts]) => `
    <div class="lane">
      <h3>${title}</h3>
      <p>${intro}</p>
      ${parts.map(([name, role]) => `<div class="part"><strong>${name}</strong><span>${role}</span></div>`).join('')}
    </div>`).join('');
  const sources = SOURCES.map(([name, what]) => `<div class="source"><strong>${name}</strong><span>${what}</span></div>`).join('');
  const who = WHO.map(([title, text, action, go]) => `<div class="who-col"><h3><span>${title}</span></h3><p>${text}</p><button class="link" data-welcome="${go}">${action}</button></div>`).join('');
  return `
    <section class="w-hero contours">
      <div class="w-inner">
        <nav class="w-nav">
          <span class="brand" aria-label="FloodMesh">${LOGO}</span>
          <button data-welcome="how">How it works</button>
          <button data-welcome="stack">How it's built</button>
          <button data-welcome="who">Who it's for</button>
          <button class="btn small sun" data-welcome="map">Open the map</button>
        </nav>
        <div class="w-hero-grid">
          <div>
            <h1>FloodMesh</h1>
            <p class="w-sub">A live map of street flooding, built from small water sensors, public elevation data, and a forecast that looks an hour ahead.</p>
            <p class="w-lede">Search for any address to see which nearby spots collect water first in a heavy storm. Wherever FloodMesh sensors are installed, the map also shows the actual water level on the road, updated every ten seconds, along with a prediction of where it's headed.</p>
            <p class="w-actions"><button class="btn big sun" data-welcome="map">Open the map</button><button class="link" data-welcome="how">See how it works</button></p>
          </div>
          <figure class="w-art">${ILLUSTRATION}</figure>
        </div>
      </div>
    </section>
    <section class="w-section" id="how-it-works">
      <div class="w-inner">
        <h2>How it works</h2>
        <p class="w-intro">It takes four steps to get from a puddle under a sensor to an alert on someone's phone.</p>
        <div class="w-cols four">${steps}</div>
        <div class="photos">${photos}</div>
      </div>
    </section>
    <section class="w-section w-built" id="how-its-built">
      <div class="w-inner">
        <h2>How it's built</h2>
        <p class="w-intro">Every reading travels from the street, through the cloud, to your screen. These are the pieces that handle each part of that trip.</p>
        <div class="stack">${lanes}</div>
        <div class="sources"><h3>Public data it reads</h3><div class="source-row">${sources}</div></div>
      </div>
    </section>
    <section class="w-section" id="who-its-for">
      <div class="w-inner">
        <h2>Who it's for</h2>
        <p class="w-intro">The same map serves three kinds of people, each with their own tools.</p>
        <div class="w-cols three">${who}</div>
      </div>
    </section>
    <footer class="w-inner w-foot">Elevation from USGS 3DEP and AWS Terrain Tiles. Weather from Open-Meteo and the National Weather Service. Flood zones from FEMA. River data from the USGS. Map data from OpenStreetMap contributors.</footer>`;
}
