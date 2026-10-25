import { icon } from './icons.js';

// Cross-section of a street at the bottom of a hill: rain, pooled water, the sensor on its pole,
// and the alert reaching a phone.
const drops = [
  [36, 30], [92, 62], [150, 24], [208, 70], [262, 36], [318, 80], [372, 28], [430, 64], [486, 34],
  [70, 108], [128, 128], [186, 104], [244, 132], [300, 112], [356, 140], [412, 104], [468, 96],
  [20, 160], [96, 172], [520, 70], [548, 112],
].map(([x, y]) => `<path d="M${x} ${y}l-5 11"/>`).join('');

export const ILLUSTRATION = `
<svg class="hero-art" viewBox="0 0 640 360" role="img" aria-label="Cross-section of a street at the bottom of a hill with water pooled under a FloodMesh sensor">
  <rect width="640" height="360" fill="#e8f0f5"/>
  <g fill="#ffffff">
    <ellipse cx="120" cy="34" rx="58" ry="20"/><ellipse cx="160" cy="26" rx="40" ry="22"/><ellipse cx="88" cy="40" rx="34" ry="16"/>
    <ellipse cx="420" cy="30" rx="50" ry="17"/><ellipse cx="452" cy="22" rx="34" ry="18"/>
  </g>
  <g stroke="#8fb3cc" stroke-width="2" stroke-linecap="round">${drops}</g>
  <rect x="250" y="246" width="320" height="60" fill="#4f97cf"/>
  <path d="M0 140 C 130 150, 250 238, 380 262 S 520 256, 640 200 L640 360 L0 360 Z" fill="#d3dbcf"/>
  <path d="M0 140 C 130 150, 250 238, 380 262 S 520 256, 640 200" fill="none" stroke="#33414d" stroke-width="7" stroke-linecap="round"/>
  <path d="M0 140 C 130 150, 250 238, 380 262 S 520 256, 640 200" fill="none" stroke="#ffffff" stroke-width="1.2" stroke-dasharray="10 12" transform="translate(0 -1)"/>
  <path d="M0 158 C 130 168, 250 256, 380 280 S 520 274, 640 218" fill="none" stroke="#bcc6b8" stroke-width="2"/>
  <line x1="312" y1="246" x2="530" y2="246" stroke="#ffffff" stroke-width="2" stroke-opacity="0.75"/>

  <g transform="translate(176 196) rotate(24)">
    <path d="M-30 -2 L-24 -14 L8 -14 L16 -2 Z" fill="#1d6fa5"/>
    <rect x="-34" y="-4" width="54" height="11" rx="3" fill="#1d6fa5"/>
    <path d="M-21 -12 L-17 -5 L2 -5 L6 -12 Z" fill="#cfe3f2"/>
    <circle cx="-22" cy="8" r="5" fill="#22303b"/><circle cx="10" cy="8" r="5" fill="#22303b"/>
  </g>

  <rect x="560" y="110" width="6" height="128" fill="#5b6875"/>
  <rect x="436" y="112" width="130" height="5" fill="#5b6875"/>
  <polygon points="540,94 588,82 592,90 544,102" fill="#1d3c58" stroke="#ffffff" stroke-width="1.5"/>
  <rect x="552" y="100" width="22" height="14" rx="2" fill="#0e2a3f"/>
  <rect x="426" y="117" width="30" height="16" rx="2.5" fill="#0e2a3f"/>
  <g fill="none" stroke="#1d6fa5" stroke-width="2" stroke-linecap="round">
    <path d="M430 148 Q441 154 452 148"/>
    <path d="M424 170 Q441 180 458 170" stroke-opacity="0.75"/>
    <path d="M418 193 Q441 205 464 193" stroke-opacity="0.55"/>
    <path d="M412 216 Q441 230 470 216" stroke-opacity="0.35"/>
  </g>
  <g fill="none" stroke="#0e2a3f" stroke-width="2" stroke-linecap="round">
    <path d="M584 66 a12 12 0 0 1 12 12"/>
    <path d="M584 54 a24 24 0 0 1 24 24" stroke-opacity="0.6"/>
  </g>

  <g transform="translate(588 108) scale(0.8)">
    <rect x="0" y="0" width="58" height="104" rx="9" fill="#ffffff" stroke="#0e2a3f" stroke-width="2.5"/>
    <rect x="6" y="18" width="46" height="26" rx="5" fill="#fbe9e7" stroke="#c0392b" stroke-width="1.2"/>
    <circle cx="13" cy="25" r="3" fill="#c0392b"/>
    <rect x="19" y="23" width="28" height="3.5" rx="1.5" fill="#c0392b"/>
    <rect x="10" y="32" width="36" height="3" rx="1.5" fill="#8a5b55"/>
    <rect x="10" y="38" width="26" height="3" rx="1.5" fill="#8a5b55"/>
    <rect x="10" y="54" width="38" height="3" rx="1.5" fill="#c9d1d8"/>
    <rect x="10" y="61" width="30" height="3" rx="1.5" fill="#c9d1d8"/>
  </g>

  <g font-family="Montserrat, sans-serif" font-size="13" font-weight="600" fill="#0e2a3f">
    <text x="236" y="112">Sensor measures the gap</text>
    <text x="236" y="128">to the water every second</text>
    <path d="M396 120 L424 124" stroke="#0e2a3f" stroke-width="1.2"/>
    <text x="300" y="330">Water collects at the bottom of the hill</text>
    <path d="M396 316 L412 256" stroke="#0e2a3f" stroke-width="1.2"/>
    <text x="22" y="236">Drivers see it on the map</text>
    <text x="22" y="252">before they reach it</text>
  </g>
</svg>`;

