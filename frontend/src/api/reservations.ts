/**
 * Reservas de mesa (`/reservations`, `/admin/reservations`).
 *
 * Una reserva **no es una comanda**: no tiene plata, no toca el turno y no
 * entra en ningún cuadre. Por eso en este archivo no hay un solo campo de
 * dinero.
 *
 * Todo campo `Out` es opcional o `| null` (misma convención que
 * `src/api/orders.ts`): el backend puede no mandarlo y un tipo que lo exige
 * no puede romper la pantalla.
 */

import { api } from "@/api/client";

export type ReservationStatus = "booked" | "seated" | "cancelled" | "no_show";

export interface ReservationTableRefOut {
  id?: number;
  number?: string;
  seats?: number;
}

export interface ReservationOut {
  id: number;
  table?: ReservationTableRefOut;
  business_date?: string;
  /** Instante ISO-8601; la pantalla lo escribe en hora de Bogotá. */
  at?: string;
  party_name?: string;
  party_size?: number;
  phone?: string | null;
  note?: string | null;
  status?: ReservationStatus;
  created_at?: string;
  created_by_name?: string | null;
  seated_at?: string | null;
  /** La comanda que se abrió al sentarse: el hilo entre lo apartado y lo consumido. */
  seated_order_id?: number | null;
  closed_at?: string | null;
  closed_reason?: string | null;
  closed_by_name?: string | null;
}

export interface ReservationIn {
  table_id: number;
  /** Instante ISO-8601 con `Z`. */
  at: string;
  party_name: string;
  party_size: number;
  phone?: string | null;
  note?: string | null;
}

export interface ReservationCloseIn {
  status: "cancelled" | "no_show";
  reason?: string | null;
}

/** Las del día operativo indicado; sin fecha, las de hoy. */
export function listReservations(date?: string): Promise<ReservationOut[]> {
  return api<ReservationOut[]>("/reservations", { query: date ? { date } : undefined });
}

export function createReservation(body: ReservationIn, idempotencyKey: string): Promise<ReservationOut> {
  return api<ReservationOut>("/reservations", { method: "POST", body, idempotencyKey });
}

/** Cancelar o marcar que no llegaron. La fila NO se borra. */
export function closeReservation(reservationId: number, body: ReservationCloseIn): Promise<ReservationOut> {
  return api<ReservationOut>(`/reservations/${reservationId}/close`, { method: "POST", body });
}

export function listAdminReservations(storeId: number, date?: string): Promise<ReservationOut[]> {
  return api<ReservationOut[]>("/admin/reservations", {
    query: { store_id: storeId, ...(date ? { date } : {}) },
  });
}
