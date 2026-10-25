import { icon } from './icons.js';

const DROPS = [
  [36, 30], [92, 62], [150, 24], [208, 70], [262, 36], [318, 80], [372, 28], [430, 64], [486, 34],
  [70, 108], [128, 128], [186, 104], [244, 132], [300, 112], [356, 140], [412, 104], [468, 96],
  [20, 160], [96, 172], [520, 70], [548, 112],
];

const drops = DROPS.map(([x, y], k) => `<path class="drop" style="animation-delay:${(-(k * 0.37) % 1.4).toFixed(2)}s" d="M${x} ${y}l-5 11"/>`).join('');

export const ILLUSTRATION = `
<svg class="hero-art" viewBox="0 0 640 360" role="img" aria-label="Cross-section of a street at the bottom of a hill with water pooled under a FloodMesh sensor">
  <rect width="640" height="360" fill="#e8f0f5"/>
  <g class="clouds" fill="#ffffff">
    <ellipse cx="120" cy="34" rx="58" ry="20"/><ellipse cx="160" cy="26" rx="40" ry="22"/><ellipse cx="88" cy="40" rx="34" ry="16"/>
    <ellipse cx="420" cy="30" rx="50" ry="17"/><ellipse cx="452" cy="22" rx="34" ry="18"/>
  </g>
  <g stroke="#8fb3cc" stroke-width="2" stroke-linecap="round">${drops}</g>
  <g class="water-level">
    <rect x="250" y="246" width="320" height="70" fill="#4f97cf"/>
    <line x1="250" y1="246" x2="570" y2="246" stroke="#ffffff" stroke-width="2" stroke-opacity="0.75"/>
  </g>
  <path d="M0 140 C 130 150, 250 238, 380 262 S 520 256, 640 200 L640 360 L0 360 Z" fill="#d3dbcf"/>
  <path d="M0 140 C 130 150, 250 238, 380 262 S 520 256, 640 200" fill="none" stroke="#33414d" stroke-width="7" stroke-linecap="round"/>
  <path d="M0 140 C 130 150, 250 238, 380 262 S 520 256, 640 200" fill="none" stroke="#ffffff" stroke-width="1.2" stroke-dasharray="10 12" transform="translate(0 -1)"/>
  <path d="M0 158 C 130 168, 250 256, 380 280 S 520 274, 640 218" fill="none" stroke="#bcc6b8" stroke-width="2"/>

  <g class="car" transform="translate(176 196) rotate(24)">
    <path d="M-30 -2 L-24 -14 L8 -14 L16 -2 Z" fill="#1f6fb2"/>
    <rect x="-34" y="-4" width="54" height="11" rx="3" fill="#1f6fb2"/>
    <path d="M-21 -12 L-17 -5 L2 -5 L6 -12 Z" fill="#cfe3f2"/>
    <circle cx="-22" cy="8" r="5" fill="#22303b"/><circle cx="10" cy="8" r="5" fill="#22303b"/>
  </g>

  <rect x="560" y="110" width="6" height="128" fill="#5b6875"/>
  <rect x="436" y="112" width="130" height="5" fill="#5b6875"/>
  <polygon points="540,94 588,82 592,90 544,102" fill="#1d3c58" stroke="#ffffff" stroke-width="1.5"/>
  <rect x="552" y="100" width="22" height="14" rx="2" fill="#0b2a44"/>
  <rect x="426" y="117" width="30" height="16" rx="2.5" fill="#0b2a44"/>
  <g fill="none" stroke="#11a39a" stroke-width="2.2" stroke-linecap="round">
    <path class="ping" style="animation-delay:0s" d="M430 148 Q441 154 452 148"/>
    <path class="ping" style="animation-delay:0.25s" d="M424 170 Q441 180 458 170"/>
    <path class="ping" style="animation-delay:0.5s" d="M418 193 Q441 205 464 193"/>
    <path class="ping" style="animation-delay:0.75s" d="M412 216 Q441 230 470 216"/>
  </g>
  <g fill="none" stroke="#0b2a44" stroke-width="2" stroke-linecap="round">
    <path class="signal" style="animation-delay:0s" d="M584 66 a12 12 0 0 1 12 12"/>
    <path class="signal" style="animation-delay:0.4s" d="M584 54 a24 24 0 0 1 24 24"/>
  </g>

  <g transform="translate(588 108) scale(0.8)">
    <g class="phone">
      <rect x="0" y="0" width="58" height="104" rx="9" fill="#ffffff" stroke="#0b2a44" stroke-width="2.5"/>
      <g class="phone-alert">
        <rect x="6" y="18" width="46" height="26" rx="5" fill="#fbe9e7" stroke="#c0392b" stroke-width="1.2"/>
        <circle cx="13" cy="25" r="3" fill="#c0392b"/>
        <rect x="19" y="23" width="28" height="3.5" rx="1.5" fill="#c0392b"/>
        <rect x="10" y="32" width="36" height="3" rx="1.5" fill="#8a5b55"/>
        <rect x="10" y="38" width="26" height="3" rx="1.5" fill="#8a5b55"/>
      </g>
      <rect x="10" y="54" width="38" height="3" rx="1.5" fill="#c9d1d8"/>
      <rect x="10" y="61" width="30" height="3" rx="1.5" fill="#c9d1d8"/>
    </g>
  </g>

  <g font-family="Montserrat, sans-serif" font-size="13" font-weight="600" fill="#0b2a44">
    <text x="236" y="112">Sensor measures the gap</text>
    <text x="236" y="128">to the water every second</text>
    <path d="M396 120 L424 124" stroke="#0b2a44" stroke-width="1.2"/>
    <text x="300" y="330">Water collects at the bottom of the hill</text>
    <path d="M396 316 L412 256" stroke="#0b2a44" stroke-width="1.2"/>
    <text x="22" y="236">Drivers see it on the map</text>
    <text x="22" y="252">before they reach it</text>
  </g>
</svg>`;

