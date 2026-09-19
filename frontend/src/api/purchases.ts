/**
 * Proveedores, recepciones, cuentas por pagar y pagos
 * (`features/fase-2-costo-inventario/spec.md § Alcance de 2b § API contract
 * — 2b`, dominio `app.purchases` del backend — tipado contra
 * `backend/app/purchases/schemas.py` y `router.py`, ya escritos cuando este
 * archivo se creó por `backend-compras`).
 *
 * Mismas convenciones que `api/inventory.ts` (que este archivo no toca: es
 * territorio ajeno, sólo se lee `IngredientOut`/`listIngredients` desde las
 * pantallas de este dominio para el selector de insumo de una línea de
 * recepción): las cantidades de insumo (`qty_received`/`qty_invoiced`) y el
 * precio unitario de compra viajan como `string` decimal — nunca un número
 * JSON. `tax_base`/`tax_rate`/`tax_amount`/`amount`/`balance` de una cuenta
 * por pagar y `amount` de un pago SÍ son pesos enteros (`int`), como el
 * resto del dinero del proyecto (nunca fracción de peso).
 *
 * Este archivo no deriva nada: el saldo de una cuenta por pagar, la
 * confiabilidad de un proveedor y el costo final de una línea (con o sin
 * IVA bajo INC) llegan ya calculados — "una sola matemática, en el
 * backend" (AGENTS.md).
 */

import { api } from "@/api/client"

export type SupplierPaymentMethod = "cash" | "card" | "transfer" | "other"
export type ReceptionStatus = "confirmed" | "reversed"
export type PayableStatus = "pending_review" | "approved" | "cancelled"

// ---------------------------------------------------------------------------
// Proveedores.
// ---------------------------------------------------------------------------

export interface SupplierIn {
  name: string
  nit?: string | null
  payment_term_days: number
  contact_name?: string | null
  contact_phone?: string | null
  invoices_required: boolean
  active: boolean
}

export interface SupplierUpdateIn {
  name?: string
  nit?: string | null
  payment_term_days?: number
  contact_name?: string | null
  contact_phone?: string | null
  invoices_required?: boolean
  active?: boolean
}

export interface SupplierOut {
  id: number
  store_id: number
  name: string
  nit: string | null
  payment_term_days: number
  contact_name: string | null
  contact_phone: string | null
  invoices_required: boolean
  active: boolean
}

/** `null` en cualquier campo cuando no hay recepciones en el rango — "sin
 * datos", nunca `0` (AGENTS.md § "null no es 0"). Los tres porcentajes ya
 * vienen resueltos como enteros (puntos porcentuales), no se recalculan acá. */
export interface SupplierReliabilityOut {
  supplier_id: number
  date_from: string
  date_to: string
  receptions: number
  received_over_invoiced_pct: number | null
  invoice_share_pct: number | null
  avg_price_drift_pct: number | null
}

export function listSuppliers(storeId: number, params: { active?: boolean } = {}): Promise<SupplierOut[]> {
  return api<SupplierOut[]>("/admin/suppliers", { query: { store_id: storeId, active: params.active } })
}

export function createSupplier(storeId: number, data: SupplierIn): Promise<SupplierOut> {
  return api<SupplierOut>("/admin/suppliers", { method: "POST", query: { store_id: storeId }, body: data })
}

export function updateSupplier(supplierId: number, data: SupplierUpdateIn): Promise<SupplierOut> {
  return api<SupplierOut>(`/admin/suppliers/${supplierId}`, { method: "PATCH", body: data })
}

/** Baja lógica (`DELETE` = `active: false` en el servidor), nunca un borrado de fila. */
export function deactivateSupplier(supplierId: number): Promise<SupplierOut> {
  return api<SupplierOut>(`/admin/suppliers/${supplierId}`, { method: "DELETE" })
}

export function getSupplierReliability(
  supplierId: number,
  params: { from: string; to: string },
): Promise<SupplierReliabilityOut> {
  return api<SupplierReliabilityOut>(`/admin/suppliers/${supplierId}/reliability`, {
    query: { from: params.from, to: params.to },
  })
}

// ---------------------------------------------------------------------------
// Recepciones.
// ---------------------------------------------------------------------------

