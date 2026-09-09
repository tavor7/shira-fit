// Web Push service worker. Deliberately minimal: this app has no other need for a
// service worker (no offline caching), so its only job is receiving pushes and handling
// taps on the resulting notification.

// A new SW version normally sits "waiting" until every open tab/instance of the app is
// closed before it takes over — on an installed iOS Home Screen app there's usually only
// ever one instance, but it can otherwise sit suspended in memory indefinitely. Skipping
// the wait and claiming clients immediately means the next time this file happens to be
// re-fetched (a full close + reopen, not just backgrounding), the update applies right away
// instead of silently waiting for an instance count that may never reach zero.
self.addEventListener("install", () => {
  self.skipWaiting();
});
self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
  let payload = { title: "Shira Fit", body: "" };
  try {
    if (event.data) payload = { ...payload, ...event.data.json() };
  } catch {
    if (event.data) payload.body = event.data.text();
  }

  const data = payload.data || {};
  event.waitUntil(
    self.registration.showNotification(payload.title || "Shira Fit", {
      body: payload.body || "",
      icon: "/icon-192.png",
      badge: "/icon-192.png",
      // Without a unique tag, iOS treats every push from this origin as "the same"
      // notification and only surfaces the latest one, silently swallowing earlier ones
      // that arrive close together (e.g. several manager test presses in a row).
      // renotify forces a fresh alert even when a tag happens to repeat.
      tag: (data && data.tag) || `shirafit-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      renotify: true,
      data,
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const sessionId = event.notification.data?.session_id;
  const targetUrl = sessionId ? `/?session_id=${sessionId}` : "/";

  event.waitUntil(
    (async () => {
      const clientsList = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const client of clientsList) {
        if ("focus" in client) return client.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow(targetUrl);
    })()
  );
});
