/**
 * Asistencia del día, separada del turno de caja (`app/shifts/attendance_router.py`).
 * El primer PIN del día marca la entrada (lo hace `POST /auth/device/identify`);
 * acá están «Marcar salida» y lo que el administrador revisa y corrige.
 */
import { api } from "./client";

/** `open` (hoy, sin salida) · `closed` · `review` (salida olvidada de un día que ya pasó). */
export type AttendanceStatus = "open" | "closed" | "review";

export interface AttendanceEntryOut {
  id: number;
  employee_id: number;
  employee_name: string;
  business_date: string;
  puesto?: string | null;
  in_at: string;
  out_at?: string | null;
  status: AttendanceStatus;
  out_source?: string | null;
  out_by_employee_name?: string | null;
  out_reason?: string | null;
}

export interface AttendanceOutIn {
  /** Sin `employee_id`: la persona identificada marca su propia salida. */
  employee_id?: number;
  /** Con PIN: desde «Quién opera», sin identificarse antes. */
  pin?: string;
}

/** «Marcar salida»: la propia (un toque), con el PIN propio, o la de otro si es supervisor. */
export function markAttendanceExit(body: AttendanceOutIn = {}): Promise<AttendanceEntryOut> {
  return api<AttendanceEntryOut>("/attendance/out", { method: "POST", body });
}

export function getAttendanceToday(): Promise<AttendanceEntryOut[]> {
  return api<AttendanceEntryOut[]>("/attendance/today");
}

export interface AdminAttendanceOut {
  entries: AttendanceEntryOut[];
  /** Salidas olvidadas de la sede, aunque caigan fuera del rango pedido. */
  pending_review: number;
}

export function getAdminAttendance(params: { storeId: number; from?: string; to?: string }): Promise<AdminAttendanceOut> {
  return api<AdminAttendanceOut>("/admin/attendance", {
    query: { store_id: params.storeId, from: params.from, to: params.to },
  });
}

export interface AttendanceFixIn {
  store_id: number;
  /** Hora de pared de Bogotá (`datetime-local`); la zona la pone el servidor. */
  out_at: string;
  reason: string;
}

/** El administrador corrige una salida olvidada, con motivo. Nada se borra. */
export function fixAttendanceExit(entryId: number, body: AttendanceFixIn): Promise<AttendanceEntryOut> {
  return api<AttendanceEntryOut>(`/admin/attendance/${entryId}/exit`, { method: "POST", body });
}
