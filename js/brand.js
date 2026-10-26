export const LOGO = `<svg class="logo" viewBox="0 0 32 32" aria-hidden="true">
  <circle cx="16" cy="16" r="13" fill="#fbf6ea"/>
  <path d="M3.1 17.5 C 7 14.8, 10.5 14.8, 14.3 17.5 S 21.7 20.2, 25.5 17.5 C 26.6 16.7, 27.8 16.6, 28.9 17.5 A13 13 0 0 1 3.1 17.5 Z" fill="#2f7fc1"/>
  <circle cx="16" cy="16" r="13" fill="none" stroke="#0f2740" stroke-width="2.6"/>
</svg>`;

const line = (body) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

export const ICONS = {
  measure: line('<path d="M17 4v16M14 20h6M7 5.5h10"/><rect x="3.5" y="5" width="7" height="4.5" rx="1"/><path d="M5 13q2 1.3 4 0M4 16.5q3 1.9 6 0"/>'),
  map: line('<path d="M3 6.5 9 4l6 2.5L21 4v13.5L15 20l-6-2.5L3 20z"/><path d="M9 4v13.5M15 6.5V20"/>'),
  predict: line('<path d="M4 4v16h16"/><path d="M7 15l3.5-4 3 2.5L19 7"/><path d="M15.5 7H19v3.5"/>'),
  alert: line('<path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15z"/><path d="M10 20.5a2 2 0 0 0 4 0"/>'),
  chip: line('<rect x="6" y="6" width="12" height="12" rx="1.5"/><rect x="9.5" y="9.5" width="5" height="5" rx=".5"/><path d="M9 3v3M15 3v3M9 18v3M15 18v3M3 9h3M3 15h3M18 9h3M18 15h3"/>'),
  waves: line('<path d="M3 15c2 0 2-2 4.5-2s2.5 2 4.5 2 2-2 4.5-2 2.5 2 4.5 2"/><path d="M3 19c2 0 2-2 4.5-2s2.5 2 4.5 2 2-2 4.5-2 2.5 2 4.5 2"/><path d="M12 3v7M9 7l3 3 3-3"/>'),
  thermo: line('<path d="M14 14.8V5a2 2 0 0 0-4 0v9.8a4 4 0 1 0 4 0z"/><path d="M12 9v7"/>'),
  sun: line('<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2.5M12 19v2.5M4.6 4.6l1.8 1.8M17.6 17.6l1.8 1.8M2.5 12H5M19 12h2.5M4.6 19.4l1.8-1.8M17.6 6.4l1.8-1.8"/>'),
  phone: line('<rect x="7" y="2.5" width="10" height="19" rx="2"/><path d="M11 18.5h2"/><path d="M9.5 8.5a3.5 3.5 0 0 1 5 0M10.8 10.6a1.6 1.6 0 0 1 2.4 0"/>'),
  database: line('<ellipse cx="12" cy="5.5" rx="7" ry="2.5"/><path d="M5 5.5v13c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5v-13"/><path d="M5 12c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5"/>'),
  shield: line('<path d="M12 3 5 6v5c0 4.5 3 8.3 7 10 4-1.7 7-5.5 7-10V6z"/><path d="m9 12 2 2 4-4"/>'),
  nodes: line('<circle cx="5" cy="7" r="2"/><circle cx="5" cy="17" r="2"/><circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/><circle cx="19" cy="12" r="2"/><path d="M7 7.5l3-2M7 7.8l3 3.6M7 16.2l3-3.6M7 16.5l3 2M14 5.8l3.4 5M14 12h3M14 18.2l3.4-5"/>'),
  key: line('<circle cx="8" cy="15" r="4"/><path d="M11 12l8-8M16 7l2.5 2.5M14 9l2 2"/>'),
  code: line('<path d="M8 7l-5 5 5 5M16 7l5 5-5 5M13.5 4.5l-3 15"/>'),
  layers: line('<path d="M12 3 3 8l9 5 9-5z"/><path d="m3 12.5 9 5 9-5"/><path d="m3 16.5 9 5 9-5"/>'),
  mountain: line('<path d="M3 19 9.5 8l3.5 6 2-3 6 8z"/><path d="M3 21h18"/>'),
  chart: line('<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>'),
  river: line('<path d="M6 3c3 3-2 6 1 9s-2 6 1 9M14 3c3 3-2 6 1 9s-2 6 1 9"/>'),
  rain: line('<path d="M7 15a4 4 0 0 1-.5-8 5.5 5.5 0 0 1 10.5 1.5A3.5 3.5 0 0 1 17 15z"/><path d="M8 18l-1 2.5M12 18l-1 2.5M16 18l-1 2.5"/>'),
  pin: line('<path d="M12 21s-6.5-6.2-6.5-11a6.5 6.5 0 0 1 13 0c0 4.8-6.5 11-6.5 11z"/><circle cx="12" cy="10" r="2.3"/>'),
  car: line('<path d="M5 16V12l2-5h10l2 5v4M3.5 16h17"/><circle cx="7.5" cy="17.5" r="1.8"/><circle cx="16.5" cy="17.5" r="1.8"/><path d="M5.5 12h13"/>'),
  home: line('<path d="M4 11 12 4l8 7"/><path d="M6 10v10h12V10"/><path d="M9 20v-3.5c1-.8 2-1.2 3-1.2s2 .4 3 1.2V20"/>'),
  city: line('<path d="M3 20h18M5 20V9l5-3v14M10 20V4h6v16M16 20V10h3v10"/><path d="M12.5 7.5h1M12.5 10.5h1M12.5 13.5h1"/>'),
};

export const icon = (name) => ICONS[name] || '';
