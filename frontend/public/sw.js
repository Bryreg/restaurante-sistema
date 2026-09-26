/*
 * Service worker de los avisos al celular (función `notifications.push`).
 *
 * Lo registra SOLO la tarjeta «Avisos al celular» del admin, cuando el
 * administrador los activa en ese teléfono. No cachea nada ni intercepta
 * pedidos (no hay `fetch`): la aplicación sigue yendo siempre al servidor.
 * Hace dos cosas:
 *
 * - `push`: muestra el aviso que mandó el servidor ({title, body, url, tag}).
 * - `notificationclick`: abre la pantalla del aviso, o enfoca una ventana
 *   del admin que ya esté abierta y la lleva ahí.
 */

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

function sameOriginPath(url) {
  try {
    const target = new URL(url || "/admin/hoy", self.location.origin);
    if (target.origin !== self.location.origin) return "/admin/hoy";
    return target.pathname + target.search + target.hash;
  } catch {
    return "/admin/hoy";
  }
}

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data ? event.data.text() : "" };
  }
  const title = data.title || "Restaurante";
  const options = {
    body: data.body || "",
    tag: data.tag || undefined,
    renotify: Boolean(data.tag),
    icon: "/icons/icon-192.png",
    badge: "/icons/icon-192.png",
    lang: "es-CO",
    data: { url: sameOriginPath(data.url) },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const path = (event.notification.data && event.notification.data.url) || "/admin/hoy";
  const target = new URL(path, self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((windows) => {
      for (const client of windows) {
        if (new URL(client.url).pathname.startsWith("/admin") && "focus" in client) {
          return client.focus().then((focused) => ("navigate" in focused ? focused.navigate(target) : focused));
        }
      }
      return self.clients.openWindow(target);
    }),
  );
});
