const ICON = `<svg viewBox="0 0 32 32" aria-hidden="true"><circle cx="16" cy="16" r="12" fill="#fbf6ea"/><path d="M4.1 17.5 C 7.8 14.9, 11 14.9, 14.5 17.5 S 21.4 20.1, 25 17.5 C 26 16.8, 27 16.7, 27.9 17.5 A12 12 0 0 1 4.1 17.5 Z" fill="#2f7fc1"/></svg>`;

const MAX_VISIBLE = 4;
const SHOW_MS = 9000;

function stack() {
  return document.getElementById('notice-stack');
}

function dismiss(el) {
  el.classList.remove('show');
  setTimeout(() => el.remove(), 250);
}

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
