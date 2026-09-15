/**
 * Documento fiscal de verdad (pedido 1b-2): rangos de numeración DIAN,
 * estados ante la DIAN, evidencia y exportación, notas (ajuste/crédito/
 * débito) y devoluciones pendientes. `features/fase-1b-venta/spec.md` §
 * "API contract → Payments & fiscal document"; tipado campo por campo
 * contra `backend/app/fiscal/{router,schemas,service}.py` y
 * `backend/app/refunds/{router,schemas}.py` (reales, no en construcción al
 * escribir esto — ver `features/fase-1b-venta/outputs-1b-2/backend-fiscal.md`
 * y `backend-clientes-dinero.md`).
 *
 * Todo campo de una respuesta es opcional o `| null` (AGENTS.md § frontend):
 * un backend que todavía no lo manda no puede romper una pantalla. Ningún
 * campo de acá es plata que este archivo calcule — todo se pinta tal cual
 * llega (AGENTS.md, "una sola matemática, en el backend").
 *
 * GAP declarado (ver entregable): `POST /admin/fiscal/ranges` no pasa por
 * `run_idempotent` en el backend (a diferencia de `retry`/`notes`/`settle`,
 * que sí lo hacen) — mandamos `Idempotency-Key` de todos modos por
 * consistencia con el resto de escrituras administrativas, pero el
 * servidor todavía no la usa para esa ruta puntual.
 */
import { api } from "@/api/client";

// ---------------------------------------------------------------------------
// Enums compartidos (mismos valores que `app/fiscal/models.py`).
// ---------------------------------------------------------------------------

export type FiscalDocumentType =
  | "pos_equivalent"
  | "invoice"
  | "adjustment_note"
  | "credit_note"
  | "debit_note"
  | "internal_receipt";

export type DianStatus = "pending" | "sent" | "validated" | "rejected" | "contingency";

/** Tipos que reservan número dentro de un `FiscalRange` (todo salvo el comprobante interno). */
export const RANGE_BACKED_DOCUMENT_TYPES: FiscalDocumentType[] = [
  "pos_equivalent",
  "invoice",
  "adjustment_note",
  "credit_note",
  "debit_note",
];

export const DOCUMENT_TYPE_LABEL: Record<FiscalDocumentType, string> = {
  pos_equivalent: "Documento equivalente POS",
  invoice: "Factura electrónica",
  adjustment_note: "Nota de ajuste",
  credit_note: "Nota crédito",
  debit_note: "Nota débito",
  internal_receipt: "Comprobante interno",
};

/** Texto SIEMPRE acompaña al color (nunca sólo color, checklist del pedido). */
export const DIAN_STATUS_LABEL: Record<DianStatus, string> = {
  pending: "Pendiente de transmisión",
  sent: "Enviado a la DIAN",
  validated: "Validado",
  rejected: "Rechazado",
  contingency: "Contingencia",
};

// ---------------------------------------------------------------------------
// Rangos de numeración (`GET/POST /admin/fiscal/ranges`)
// ---------------------------------------------------------------------------

export interface FiscalRangeIn {
  store_id: number;
  document_type: FiscalDocumentType;
  prefix: string;
  from_number: number;
  to_number: number;
  resolution_number: string;
  /** "YYYY-MM-DD". */
  resolution_date: string;
  valid_from: string;
  valid_until: string;
  technical_key?: string | null;
}

export interface FiscalRangeOut {
  id: number;
  store_id?: number;
  document_type?: FiscalDocumentType;
  prefix?: string;
  from_number?: number;
  to_number?: number;
  resolution_number?: string;
  resolution_date?: string;
  valid_from?: string;
  valid_until?: string;
  technical_key?: string | null;
  /** Consecutivos ya emitidos dentro del rango (no plata: un contador de documentos). */
  consumed?: number;
}

export function listFiscalRanges(storeId: number): Promise<FiscalRangeOut[]> {
  return api<FiscalRangeOut[]>("/admin/fiscal/ranges", { query: { store_id: storeId } });
}

export function createFiscalRange(body: FiscalRangeIn, idempotencyKey?: string): Promise<FiscalRangeOut> {
  return api<FiscalRangeOut>("/admin/fiscal/ranges", { method: "POST", body, idempotencyKey });
}

export function fiscalRangesCsvUrl(storeId: number): string {
  const query = new URLSearchParams();
  query.set("format", "csv");
  query.set("store_id", String(storeId));
  return `/api/v1/admin/fiscal/ranges?${query.toString()}`;
}