const STEPS = [
  { icon: 'sensor', tone: 'blue', title: 'Measure', body: 'A small solar-powered sensor mounted above the road measures the distance down to the surface several times a second, so it notices right away when water starts to collect underneath it.' },
  { icon: 'layers', tone: 'teal', title: 'Combine', body: 'Every reading is laid over USGS elevation data and the National Weather Service forecast, which shows where water is likely to pool across the whole neighborhood and not just at the sensor.' },
  { icon: 'chart', tone: 'amber', title: 'Predict', body: 'A neural network trained on years of readings from a nearby stream gauge, along with the rainfall that caused them, estimates how high the water will be 30 and 60 minutes from now.' },
  { icon: 'bell', tone: 'navy', title: 'Alert', body: 'Drivers see flooded streets on the map before they get there, homeowners hear about water in the basement right away, and the town can see where the next sensor should go.' },
];

const AUDIENCES = [
  { icon: 'car', tone: 'blue', title: 'Drivers and residents', body: 'Check the streets on your route before you head out, and report any flooding you run into so the next driver knows about it.', action: 'Open the live map', go: 'public' },
  { icon: 'home', tone: 'teal', title: 'Homeowners', body: 'Put a sensor in the basement and it will alert your phone as soon as standing water shows up, even if the power goes out.', action: 'Set up a home sensor', go: 'home' },
  { icon: 'city', tone: 'amber', title: 'Municipal staff', body: 'Keep an eye on every street sensor from one table, install new ones right from the map, and see a ranked list of the places that still need coverage.', action: 'Municipal sign in', go: 'auth' },
];

const STATS = [
  ['10 sec', 'between readings'],
  ['50 ft', 'terrain detail'],
  ['60 min', 'water level forecast'],
];

export function welcomeHtml() {
  const steps = STEPS.map((s) => `
    <li class="step reveal tone-${s.tone}">
      <div class="step-icon">${icon(s.icon)}</div>
      <h3>${s.title}</h3>
      <p>${s.body}</p>
    </li>`).join('');
  const audiences = AUDIENCES.map((a) => `
    <article class="audience reveal tone-${a.tone}">
      <div class="audience-icon">${icon(a.icon)}</div>
      <h3>${a.title}</h3>
      <p>${a.body}</p>
      <button class="link-btn arrow" data-welcome="${a.go}">${a.action}</button>
    </article>`).join('');
  const stats = STATS.map(([big, small]) => `<div class="stat"><span class="stat-big">${big}</span><span class="stat-small">${small}</span></div>`).join('');
  return `
    <section class="hero-band">
      <div class="welcome-inner">
        <button class="welcome-close" data-welcome="public" aria-label="Close and open the map">Skip to map</button>
        <div class="hero">
          <div class="hero-text">
            <h1>FloodMesh</h1>
            <p class="lede">Live street-level flood readings for Edison, starting at the bottom of the Mt. Pleasant Ave hill near John Adams Middle School and J.P. Stevens High School. The map pairs those readings with elevation data, the rain forecast, and a neural network that predicts the next hour.</p>
            <div class="hero-actions">
              <button class="btn btn-large btn-accent" data-welcome="public">Open the live map</button>
              <button class="btn btn-large btn-ghost" data-welcome="how">See how it works</button>
            </div>
            <div class="stats">${stats}</div>
          </div>
          <div class="hero-figure">${ILLUSTRATION}</div>
        </div>
      </div>
    </section>
    <section class="how" id="how-it-works">
      <div class="welcome-inner">
        <h2>How it works</h2>
        <ol class="steps">${steps}</ol>
      </div>
    </section>
    <section class="who">
      <div class="welcome-inner">
        <h2>Who it's for</h2>
        <div class="audiences">${audiences}</div>
        <p class="welcome-foot">Elevation comes from USGS 3DEP through AWS Terrain Tiles, weather from the National Weather Service and Open-Meteo, flood zones from FEMA, stream data from the USGS, and map data from OpenStreetMap contributors.</p>
      </div>
    </section>`;
}