export interface ReceptionLineIn {
  ingredient_id: number
  /** Texto decimal en la unidad base del insumo (nunca número JSON). */
  qty_received: string
  qty_invoiced: string
  /** Precio por UNA unidad de COMPRA (no por unidad base) — texto decimal en pesos. */
  purchase_unit_price: string
  tax_base: number
  tax_rate: number
  tax_amount: number
  lot_code?: string | null
  /** "YYYY-MM-DD" o `null`/omitido si el insumo no vence. */
  expires_at?: string | null
}

export interface ReceptionIn {
  supplier_id: number
  invoice_number?: string | null
  invoice_date: string
  no_invoice: boolean
  photo?: string | null
  received_by_pin: string
  /** Limpia las DOS guardas de tecleo a la vez, de forma EXPLÍCITA — nunca
   * se manda `true` de entrada: sólo tras mostrar la pregunta al operador
   * (ver `ReceptionForm.tsx`). */
  confirm_price: boolean
  lines: ReceptionLineIn[]
}

export interface ReceptionLineOut {
  id: number
  ingredient_id: number
  qty_received: string
  qty_invoiced: string
  purchase_unit_price: string
  /** Costo por unidad base, PRE-impuesto. */
  unit_cost: string
  /** El que de verdad viaja al lote y al movimiento — con el IVA sumado bajo INC (§4.1). */
  final_unit_cost: string
  tax_base: number
  tax_rate: number
  tax_amount: number
  lot_code: string | null
  expires_at: string | null
  stock_batch_id: number | null
  stock_movement_id: number | null
}

export interface ReceptionOut {
  id: number
  store_id: number
  supplier_id: number
  invoice_number: string | null
  invoice_date: string
  no_invoice: boolean
  photo: string | null
  received_by_employee_id: number
  received_by_employee_name: string
  status: ReceptionStatus
  price_confirmed: boolean
  price_confirmed_by_employee_name: string | null
  at: string
  business_date: string
  reversed_at: string | null
  reversed_by_employee_name: string | null
  payable_id: number | null
  lines: ReceptionLineOut[]
}

export interface ReceptionReverseIn {
  authorizer_pin: string
}

/** `POST /receptions` — SIN el prefijo `/admin` (así lo fija el contrato,
 * literal), pero es pantalla de administrador igual: lleva precios
 * unitarios y el PIN de quien recibe es atribución, no una sesión de
 * dispositivo (invariante heredado #2, `spec.md`). */
export function createReception(
  storeId: number,
  data: ReceptionIn,
  idempotencyKey: string,
): Promise<ReceptionOut> {
  return api<ReceptionOut>("/receptions", { method: "POST", query: { store_id: storeId }, body: data, idempotencyKey })
}

export interface ReceptionsQuery {
  storeId: number
  from?: string
  to?: string
  supplierId?: number | null
  status?: ReceptionStatus
}

export function listReceptions(params: ReceptionsQuery): Promise<ReceptionOut[]> {
  return api<ReceptionOut[]>("/admin/receptions", {
    query: {
      store_id: params.storeId,
      from: params.from,
      to: params.to,
      supplier_id: params.supplierId,
      status: params.status,
    },
  })
}

export function receptionsCsvUrl(params: ReceptionsQuery): string {
  const query = new URLSearchParams()
  query.set("format", "csv")
  query.set("store_id", String(params.storeId))
  if (params.from) query.set("from", params.from)
  if (params.to) query.set("to", params.to)
  if (params.supplierId !== undefined && params.supplierId !== null) query.set("supplier_id", String(params.supplierId))
  if (params.status) query.set("status", params.status)
  return `/api/v1/admin/receptions?${query.toString()}`
}

export function getReception(receptionId: number): Promise<ReceptionOut> {
  return api<ReceptionOut>(`/admin/receptions/${receptionId}`)
}

/** Reversa atómica de TODO lo que la recepción encadenó (movimientos, lote,
 * cuenta por pagar) o falla nombrando el motivo exacto — nunca un `DELETE`
 * de fila (AGENTS.md § "nada financiero se borra"). El backend expone el
 * mismo efecto por `PATCH` y por `DELETE`; este cliente usa `DELETE`
 * porque es la acción que la pantalla ofrece como "Eliminar recepción". */
export function reverseReception(receptionId: number, data: ReceptionReverseIn): Promise<ReceptionOut> {
  return api<ReceptionOut>(`/admin/receptions/${receptionId}`, { method: "DELETE", body: data })
}

