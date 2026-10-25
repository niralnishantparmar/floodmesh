// 24px line icons, 1.8px stroke, drawn for FloodMesh.
const wrap = (body) => `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

export const ICONS = {
  sensor: wrap('<path d="M17 4v17M14 21h6M7 5.5h10"/><rect x="3.5" y="5" width="7" height="4.5" rx="1"/><path d="M5 13q2 1.3 4 0M4 16.5q3 1.9 6 0"/>'),
  wave: wrap('<path d="M3 15c2 0 2-2 4.5-2s2.5 2 4.5 2 2-2 4.5-2 2.5 2 4.5 2"/><path d="M3 19c2 0 2-2 4.5-2s2.5 2 4.5 2 2-2 4.5-2 2.5 2 4.5 2"/><path d="M12 3v7M9 7l3 3 3-3"/>'),
  chart: wrap('<path d="M4 4v16h16"/><path d="M7 15l3.5-4 3 2.5L19 7"/><path d="M15.5 7H19v3.5"/>'),
  layers: wrap('<path d="M12 3 3 8l9 5 9-5-9-5z"/><path d="m3 12.5 9 5 9-5"/><path d="m3 16.5 9 5 9-5"/>'),
  bell: wrap('<path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15L6 16z"/><path d="M10 20.5a2 2 0 0 0 4 0"/>'),
  car: wrap('<path d="M5 16V12l2-5h10l2 5v4"/><path d="M3.5 16h17"/><circle cx="7.5" cy="17.5" r="1.8"/><circle cx="16.5" cy="17.5" r="1.8"/><path d="M5.5 12h13"/>'),
  home: wrap('<path d="M4 11 12 4l8 7"/><path d="M6 10v10h12V10"/><path d="M9 20v-3.5c1-.8 2-1.2 3-1.2s2 .4 3 1.2V20"/>'),
  city: wrap('<path d="M3 20h18"/><path d="M5 20V9l5-3v14M10 20V4h6v16M16 20V10h3v10"/><path d="M12.5 7.5h1M12.5 10.5h1M12.5 13.5h1M7.5 11.5h.5M7.5 14.5h.5"/>'),
  rain: wrap('<path d="M7 15a4 4 0 0 1-.5-8 5.5 5.5 0 0 1 10.5 1.5A3.5 3.5 0 0 1 17 15H7z"/><path d="M8 18l-1 2.5M12 18l-1 2.5M16 18l-1 2.5"/>'),
  pin: wrap('<path d="M12 21s-6.5-6.2-6.5-11a6.5 6.5 0 0 1 13 0c0 4.8-6.5 11-6.5 11z"/><circle cx="12" cy="10" r="2.3"/>'),
  mountain: wrap('<path d="M3 19 9.5 8l3.5 6 2-3 6 8H3z"/><path d="M3 21h18"/>'),
  drain: wrap('<rect x="4" y="5" width="16" height="14" rx="1.5"/><path d="M8 5v14M12 5v14M16 5v14"/>'),
  shield: wrap('<path d="M12 3 5 6v5c0 4.5 3 8.3 7 10 4-1.7 7-5.5 7-10V6l-7-3z"/><path d="m9 12 2 2 4-4"/>'),
  route: wrap('<circle cx="6" cy="18" r="2"/><circle cx="18" cy="6" r="2"/><path d="M8 18h6.5a3.5 3.5 0 0 0 0-7h-5a3.5 3.5 0 0 1 0-7H16"/>'),
  battery: wrap('<rect x="3" y="8" width="16" height="9" rx="1.5"/><path d="M21 11v3"/><path d="M6 11v3M9 11v3"/>'),
  target: wrap('<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/>'),
  info: wrap('<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.5"/>'),
};

export const icon = (name) => ICONS[name] || '';
