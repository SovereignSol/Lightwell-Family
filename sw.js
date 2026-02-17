self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = { title: "Family Hub", body: "Update", url: "./" };
  }

  const title = payload.title || "Family Hub";
  const options = {
    body: payload.body || "Update",
    icon: payload.icon || "./pwa-192.png",
    badge: payload.badge || "./pwa-192.png",
    data: { url: payload.url || "./" }
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = event.notification?.data?.url || "./";

  event.waitUntil(
    (async () => {
      const clientsArr = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const client of clientsArr) {
        if ("focus" in client) return client.focus();
      }
      return self.clients.openWindow(url);
    })()
  );
});
