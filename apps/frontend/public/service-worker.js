const CACHE_NAME = 'kinetra-shell-v4';
const APP_SHELL = [
  '/',
  '/offline.html',
  '/theme-init.js',
  '/manifest.webmanifest',
  '/favicon.svg',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-maskable-512.png',
];
const PUSH_NOTIFICATION_TYPES = new Set(['workout_reminder', 'weekly_survey_reminder']);
const PUSH_DEEP_LINKS = new Set(['/schedule', '/progress']);
const DEFAULT_NOTIFICATION = Object.freeze({
  type: 'generic',
  title: 'Kinetra',
  body: 'Откройте приложение, чтобы продолжить.',
  url: '/',
});

const notificationDefaultsForType = (type) => {
  if (type === 'workout_reminder') {
    return {
      type,
      title: 'Время для тренировки',
      body: 'Откройте расписание Kinetra.',
      url: '/schedule',
    };
  }

  if (type === 'weekly_survey_reminder') {
    return {
      type,
      title: 'Как прошла ваша неделя?',
      body: 'Заполните короткую самооценку в Kinetra.',
      url: '/progress',
    };
  }

  return DEFAULT_NOTIFICATION;
};

const boundedText = (value, fallback, maximumLength) => {
  if (typeof value !== 'string') {
    return fallback;
  }

  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= maximumLength ? normalized : fallback;
};

const safeDeepLink = (value, fallback = '/') => {
  const rootUrl = new URL('/', self.location.origin).href;
  const fallbackUrl = new URL(fallback, self.location.origin).href;

  if (typeof value === 'undefined' || value === null || value === '') {
    return fallbackUrl;
  }

  if (
    typeof value !== 'string' ||
    value.trimStart().startsWith('//') ||
    !PUSH_DEEP_LINKS.has(fallback)
  ) {
    return rootUrl;
  }

  try {
    const candidate = new URL(value, self.location.origin);

    if (candidate.origin !== self.location.origin || candidate.pathname !== fallback) {
      return rootUrl;
    }

    return fallbackUrl;
  } catch {
    return rootUrl;
  }
};

const readPushNotification = (data) => {
  let payload = null;

  try {
    payload = data?.json() ?? null;
  } catch {
    payload = null;
  }

  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return DEFAULT_NOTIFICATION;
  }

  const type = PUSH_NOTIFICATION_TYPES.has(payload.type) ? payload.type : 'generic';
  const defaults = notificationDefaultsForType(type);

  return {
    type,
    title: boundedText(payload.title, defaults.title, 80),
    body: boundedText(payload.body, defaults.body, 180),
    url: safeDeepLink(payload.url, defaults.url),
  };
};

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((cacheNames) =>
        Promise.all(
          cacheNames
            .filter((cacheName) => cacheName !== CACHE_NAME)
            .map((cacheName) => caches.delete(cacheName)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;

  if (request.method !== 'GET') {
    return;
  }

  const url = new URL(request.url);

  if (url.origin !== self.location.origin) {
    return;
  }

  if (url.pathname.startsWith('/api/') || url.pathname === '/health') {
    return;
  }

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) {
            const responseCopy = response.clone();
            void caches.open(CACHE_NAME).then((cache) => cache.put(request, responseCopy));
          }

          return response;
        })
        .catch(async () =>
          (await caches.match('/offline.html')) ??
          (await caches.match(request)) ??
          (await caches.match('/')) ??
          Response.error(),
        ),
    );
    return;
  }

  event.respondWith(
    caches.match(request).then(async (cachedResponse) => {
      if (cachedResponse) {
        return cachedResponse;
      }

      const networkResponse = await fetch(request);

      if (networkResponse.ok) {
        const responseCopy = networkResponse.clone();
        void caches.open(CACHE_NAME).then((cache) => cache.put(request, responseCopy));
      }

      return networkResponse;
    }),
  );
});

self.addEventListener('push', (event) => {
  const notification = readPushNotification(event.data);

  event.waitUntil(
    self.registration.showNotification(notification.title, {
      body: notification.body,
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      data: {
        type: notification.type,
        url: notification.url,
      },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  const type = PUSH_NOTIFICATION_TYPES.has(event.notification.data?.type)
    ? event.notification.data.type
    : 'generic';
  const fallback = notificationDefaultsForType(type).url;
  const targetUrl = safeDeepLink(event.notification.data?.url, fallback);

  event.waitUntil(
    self.clients
      .matchAll({ type: 'window', includeUncontrolled: true })
      .then(async (windowClients) => {
        for (const client of windowClients) {
          try {
            const clientUrl = new URL(client.url);

            if (clientUrl.origin !== self.location.origin) {
              continue;
            }

            if (clientUrl.href === targetUrl) {
              await client.focus();
              return;
            }

            const navigatedClient = await client.navigate(targetUrl);

            if (navigatedClient !== null) {
              await navigatedClient.focus();
              return;
            }
          } catch {
            // Try another window or open a new same-origin one below.
          }
        }

        await self.clients.openWindow(targetUrl);
      }),
  );
});