// ---------------------------------------------------------------------------
// Estados ante la DIAN (`GET /admin/fiscal/documents`, `retry`, `evidence`, `export`)
// ---------------------------------------------------------------------------

export interface AdminFiscalDocumentOut {
  id: number;
  full_number?: string;
  document_type?: FiscalDocumentType;
  dian_status?: DianStatus | null;
  contingency?: boolean;
  contingency_overdue?: boolean;
  business_date?: string;
  issued_at?: string;
  order_id?: number;
  total?: number;
  tip_amount?: number;
  charged_by?: string;
  customer_name?: string;
  reverses_document_id?: number | null;
}

/**
 * El servidor sólo filtra por `status` en esta ruta (no por `document_type`
 * — `GET /admin/fiscal/documents` no acepta ese query param, a diferencia
 * del contrato de `spec.md` que pide "listado ... por estado y tipo"; ver
 * `backend/app/fiscal/router.py::get_fiscal_documents`). El filtro por tipo
 * de esta pantalla se aplica sobre las filas ya traídas (declarado en el
 * entregable, no es un endpoint inventado).
 */
export function listFiscalDocuments(params: { storeId: number; status?: DianStatus }): Promise<AdminFiscalDocumentOut[]> {
  return api<AdminFiscalDocumentOut[]>("/admin/fiscal/documents", {
    query: { store_id: params.storeId, status: params.status },
  });
}

export function fiscalDocumentsCsvUrl(params: { storeId: number; status?: DianStatus }): string {
  const query = new URLSearchParams();
  query.set("format", "csv");
  query.set("store_id", String(params.storeId));
  if (params.status) query.set("status", params.status);
  return `/api/v1/admin/fiscal/documents?${query.toString()}`;
}

export interface RetryDocumentOut {
  id: number;
  full_number?: string;
  dian_status?: DianStatus | null;
  legend?: string;
  cude?: string | null;
  qr_url?: string | null;
  contingency?: boolean;
}

export function retryFiscalDocument(documentId: number, idempotencyKey: string): Promise<RetryDocumentOut> {
  return api<RetryDocumentOut>(`/admin/fiscal/documents/${documentId}/retry`, {
    method: "POST",
    idempotencyKey,
  });
}

export interface FiscalRangeRefOut {
  id: number;
  prefix?: string;
  from_number?: number;
  to_number?: number;
  resolution_number?: string;
  valid_until?: string;
}

export interface DocumentEvidenceOut {
  id: number;
  full_number?: string;
  document_type?: FiscalDocumentType;
  dian_status?: DianStatus | null;
  cude?: string | null;
  qr_url?: string | null;
  xml_ref?: string | null;
  provider_response?: Record<string, unknown> | null;
  validated_at?: string | null;
  issued_at?: string;
  content_hash?: string;
  range?: FiscalRangeRefOut | null;
}

export function getFiscalDocumentEvidence(documentId: number): Promise<DocumentEvidenceOut> {
  return api<DocumentEvidenceOut>(`/admin/fiscal/documents/${documentId}/evidence`);
}

export interface ExportManifestEntry {
  id: number;
  full_number?: string;
  document_type?: FiscalDocumentType;
  business_date?: string;
  total?: number;
  hash?: string;
}

export interface ExportBundleOut {
  generated_at?: string;
  store_id?: number;
  date_from?: string;
  date_to?: string;
  document_count?: number;
  documents?: ExportManifestEntry[];
  manifest_hash?: string;
}

export function getFiscalExportBundle(params: { storeId: number; from: string; to: string }): Promise<ExportBundleOut> {
  return api<ExportBundleOut>("/admin/fiscal/export", {
    query: { store_id: params.storeId, from: params.from, to: params.to },
  });
}

/** No arma un ZIP (no hay proveedor real todavía): el manifiesto JSON en sí es la evidencia. */
export function fiscalExportUrl(params: { storeId: number; from: string; to: string }): string {
  const query = new URLSearchParams();
  query.set("store_id", String(params.storeId));
  query.set("from", params.from);
  query.set("to", params.to);
  return `/api/v1/admin/fiscal/export?${query.toString()}`;
}

// ---------------------------------------------------------------------------
// Notas (`POST /admin/documents/{id}/notes`, `GET /admin/notes`)
// ---------------------------------------------------------------------------

export type NoteKind = "adjustment" | "credit" | "debit";

export interface NoteLineIn {
  item_id: number;
  used: boolean;
}

