// Web Push service worker. Deliberately minimal: this app has no other need for a
// service worker (no offline caching), so its only job is receiving pushes and handling
// taps on the resulting notification.

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