// ---------------------------------------------------------------------------
// Cuentas por pagar y pagos.
// ---------------------------------------------------------------------------

export interface PayableOut {
  id: number
  store_id: number
  supplier_id: number
  reception_id: number
  /** Snapshot del total original de la recepción — nunca cambia. */
  amount: number
  /** SIEMPRE derivado de los pagos vivos en el servidor; este cliente nunca lo recalcula. */
  balance: number
  status: PayableStatus
  due_date: string
  overdue: boolean
  approved_at: string | null
  approved_by_employee_name: string | null
  business_date: string
}

export interface PayableApproveIn {
  authorizer_pin: string
}

export interface PaymentIn {
  amount: number
  method: SupplierPaymentMethod
  /** "YYYY-MM-DDTHH:mm" (datetime-local) — fecha REAL de salida, puede ser distinta de "ahora". */
  paid_at: string
  reference?: string | null
  from_cash_drawer: boolean
  authorizer_pin: string
}

export interface PaymentOut {
  id: number
  payable_id: number
  amount: number
  method: SupplierPaymentMethod
  paid_at: string
  reference: string | null
  from_cash_drawer: boolean
  cash_movement_id: number | null
  employee_name: string
  authorized_by_employee_name: string
  created_at: string
  voided_at: string | null
  voided_reason: string | null
  /** Quién anuló. Anular un pago a proveedor devuelve plata al cajón, y eso
   * tiene responsable: sin este campo el historial dice que se anuló y no
   * dice quién. */
  voided_by_employee_name: string | null
}

export interface PaymentVoidIn {
  reason: string
  authorizer_pin: string
}

export interface PayablesQuery {
  storeId: number
  status?: PayableStatus
  supplierId?: number | null
  overdue?: boolean
  from?: string
  to?: string
}

export function listPayables(params: PayablesQuery): Promise<PayableOut[]> {
  return api<PayableOut[]>("/admin/payables", {
    query: {
      store_id: params.storeId,
      status: params.status,
      supplier_id: params.supplierId,
      overdue: params.overdue,
      from: params.from,
      to: params.to,
    },
  })
}

export function payablesCsvUrl(params: PayablesQuery): string {
  const query = new URLSearchParams()
  query.set("format", "csv")
  query.set("store_id", String(params.storeId))
  if (params.status) query.set("status", params.status)
  if (params.supplierId !== undefined && params.supplierId !== null) query.set("supplier_id", String(params.supplierId))
  if (params.overdue) query.set("overdue", "true")
  if (params.from) query.set("from", params.from)
  if (params.to) query.set("to", params.to)
  return `/api/v1/admin/payables?${query.toString()}`
}

export function approvePayable(payableId: number, data: PayableApproveIn): Promise<PayableOut> {
  return api<PayableOut>(`/admin/payables/${payableId}/approve`, { method: "POST", body: data })
}

/** El historial de pagos de una cuenta por pagar, del más viejo al más nuevo.
 *
 * Los anulados vienen INCLUIDOS y marcados: son parte del historial, y
 * esconderlos dejaría al administrador viendo dos pagos contra un saldo
 * calculado sobre otra cosa. El saldo lo sigue derivando el servidor de los
 * pagos vivos (`PayableOut.balance`) y este cliente nunca lo recalcula. */
export function listPayablePayments(payableId: number, params: { includeVoided?: boolean } = {}): Promise<PaymentOut[]> {
  return api<PaymentOut[]>(`/admin/payables/${payableId}/payments`, {
    query: { include_voided: params.includeVoided },
  })
}

export function payablePaymentsCsvUrl(payableId: number): string {
  return `/api/v1/admin/payables/${payableId}/payments?format=csv`
}

export function createPayment(payableId: number, data: PaymentIn, idempotencyKey: string): Promise<PaymentOut> {
  return api<PaymentOut>(`/admin/payables/${payableId}/payments`, { method: "POST", body: data, idempotencyKey })
}

/** Anulación con motivo — nunca un borrado (AGENTS.md). */
export function voidPayment(payableId: number, paymentId: number, data: PaymentVoidIn): Promise<PaymentOut> {
  return api<PaymentOut>(`/admin/payables/${payableId}/payments/${paymentId}/void`, { method: "POST", body: data })
}