export interface RefundIn {
  method: string;
  amount: number;
}

export interface NoteCreateIn {
  kind: NoteKind;
  reason: string;
  lines: NoteLineIn[];
  refund?: RefundIn;
}

export interface NoteLineOut {
  item_id?: number;
  qty?: number;
  description?: string;
  unit_price?: number;
  gross?: number;
  discount?: number;
  net?: number;
  tax_rate?: number;
  base?: number;
  tax?: number;
  courtesy?: boolean;
}

export interface NoteOut {
  id: number;
  document_type?: FiscalDocumentType;
  prefix?: string;
  number?: number;
  full_number?: string;
  reverses_document_id?: number;
  reason?: string;
  lines?: NoteLineOut[];
  subtotal?: number;
  discount_total?: number;
  tax_total?: number;
  total?: number;
  dian_status?: DianStatus | null;
  legend?: string;
  business_date?: string;
  issued_at?: string;
  /** `RefundOutcome.status`: "settled_in_shift" | "pending" | "settled_externally"; `null` sin `refund`. */
  refund_status?: string | null;
}

export function createNote(documentId: number, body: NoteCreateIn, idempotencyKey: string): Promise<NoteOut> {
  return api<NoteOut>(`/admin/documents/${documentId}/notes`, { method: "POST", body, idempotencyKey });
}

export interface AdminNoteListItem {
  id: number;
  full_number?: string;
  document_type?: FiscalDocumentType;
  reverses_document_id?: number;
  reason?: string;
  total?: number;
  business_date?: string;
  issued_at?: string;
}

export function listNotes(params: { storeId: number; from?: string; to?: string }): Promise<AdminNoteListItem[]> {
  return api<AdminNoteListItem[]>("/admin/notes", {
    query: { store_id: params.storeId, from: params.from, to: params.to },
  });
}

export function notesCsvUrl(params: { storeId: number; from?: string; to?: string }): string {
  const query = new URLSearchParams();
  query.set("format", "csv");
  query.set("store_id", String(params.storeId));
  if (params.from) query.set("from", params.from);
  if (params.to) query.set("to", params.to);
  return `/api/v1/admin/notes?${query.toString()}`;
}

// ---------------------------------------------------------------------------
// Devoluciones pendientes (`app/refunds`, nacen de una nota con `refund`
// en efectivo sin turno abierto — SPEC-NEGOCIO §6.3). No tienen archivo de
// API propio en el territorio de este agente: viven acá porque nacen de
// una nota y comparten pantalla con "Notas" en el admin de fiscal.
// ---------------------------------------------------------------------------

export type PendingRefundStatus = "pending" | "settled";
export type SettleFrom = "shift" | "owner";

export interface PendingRefundOut {
  id: number;
  store_id?: number;
  document_id?: number;
  customer_id?: number | null;
  customer_name?: string;
  customer_doc_number?: string;
  amount?: number;
  method?: string;
  authorized_by_employee_id?: number;
  authorized_by_employee_name?: string;
  requested_at?: string;
  status?: PendingRefundStatus;
  settled_at?: string | null;
  settled_from?: SettleFrom | null;
  settled_shift_id?: number | null;
  settled_cash_movement_id?: number | null;
  settled_by_employee_id?: number | null;
  settled_by_employee_name?: string | null;
}

export function listPendingRefunds(params: {
  storeId: number;
  status?: PendingRefundStatus;
}): Promise<PendingRefundOut[]> {
  return api<PendingRefundOut[]>("/admin/pending-refunds", {
    query: { store_id: params.storeId, status: params.status },
  });
}

export function pendingRefundsCsvUrl(params: { storeId: number; status?: PendingRefundStatus }): string {
  const query = new URLSearchParams();
  query.set("format", "csv");
  query.set("store_id", String(params.storeId));
  if (params.status) query.set("status", params.status);
  return `/api/v1/admin/pending-refunds?${query.toString()}`;
}

/** `{from: "shift"|"owner", shift_id?}` — clave `from` literal (alias de Pydantic en el backend). */
export interface SettlePendingRefundIn {
  from: SettleFrom;
  shift_id?: number;
}

export function settlePendingRefund(
  pendingRefundId: number,
  body: SettlePendingRefundIn,
  idempotencyKey: string,
): Promise<PendingRefundOut> {
  return api<PendingRefundOut>(`/admin/pending-refunds/${pendingRefundId}/settle`, {
    method: "POST",
    body,
    idempotencyKey,
  });
}
