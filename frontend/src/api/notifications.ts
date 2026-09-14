/**
 * Campana del admin: notificaciones y reglas por sede.
 * Spec § "Employees & audit" (notificaciones) y § 9.3 "Notificaciones".
 */
import { api } from "./client";

export type NotificationLevel = "info" | "warning" | "critical";

export interface Notification {
  id: number;
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
