const ICON = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 8h14M5 12h10M5 16h6" stroke="#fff" stroke-width="2.2" stroke-linecap="round"/></svg>`;

const MAX_VISIBLE = 4;
const SHOW_MS = 9000;

function stack() {
  return document.getElementById('notice-stack');
}

function dismiss(el) {
  el.classList.remove('show');
  setTimeout(() => el.remove(), 250);
}

// level: info | warning | danger
export function notify({ title, body, level = 'info' }) {
  const host = stack();
  if (!host) return;
  const el = document.createElement('div');
  el.className = `notice notice-${level}`;
  el.setAttribute('role', 'status');
  el.innerHTML = `
    <div class="notice-icon">${ICON}</div>
    <div class="notice-text">
      <div class="notice-meta"><span>FloodMesh</span><span>now</span></div>
      <div class="notice-title"></div>
      <div class="notice-body"></div>
    </div>`;
  el.querySelector('.notice-title').textContent = title;
  el.querySelector('.notice-body').textContent = body;
  el.addEventListener('click', () => dismiss(el));
  host.prepend(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => dismiss(el), SHOW_MS);
  while (host.children.length > MAX_VISIBLE) host.lastElementChild.remove();

  if ('Notification' in window && Notification.permission === 'granted' && document.visibilityState !== 'visible') {
    try {
      new Notification(title, { body });
    } catch (err) {
      console.warn('Browser notification failed', err);
    }
  }
}

export function browserAlertState() {
  if (!('Notification' in window)) return 'unsupported';
  return Notification.permission;
}

export async function enableBrowserAlerts() {
  if (!('Notification' in window)) return 'unsupported';
  return Notification.requestPermission();
}
