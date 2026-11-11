// SwingPulse service worker: shows a banner for each push (pushes carry no payload; the text is fetched).
const CONFIG_URL = './sp-config.json';
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

async function latest() {
  try {
    const cache = await caches.open('sp-config');
    const res = await cache.match(CONFIG_URL);
    const cfg = res ? await res.json() : null;
    if (!cfg || !cfg.api || !cfg.t) return [];
    const r = await fetch(cfg.api, { method: 'POST', body: JSON.stringify({ t: cfg.t, fn: 'latestAlerts', args: [] }), redirect: 'follow' });
    const j = await r.json();
    return j.ok ? j.result : [];
  } catch (e) { return []; }
}

self.addEventListener('push', event => {
  event.waitUntil((async () => {
    const list = await latest();
    const a = list[0];
    const title = a ? `SwingPulse · ${a.ticker}` : 'SwingPulse';
    const lines = a ? a.text.split('\n') : ['יש התראה חדשה בתיק'];
    const body = (a && lines[0].startsWith(a.ticker) ? lines.slice(1) : lines).join('\n') + (list.length > 1 ? `\n+${list.length - 1} התראות נוספות` : '');
    await self.registration.showNotification(title, {
      body, dir: 'rtl', lang: 'he', icon: './icon-192.png', badge: './badge-96.png',
      tag: a ? `sp-${a.ticker}-${a.at}` : 'sp', renotify: true, data: { url: './' }
    });
  })());
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) { if ('focus' in c) { c.postMessage({ type: 'open-alerts' }); return c.focus(); } }
    return self.clients.openWindow('./?tab=alerts');
  })());
});