const STEPS = [
  { icon: 'sensor', title: 'Measure', body: 'A solar-powered sensor mounted above the road measures the distance down to the surface several times a second. When water collects, that distance shrinks.' },
  { icon: 'chart', title: 'Filter', body: 'The sensor throws out splashes and debris, then calculates how fast the water is rising before it sends a reading every 10 seconds.' },
  { icon: 'layers', title: 'Combine', body: 'FloodMesh layers live readings over USGS elevation data and the National Weather Service forecast to map where water is likely to collect.' },
  { icon: 'bell', title: 'Alert', body: 'Drivers see flooded roads and safer routes. Homeowners get a phone alert when water reaches their basement. Towns see where the next sensor should go.' },
];

const AUDIENCES = [
  { icon: 'car', title: 'Drivers and residents', body: 'Check any street before you leave. Report flooding you see so the next driver knows.', action: 'Open the live map', go: 'public' },
  { icon: 'home', title: 'Homeowners', body: 'Put a sensor in the basement. It alerts your phone at the first sign of standing water and runs through power outages.', action: 'Set up a home sensor', go: 'home' },
  { icon: 'city', title: 'Municipal staff', body: 'Monitor every street sensor in one table, install new ones from the map, and see ranked locations that need coverage.', action: 'Municipal sign in', go: 'auth' },
];

export function welcomeHtml() {
  const steps = STEPS.map((s, i) => `
    <li class="step">
      <div class="step-icon">${icon(s.icon)}</div>
      <div class="step-text"><span class="step-num">Step ${i + 1}</span><h3>${s.title}</h3><p>${s.body}</p></div>
    </li>`).join('');
  const audiences = AUDIENCES.map((a) => `
    <article class="audience">
      <div class="audience-icon">${icon(a.icon)}</div>
      <h3>${a.title}</h3>
      <p>${a.body}</p>
      <button class="link-btn arrow" data-welcome="${a.go}">${a.action}</button>
    </article>`).join('');
  return `
    <div class="welcome-inner">
      <button class="welcome-close" data-welcome="public" aria-label="Close and open the map">Skip to map</button>
      <section class="hero">
        <div class="hero-text">
          <p class="eyebrow">Edison, NJ pilot</p>
          <h1>Street-level flood readings for Edison, updated every 10 seconds.</h1>
          <p class="lede">FloodMesh sensors watch the low spots where water collects first, starting at the bottom of the Mt. Pleasant Ave hill near John Adams Middle School and J.P. Stevens High School. The map pairs those readings with elevation and the rain forecast to show where flooding is likely before it happens.</p>
          <div class="hero-actions">
            <button class="btn btn-large" data-welcome="public">Open the live map</button>
            <button class="btn btn-secondary btn-large" data-welcome="how">How it works</button>
          </div>
        </div>
        <div class="hero-figure">${ILLUSTRATION}</div>
      </section>
      <section class="how" id="how-it-works">
        <h2>How it works</h2>
        <ol class="steps">${steps}</ol>
      </section>
      <section class="who">
        <h2>Who it is for</h2>
        <div class="audiences">${audiences}</div>
      </section>
      <p class="welcome-foot">Elevation from USGS 3DEP via AWS Terrain Tiles. Weather from the National Weather Service. Flood zones from FEMA. Map data from OpenStreetMap contributors.</p>
    </div>`;
}
