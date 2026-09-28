/**
 * Campana del admin: notificaciones y reglas por sede.
 * Spec § "Employees & audit" (notificaciones) y § 9.3 "Notificaciones".
 */
import { api } from "./client";

export type NotificationLevel = "info" | "warning" | "critical";

export interface Notification {
  id: number;
  /** La sede del aviso (la vista del aviso la nombra). */
  store_id?: number | null;
  type: string;
  level: NotificationLevel;
  title: string;
  body: string;
  payload?: Record<string, unknown> | null;
  read_at: string | null;
  created_at: string;
}

export function listNotifications(
  params: { storeId?: number | null; unreadOnly?: boolean } = {},
): Promise<Notification[]> {
  return api<Notification[]>("/admin/notifications", {
    query: { store_id: params.storeId ?? undefined, unread_only: params.unreadOnly ?? undefined },
  });
}

/** `GET /admin/notifications/{id}` — un aviso solo: la vista «Aviso desde la
 * notificación» (`/admin/avisos/:id`), a donde lleva tocar el aviso en el celular. */
export function getNotification(notificationId: number): Promise<Notification> {
  return api<Notification>(`/admin/notifications/${notificationId}`);
}

export function markNotificationRead(notificationId: number): Promise<Notification> {
  return api<Notification>(`/admin/notifications/${notificationId}/read`, { method: "POST" });
}

export interface NotificationRule {
  type: string;
  enabled: boolean;
  threshold: number | null;
  level: NotificationLevel;
}

export function getNotificationRules(storeId: number): Promise<NotificationRule[]> {
  return api<NotificationRule[]>("/admin/notification-rules", { query: { store_id: storeId } });
}

export function setNotificationRules(storeId: number, rules: NotificationRule[]): Promise<NotificationRule[]> {
  return api<NotificationRule[]>("/admin/notification-rules", {
    method: "PUT",
    query: { store_id: storeId },
    body: rules,
  });
}

// ---------------------------------------------------------------------------
// Avisos al celular (Web Push, función `notifications.push`). Cada persona
// maneja SUS celulares; la clave privada nunca viaja.
// ---------------------------------------------------------------------------

export interface PushPublicKey {
  public_key: string;
}

export interface PushDevice {
  id: number;
  /** «iPhone · Safari», armado por el servidor a partir del navegador. */
  label: string;
  endpoint: string;
  created_at: string;
  last_success_at: string | null;
  last_error: string | null;
}

/** La forma de `PushSubscription.toJSON()` que el servidor necesita. */
export interface PushSubscriptionIn {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export interface PushTestResult {
  sent: number;
  failed: number;
  removed: number;
}

export function getPushPublicKey(): Promise<PushPublicKey> {
  return api<PushPublicKey>("/admin/push/public-key");
}

export function listPushDevices(): Promise<PushDevice[]> {
  return api<PushDevice[]>("/admin/push/devices");
}

export function subscribePush(subscription: PushSubscriptionIn): Promise<PushDevice> {
  return api<PushDevice>("/admin/push/subscribe", { method: "POST", body: subscription });
}

export function unsubscribePush(target: { subscription_id: number } | { endpoint: string }): Promise<{ removed: boolean }> {
  return api<{ removed: boolean }>("/admin/push/unsubscribe", { method: "POST", body: target });
}

export function sendPushTest(): Promise<PushTestResult> {
  return api<PushTestResult>("/admin/push/test", { method: "POST" });
}
