/**
 * Lo que el navegador tiene que hacer para los avisos al celular: ver si
 * puede, pedir el permiso, registrar el service worker (`/sw.js`, alcance
 * `/`) y suscribirse con la clave pública del servidor.
 *
 * **El service worker se registra sólo acá**, cuando el administrador toca
 * «Activar en este celular»: ninguna otra pantalla lo instala, y la tablet
 * del salón nunca lo tiene.
 *
 * El iPhone (iOS 16.4 o más nuevo) sólo entrega avisos a una app **agregada
 * a la pantalla de inicio** y abierta desde ese ícono: en Safari común
 * `PushManager` no existe. Por eso ese caso es un estado propio
 * (`needs-install`), no «no se puede».
 */

export type PushSupport = "supported" | "needs-install" | "insecure" | "unsupported";

export const SW_URL = "/sw.js";

function isIos(): boolean {
  const ua = navigator.userAgent || "";
  if (/iPhone|iPad|iPod/i.test(ua)) return true;
  // iPadOS se presenta como Mac; lo delata el tacto.
  return /Macintosh/i.test(ua) && (navigator.maxTouchPoints ?? 0) > 1;
}

function isStandalone(): boolean {
  const nav = navigator as Navigator & { standalone?: boolean };
  if (nav.standalone === true) return true;
  return typeof window.matchMedia === "function" && window.matchMedia("(display-mode: standalone)").matches;
}

export function pushSupport(): PushSupport {
  if (typeof window === "undefined" || typeof navigator === "undefined") return "unsupported";
  const hasApis = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
  if (!window.isSecureContext) return "insecure";
  if (!hasApis) return isIos() && !isStandalone() ? "needs-install" : "unsupported";
  return "supported";
}

export function notificationPermission(): NotificationPermission | "unavailable" {
  return typeof window !== "undefined" && "Notification" in window ? Notification.permission : "unavailable";
}

/** La clave pública VAPID (base64url) como la pide `pushManager.subscribe`. */
export function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  const raw = atob(padded.replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  return out;
}

function sameKey(subscription: PushSubscription, key: Uint8Array): boolean {
  const current = subscription.options?.applicationServerKey;
  if (!current) return false;
  const bytes = new Uint8Array(current);
  return bytes.length === key.length && bytes.every((b, i) => b === key[i]);
}

/** La suscripción de ESTE navegador, si ya tiene una. No registra nada. */
export async function currentSubscription(): Promise<PushSubscription | null> {
  if (pushSupport() !== "supported") return null;
  const registration = await navigator.serviceWorker.getRegistration("/");
  if (!registration) return null;
  return registration.pushManager.getSubscription();
}

export class PushPermissionError extends Error {}

/**
 * Pide el permiso (tiene que ser dentro del toque del botón: Safari lo
 * exige), registra el service worker y se suscribe. Devuelve lo que el
 * servidor guarda.
 */
export async function enablePushInThisBrowser(
  publicKey: string,
): Promise<{ endpoint: string; keys: { p256dh: string; auth: string } }> {
  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    throw new PushPermissionError(
      permission === "denied"
        ? "El navegador tiene los avisos bloqueados para este sitio: habilitalos en los ajustes del navegador y volvé a intentar."
        : "No se dio el permiso para mostrar avisos: tocá «Activar en este celular» otra vez y aceptá.",
    );
  }
  const registration = await navigator.serviceWorker.register(SW_URL, { scope: "/" });
  await navigator.serviceWorker.ready;
  const key = urlBase64ToUint8Array(publicKey);
  let subscription = await registration.pushManager.getSubscription();
  if (subscription && !sameKey(subscription, key)) {
    await subscription.unsubscribe();
    subscription = null;
  }
  if (!subscription) {
    subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  }
  const json = subscription.toJSON();
  if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) {
    throw new Error("El navegador no entregó una suscripción completa: probá de nuevo.");
  }
  return { endpoint: json.endpoint, keys: { p256dh: json.keys.p256dh, auth: json.keys.auth } };
}

/** Deja de recibir en ESTE navegador (lo del servidor lo da de baja la API). */
export async function disablePushInThisBrowser(): Promise<void> {
  const subscription = await currentSubscription();
  if (subscription) await subscription.unsubscribe();
}
