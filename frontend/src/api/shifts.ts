/**
 * Turno de caja: día operativo → apertura → movimientos, cambio, retiros,
 * relevo/arqueo → cierre a ciegas en tres pasos; y los endpoints de admin
 * para Dinero (operacional + historial + rescates) y Turnos y personal
 * (actividad por persona, autorizaciones por autorizador). Rutas EXACTAS de
 * `features/fase-1a-cimientos/spec.md` § "Business day & shifts" y
 * "Employees & audit" — el contrato vinculante de este pedido.
 *
 * Convención de tipos (CONTRATO-INTERNO.md, AGENTS.md § "todo campo nuevo de
 * respuesta es opcional"): en los tipos de **salida** (`Out`/sin sufijo),
 * todo campo es opcional salvo un `id` propiamente dicho — un backend que
 * todavía no manda un campo, o que lo renombra, nunca puede romper una
 * pantalla que sólo lo muestra. Los tipos de **entrada** (`In`) sí exigen lo
 * que el propio backend exige: son un payload que este código construye, no
 * uno que recibe, así que lo estricto ahí es seguridad de tipos, no un
 * campo ausente en un despliegue desfasado.
 *
 * Ninguna función de este archivo calcula plata: sólo tipan y transportan lo
 * que el servidor decide (AGENTS.md § "una sola matemática en el backend").
 */
import type { Denomination } from "@/components/DenominationsInput";

import { api } from "./client";

export type { Denomination };

// ---------------------------------------------------------------------------
// Enums compartidos (spec § "Business day & shifts", CONTRATO-INTERNO § 6)
// ---------------------------------------------------------------------------

export type RosterAction = "in" | "out" | "pause_start" | "pause_end";
export type CashMovementKind = "income" | "expense";
/**
 * Lista cerrada de causas (`backend/app/shifts/schemas.py:26`), como
 * `const` y no como unión de literales sueltos: así un consumidor puede
 * RECORRERLA (`CASH_MOVEMENT_CAUSES.map(...)`) para, por ejemplo, exigir en
 * un test que exista una etiqueta para cada causa — la próxima causa que
 * el backend agregue rompe ESE test en vez de salir en blanco en pantalla
 * (Ronda 2, H-8: `"supplier_payment"` ya la declaraba el backend y el
 * cliente no se había enterado hasta ahora).
 */
export const CASH_MOVEMENT_CAUSES = [
  "petty_expense",
  "emergency_purchase",
  "refund",
  "tip_payout",
  "supplier_payment",
  "other_income",
  "other_expense",
  // Pedido 2c: el efectivo que entrega el domiciliario al liquidar
  // (`income`), y su espejo al deshacer la liquidación (`expense`). El
  // backend la rechaza con `400 CAUSE_NOT_MANUAL` en
  // `POST /shifts/{id}/cash-movements` (`app/shifts/service.py::
  // _SYSTEM_ONLY_MOVEMENT_CAUSES`): nadie la teclea a mano, sólo la
  // escribe `POST /delivery-settlements`. Sigue en esta lista para que el
  // movimiento tenga ETIQUETA al listarse (`CAUSE_LABEL`, MovementsPanel.tsx)
  // — `MovementsPanel` la excluye aparte del desplegable de causa manual.
  "delivery_settlement",
] as const;
export type CashMovementCause = (typeof CASH_MOVEMENT_CAUSES)[number];
/** Causas que sólo produce el sistema (espejo de `_SYSTEM_ONLY_MOVEMENT_CAUSES`
 * en `app/shifts/service.py`): nunca se ofrecen en un desplegable de causa
 * manual, aunque tengan etiqueta para mostrarse una vez registradas. */
export const SYSTEM_ONLY_MOVEMENT_CAUSES: readonly CashMovementCause[] = ["delivery_settlement"];
export type CashDifferenceCause =
  | "change_error"
  | "expense_without_voucher"
  | "tips_mixed"
  | "unrecorded_sale"
  | "counting_error"
  | "unknown";
export type HandoverKind = "handover" | "spot_check";

// ---------------------------------------------------------------------------
// Dinero y denominaciones (entrada)
// ---------------------------------------------------------------------------

export interface DenominationCount {
  denominations: Denomination[];
  /** Suma tecleada — la calcula `DenominationsInput`, nunca "lo esperado". */
  total: number;
}

/** `{id, name}` tal como lo manda el servidor en toda referencia a persona. */
export interface EmployeeRef {
  id: number;
  name?: string;
}

// ---------------------------------------------------------------------------
// Turno actual y apertura
// ---------------------------------------------------------------------------

export interface RosterEntry {
  employee_id?: number;
  employee_name?: string;
  in_at?: string;
  out_at?: string | null;
}

export interface ShiftCurrent {
  id: number;
  business_date?: string;
  opened_at?: string;
  cash_responsible?: EmployeeRef;
  roster?: RosterEntry[];
  /** Sólo viaja para admin o el responsable de caja; ausente ≠ 0. */
  expected_cash?: number | null;
  /**
   * Efectivo de domicilios sin liquidar (pedido 2c, `pos.delivery`):
   * renglón PROPIO y separado del cajón, `null` (nunca `0`) cuando quien
   * pregunta no puede verlo todavía (`cash.blind_close` antes del paso 2
   * del cierre) — "no te lo puedo mostrar" no es "no hay". NUNCA se suma a
   * `expected_cash`: es plata que todavía no está en el cajón.
   */
  delivery_cash_pending?: number | null;
  is_stale?: boolean;
  cash_over_threshold?: boolean;
}

/** `GET /shifts/current` — `null` cuando la sede no tiene turno abierto. */
export function getCurrentShift(): Promise<ShiftCurrent | null> {
  return api<ShiftCurrent | null>("/shifts/current");
}

export interface OpenShiftIn {
  opening_cash: DenominationCount;
  /** Sólo se manda si `cash.reserve` está encendida. */
  cash_reserve?: number;
  cash_responsible_id: number;
  opening_cause?: CashDifferenceCause;
  opening_note?: string;
}

export interface OpenShiftResult {
  id: number;
  business_day_id?: number;
  business_date?: string;
  status?: string;
  opened_at?: string;
  cash_responsible?: EmployeeRef;
  opening_cash_total?: number;
  cash_reserve?: number;
}

/** `POST /shifts/open` — exige `Idempotency-Key` (spec § convenciones). */
export function openShift(body: OpenShiftIn, idempotencyKey: string): Promise<OpenShiftResult> {
  return api<OpenShiftResult>("/shifts/open", { method: "POST", body, idempotencyKey });
}

// ---------------------------------------------------------------------------
// Roster
// ---------------------------------------------------------------------------

export interface RosterActionIn {
  employee_id: number;
  action: RosterAction;
  pin: string;
}

export interface RosterActionResult {
  employee_id?: number;
  action?: RosterAction;
  at?: string;
}

/** `POST /shifts/{id}/roster` — PIN de la persona que entra/sale/pausa. */
export function rosterAction(shiftId: number, body: RosterActionIn): Promise<RosterActionResult> {
  return api<RosterActionResult>(`/shifts/${shiftId}/roster`, { method: "POST", body });
}

// ---------------------------------------------------------------------------
// Relevos y arqueo sorpresa (cash.handovers)
// ---------------------------------------------------------------------------

export interface HandoverIn {
  kind: HandoverKind;
  counted_cash: DenominationCount;
  counted_card?: number | null;
  counted_transfer?: number | null;
  /** Obligatorio cuando `kind === "handover"`. */
  new_responsible_id?: number | null;
  /** Obligatorio cuando `kind === "spot_check"` (PIN de administrador). */
  authorizer_pin?: string | null;
  photo?: string | null;
}

export interface Breakdown {
  base?: number;
  cash_sales?: number;
  incomes?: number;
  expenses?: number;
  pickups?: number;
  expected?: number;
  /** Informativo, FUERA de `expected` (`app/shifts/service.py::compute_breakdown`,
   * pedido 2c): plata de domicilios que el domiciliario todavía no entregó. */
  delivery_cash_pending?: number;
}

/** El desglose congelado que devuelve el servidor: nunca se recalcula acá. */
export type FrozenBreakdown = Breakdown & { counted?: number; difference?: number };

export interface Handover {
  id: number;
  kind?: HandoverKind;
  from_responsible?: EmployeeRef;
  new_responsible?: EmployeeRef | null;
  counted_cash?: number;
  counted_card?: number | null;
  counted_transfer?: number | null;
  /** `null` cuando quien mira no es el responsable de caja ni admin. */
  breakdown?: FrozenBreakdown | null;
  at?: string;
}

/** `POST /shifts/{id}/handovers` — exige `Idempotency-Key`. */
export function createHandover(shiftId: number, body: HandoverIn, idempotencyKey: string): Promise<Handover> {
  return api<Handover>(`/shifts/${shiftId}/handovers`, { method: "POST", body, idempotencyKey });
}

// ---------------------------------------------------------------------------
// Movimientos de caja
// ---------------------------------------------------------------------------

export interface CashMovementIn {
  kind: CashMovementKind;
  cause: CashMovementCause;
  amount: number;
  note?: string | null;
  receipt_photo?: string | null;
  /** Sólo tras un `400 PETTY_CASH_LIMIT` en el primer intento. */
  authorizer_pin?: string | null;
}

export interface CashMovement {
  id: number;
  kind?: CashMovementKind;
  cause?: CashMovementCause;
  amount?: number;
  note?: string | null;
  receipt_photo?: string | null;
  employee_id?: number;
  employee_name?: string;
  authorized_by_employee_id?: number | null;
  authorized_by_employee_name?: string | null;
  at?: string;
}

/** `POST /shifts/{id}/cash-movements` — exige `Idempotency-Key`. */
export function createCashMovement(
  shiftId: number,
  body: CashMovementIn,
  idempotencyKey: string,
): Promise<CashMovement> {
  return api<CashMovement>(`/shifts/${shiftId}/cash-movements`, { method: "POST", body, idempotencyKey });
}

// ---------------------------------------------------------------------------
// Cambio (sencilla) — cash.swaps
// ---------------------------------------------------------------------------

export interface CashSwapIn {
  out: DenominationCount;
  in: DenominationCount;
}

export interface CashSwapResult {
  id: number;
  amount?: number;
  at?: string;
}

/** `POST /shifts/{id}/cash-swaps` — sin `Idempotency-Key` (no está en la lista de la spec). */
export function createCashSwap(shiftId: number, body: CashSwapIn): Promise<CashSwapResult> {
  return api<CashSwapResult>(`/shifts/${shiftId}/cash-swaps`, { method: "POST", body });
}

// ---------------------------------------------------------------------------
// Retiros — cash.pickups
// ---------------------------------------------------------------------------

export interface CashPickupIn {
  amount: number;
  denominations?: Denomination[];
  envelope_ref?: string | null;
  authorizer_pin: string;
  note?: string | null;
  photo?: string | null;
}

export interface CashPickup {
  id: number;
  amount?: number;
  envelope_ref?: string | null;
  /**
   * Snapshot del esperado al momento del retiro; nunca se recalcula. `null`
   * cuando quien mira no es el responsable de caja ni admin (mismo criterio
   * que `Handover.breakdown`) — se trata igual que "ausente".
   */
  expected_at_pickup?: number | null;
  authorized_by_employee_id?: number;
  authorized_by_employee_name?: string;
  at?: string;
  reversed_at?: string | null;
  reversed_reason?: string | null;
}

/** `POST /shifts/{id}/pickups` — exige `Idempotency-Key`. */
export function createPickup(shiftId: number, body: CashPickupIn, idempotencyKey: string): Promise<CashPickup> {
  return api<CashPickup>(`/shifts/${shiftId}/pickups`, { method: "POST", body, idempotencyKey });
}

export interface CashPickupReverseIn {
  reason: string;
  authorizer_pin: string;
}

/** `POST /shifts/{id}/pickups/{pid}/reverse` — no edita ni borra: reversa. */
export function reversePickup(
  shiftId: number,
  pickupId: number,
  body: CashPickupReverseIn,
): Promise<CashPickup> {
  return api<CashPickup>(`/shifts/${shiftId}/pickups/${pickupId}/reverse`, { method: "POST", body });
}

// ---------------------------------------------------------------------------
// Cierre a ciegas en tres pasos (cash.blind_close encendido)
// ---------------------------------------------------------------------------

export interface CloseCountIn {
  counted_cash: DenominationCount;
  counted_card?: number | null;
  counted_transfer?: number | null;
  tips_cash_out?: number;
  photo?: string | null;
}

export interface CloseCountResult {
  count_id?: number;
}

/**
 * `POST /shifts/{id}/close/count` — exige `Idempotency-Key`. Congela el
 * conteo y devuelve **sólo** `count_id`: nunca el esperado (paso 1 a ciegas,
 * spec § 3.2).
 */
export function closeCount(shiftId: number, body: CloseCountIn, idempotencyKey: string): Promise<CloseCountResult> {
  return api<CloseCountResult>(`/shifts/${shiftId}/close/count`, { method: "POST", body, idempotencyKey });
}

export interface CardTransferReview {
  registered?: number;
  counted?: number | null;
  difference?: number | null;
}

export interface CloseReview {
  count_id?: number;
  expected?: number;
  difference?: number;
  equation?: Breakdown;
  card?: CardTransferReview;
  transfer?: CardTransferReview;
  requires_cause?: boolean;
  requires_identified_cause?: boolean;
  is_critical?: boolean;
  closes_day_suggested?: boolean;
}

/** `GET /shifts/{id}/close/{count_id}/review` — recién acá aparece el esperado. */
export function getCloseReview(shiftId: number, countId: number): Promise<CloseReview> {
  return api<CloseReview>(`/shifts/${shiftId}/close/${countId}/review`);
}

export interface CloseConfirmIn {
  /** Exactamente la `difference` que el paso 2 mostró — nunca recalculada. */
  difference_seen: number;
  cause?: CashDifferenceCause;
  note?: string;
  closes_day: boolean;
  transfer_open_orders?: boolean;
}

export interface CloseConfirmResult {
  to_deposit?: number;
  closes_day?: boolean;
}

/**
 * `POST /shifts/{id}/close/{count_id}/confirm` — sin `Idempotency-Key` (no
 * está envuelto en `run_idempotent` en el backend). Ante `400
 * DIFFERENCE_CHANGED`, `ApiError.extra.review` trae la review nueva
 * (`CloseReview`): quien llama vuelve al paso 2 con ese objeto.
 */
export function confirmClose(shiftId: number, countId: number, body: CloseConfirmIn): Promise<CloseConfirmResult> {
  return api<CloseConfirmResult>(`/shifts/${shiftId}/close/${countId}/confirm`, { method: "POST", body });
}

// ---------------------------------------------------------------------------
// Cierre en un solo paso (cash.blind_close apagado)
//
// GAP: `features/fase-1a-cimientos/spec.md` sólo documenta el cierre en tres
// pasos; no lista un endpoint de cierre de un solo paso. `backend/app/shifts/
// router.py` (agente `backend-caja`, mismo pedido) sí expone `POST
// /shifts/{id}/close` con este payload — se usa esa ruta porque la instrucción
// de este agente permite "el endpoint que la spec/backends definan", pero
// queda declarado como gap de conciliación en el entregable: si el Maestro
// decide otra ruta, este archivo es el único lugar que hay que tocar.
// ---------------------------------------------------------------------------

export interface SingleStepCloseIn {
  counted_cash: DenominationCount;
  counted_card?: number | null;
  counted_transfer?: number | null;
  tips_cash_out?: number;
  photo?: string | null;
  cause?: CashDifferenceCause;
  note?: string;
  closes_day: boolean;
  transfer_open_orders?: boolean;
}

export interface SingleStepCloseResult {
  to_deposit?: number;
  closes_day?: boolean;
  expected?: number;
  difference?: number;
}

/** `POST /shifts/{id}/close` — exige `Idempotency-Key`. Ver nota GAP arriba. */
export function closeSingleStep(
  shiftId: number,
  body: SingleStepCloseIn,
  idempotencyKey: string,
): Promise<SingleStepCloseResult> {
  return api<SingleStepCloseResult>(`/shifts/${shiftId}/close`, { method: "POST", body, idempotencyKey });
}

// ---------------------------------------------------------------------------
// Resumen completo del turno
// ---------------------------------------------------------------------------

export interface ShiftSummary {
  id: number;
  business_date?: string;
  status?: string;
  opened_at?: string;
  opened_by?: EmployeeRef;
  cash_responsible?: EmployeeRef;
  opening_cash_total?: number;
  cash_reserve?: number;
  roster?: RosterEntry[];
  movements?: CashMovement[];
  swaps?: CashSwapResult[];
  pickups?: CashPickup[];
  handovers?: Handover[];
  /** El operador no lo ve si no es el responsable — ausente ≠ 0. */
  expected_cash?: number | null;
  /** Ver `ShiftCurrent.delivery_cash_pending` — mismo criterio, mismo `null` ≠ 0. */
  delivery_cash_pending?: number | null;
  counted_cash?: number | null;
  difference?: number | null;
  close_cause?: CashDifferenceCause | null;
  to_deposit?: number | null;
  closed_at?: string | null;
  closed_without_count?: boolean;
  reviewed_by?: EmployeeRef | null;
  reviewed_at?: string | null;
}

/** `GET /shifts/{id}` — resumen completo (device: su turno; admin: cualquiera de su organización). */
export function getShiftSummary(shiftId: number): Promise<ShiftSummary> {
  return api<ShiftSummary>(`/shifts/${shiftId}`);
}

// ---------------------------------------------------------------------------
// Propinas del turno (1b-2; renglón de domicilio agregado en 2c, rondas 2 y 3)
// ---------------------------------------------------------------------------

export interface SalesByMethod {
  cash?: number;
  card?: number;
  transfer?: number;
  other?: number;
}

export interface TipsByEmployee {
  employee_id: number;
  employee_name?: string;
  cash?: number;
  card?: number;
  transfer?: number;
  other?: number;
  /**
   * Propina en efectivo de un domicilio, por persona. Aditivo (2c): a
   * propósito NO distingue liquidada de pendiente — es «cuánta propina de
   * domicilio generó esta persona», no «cuánta se le puede pagar hoy». Eso
   * lo dice `ShiftTips.cash_out` (agregado, no por persona).
   */
  delivery?: number;
  total?: number;
}

export interface ShiftTips {
  by_method?: SalesByMethod;
  by_employee?: TipsByEmployee[];
  /**
   * Ronda 3 (H-8): lo que SALE del cajón al cierre como propina — propina en
   * efectivo de mostrador MÁS propina de domicilio YA LIQUIDADA (identidad
   * publicada por el servidor, `app/shifts/tips.py::get_shift_tips`:
   * `cash_out == by_method.cash + delivery_tips_settled`). Se PINTA tal
   * cual: no se suma, no se resta (AGENTS.md § "una sola matemática, en el
   * backend").
   */
  cash_out?: number;
  electronic_liability?: number;
  /** Toda la propina de domicilio del turno (liquidada + pendiente). */
  delivery_tips?: number;
  /** La que el domiciliario todavía no entregó: no está en el cajón ni en `cash_out`. */
  delivery_tips_pending?: number;
  /**
   * La ya liquidada: SÍ está físicamente en el cajón (el domiciliario
   * entrega venta + propina) y SÍ está incluida en `cash_out`. La publica el
   * servidor para que ningún cliente la derive restando `delivery_tips -
   * delivery_tips_pending` por su cuenta.
   */
  delivery_tips_settled?: number;
}

/**
 * `GET /shifts/{id}/tips` — a diferencia de `expected_cash`, esta ruta NO
 * aplica el gate de `_can_see_expected`: es alcanzable con sesión de
 * dispositivo (`current_actor` en `app/shifts/router.py:339` acepta admin O
 * device con persona identificada por PIN), no sólo admin — verificado antes
 * de consumirla desde el POS (iteración 3, ver entregable).
 */
export function getShiftTips(shiftId: number): Promise<ShiftTips> {
  return api<ShiftTips>(`/shifts/${shiftId}/tips`);
}

// ---------------------------------------------------------------------------
// Admin: Dinero (operacional + historial + rescates) y días operativos
// ---------------------------------------------------------------------------

export interface AdminShiftListItem {
  id: number;
  business_date?: string;
  store_id?: number;
  status?: string;
  opened_at?: string;
  closed_at?: string | null;
  cash_responsible?: EmployeeRef;
  expected_cash?: number | null;
  counted_cash?: number | null;
  difference?: number | null;
  is_stale?: boolean;
  reviewed_at?: string | null;
}

export interface AdminShiftFilters {
  storeId: number;
  from?: string;
  to?: string;
}

/** `GET /admin/shifts?store_id&from&to` (Dinero → Operacional e Historial). */
export function listAdminShifts(filters: AdminShiftFilters): Promise<AdminShiftListItem[]> {
  return api<AdminShiftListItem[]>("/admin/shifts", {
    query: { store_id: filters.storeId, from: filters.from, to: filters.to },
  });
}

/** URL de exportación CSV con los mismos filtros (`?format=csv`). */
export function adminShiftsCsvUrl(filters: AdminShiftFilters): string {
  const params = new URLSearchParams();
  params.set("format", "csv");
  params.set("store_id", String(filters.storeId));
  if (filters.from) params.set("from", filters.from);
  if (filters.to) params.set("to", filters.to);
  return `/api/v1/admin/shifts?${params.toString()}`;
}

export interface TimelineEvent {
  at?: string;
  kind?: string;
  summary?: string;
  employee_name?: string | null;
  data?: Record<string, unknown>;
}

/** `GET /admin/shifts/{id}/timeline` — orden cronológico, quién, monto, foto. */
export function getAdminShiftTimeline(shiftId: number): Promise<TimelineEvent[]> {
  return api<TimelineEvent[]>(`/admin/shifts/${shiftId}/timeline`);
}

export interface AdminReviewIn {
  note?: string;
}

/** `POST /admin/shifts/{id}/review` — marca `reviewed_by`/`reviewed_at`. */
export function adminReviewShift(shiftId: number, body: AdminReviewIn = {}): Promise<ShiftSummary> {
  return api<ShiftSummary>(`/admin/shifts/${shiftId}/review`, { method: "POST", body });
}

export interface AdminCloseAdministrativeIn {
  reason: string;
}

/** Rescate — sólo si `is_stale` (el backend lo hace cumplir, no la UI). */
export function adminCloseAdministrative(
  shiftId: number,
  body: AdminCloseAdministrativeIn,
): Promise<CloseConfirmResult> {
  return api<CloseConfirmResult>(`/admin/shifts/${shiftId}/close-administrative`, { method: "POST", body });
}

export interface AdminReopenIn {
  reason: string;
}

export function adminReopenShift(shiftId: number, body: AdminReopenIn): Promise<ShiftSummary> {
  return api<ShiftSummary>(`/admin/shifts/${shiftId}/reopen`, { method: "POST", body });
}

/**
 * `DELETE /admin/shifts/{id}` — cancelar (sólo sin actividad). La spec no
 * documenta el cuerpo de la respuesta; se tipa laxo a propósito.
 */
export function adminCancelShift(shiftId: number): Promise<Record<string, unknown>> {
  return api<Record<string, unknown>>(`/admin/shifts/${shiftId}`, { method: "DELETE" });
}

export interface AdminAdjustOpeningIn {
  opening_cash: DenominationCount;
  cash_reserve: number;
  reason: string;
}

export function adminAdjustOpening(shiftId: number, body: AdminAdjustOpeningIn): Promise<ShiftSummary> {
  return api<ShiftSummary>(`/admin/shifts/${shiftId}/adjust-opening`, { method: "POST", body });
}

export interface BusinessDayListItem {
  business_date?: string;
  status?: string;
  shifts?: AdminShiftListItem[];
}

export interface BusinessDayFilters {
  storeId: number;
  from?: string;
  to?: string;
}

/** `GET /admin/business-days?store_id&from&to`. */
export function listBusinessDays(filters: BusinessDayFilters): Promise<BusinessDayListItem[]> {
  return api<BusinessDayListItem[]>("/admin/business-days", {
    query: { store_id: filters.storeId, from: filters.from, to: filters.to },
  });
}

// ---------------------------------------------------------------------------
// Admin: Turnos y personal (actividad por persona, autorizaciones)
// ---------------------------------------------------------------------------

export interface EmployeeActivityShift {
  shift_id?: number;
  business_date?: string;
  role?: string;
  in_at?: string | null;
  out_at?: string | null;
  was_cash_responsible?: boolean;
  difference?: number | null;
}

export interface AuthorizationGiven {
  action?: string;
  at?: string;
  reference_type?: string | null;
  reference_id?: string | number | null;
}

export interface EmployeeActivity {
  employee?: EmployeeRef;
  shifts?: EmployeeActivityShift[];
  difference_streak?: number;
  authorizations_given?: AuthorizationGiven[];
}

export interface EmployeeActivityFilters {
  storeId?: number;
  from?: string;
  to?: string;
}

/**
 * `GET /admin/employees/{id}/activity?from&to` — turnos, entradas/salidas,
 * diferencias, racha y autorizaciones dadas. Los campos de venta llegan en
 * 1b: no se piden ni se inventan acá.
 */
export function getEmployeeActivity(
  employeeId: number,
  filters: EmployeeActivityFilters = {},
): Promise<EmployeeActivity> {
  return api<EmployeeActivity>(`/admin/employees/${employeeId}/activity`, {
    query: { store_id: filters.storeId, from: filters.from, to: filters.to },
  });
}

export interface Authorization {
  id: number;
  authorizer_id?: number;
  authorizer_name?: string;
  action?: string;
  requested_by_employee_id?: number | null;
  at?: string;
  reference_type?: string | null;
  reference_id?: string | number | null;
}

export interface AuthorizationFilters {
  from?: string;
  to?: string;
  authorizerId?: number;
}

/** `GET /admin/authorizations?from&to&authorizer_id`. */
export function listAuthorizations(filters: AuthorizationFilters = {}): Promise<Authorization[]> {
  return api<Authorization[]>("/admin/authorizations", {
    query: { from: filters.from, to: filters.to, authorizer_id: filters.authorizerId },
  });
}

/** URL de exportación CSV con los mismos filtros (`?format=csv`). */
export function authorizationsCsvUrl(filters: AuthorizationFilters = {}): string {
  const params = new URLSearchParams();
  params.set("format", "csv");
  if (filters.from) params.set("from", filters.from);
  if (filters.to) params.set("to", filters.to);
  if (filters.authorizerId !== undefined) params.set("authorizer_id", String(filters.authorizerId));
  return `/api/v1/admin/authorizations?${params.toString()}`;
}

// ---------------------------------------------------------------------------
// Domicilio propio: efectivo pendiente y liquidación (`pos.delivery`, §3.3).
//
// Estos endpoints viven en `app/channels/router.py` (territorio de
// `backend-dinero-canales`), no en `app/shifts/router.py`: se publican
// ACÁ, en `api/shifts.ts`, porque la pantalla que los consume es "el
// efectivo de domicilios en el turno" (misión de este agente, `features/
// shifts/**`) y no la de canales/plataformas. Mismo criterio que
// `payments.ts` llamando rutas fuera de `app/payments/**`.
// ---------------------------------------------------------------------------

export interface CourierPending {
  courier_employee_id: number;
  courier_employee_name?: string;
  payments_count?: number;
  amount?: number;
  tip_amount?: number;
  total?: number;
}

export interface DeliveryPendingList {
  store_id?: number;
  couriers?: CourierPending[];
  amount?: number;
  tip_amount?: number;
  total?: number;
}

/**
 * `GET /delivery-settlements/pending` — efectivo de domicilios por
 * liquidar, agrupado por domiciliario. **No es una deuda del empleado**
 * (CST art. 149): es plata de la sede que todavía no llegó al cajón.
 */
export function listPendingDeliveryCash(): Promise<DeliveryPendingList> {
  return api<DeliveryPendingList>("/delivery-settlements/pending");
}

export interface DeliverySettlementIn {
  courier_employee_id: number;
  /** `undefined`/`null` = liquidar TODO lo pendiente de ese domiciliario.
   * Una lista vacía la rechaza el backend con `400` (`null` ≠ `[]`). */
  payment_ids?: number[] | null;
  note?: string;
}

export type DeliverySettlementStatus = "settled" | "voided";

export interface DeliverySettlement {
  id: number;
  store_id?: number;
  courier_employee_id?: number;
  courier_employee_name?: string;
  shift_id?: number;
  cash_movement_id?: number | null;
  amount?: number;
  tip_amount?: number;
  total?: number;
  payments_count?: number;
  status?: DeliverySettlementStatus;
  note?: string | null;
  business_date?: string;
  at?: string;
  /** Quién registró la liquidación (no confundir con `courier_employee_name`). */
  employee_name?: string;
  voided_at?: string | null;
  voided_reason?: string | null;
  voided_by_employee_name?: string | null;
  void_shift_id?: number | null;
  void_cash_movement_id?: number | null;
}

/**
 * `POST /delivery-settlements` — el domiciliario entrega el efectivo: entra
 * al turno ABIERTO como ingreso de causa `delivery_settlement`. Exige
 * `Idempotency-Key` (mueve plata) y turno abierto (`409 NO_OPEN_SHIFT` si no).
 */
export function createDeliverySettlement(
  body: DeliverySettlementIn,
  idempotencyKey: string,
): Promise<DeliverySettlement> {
  return api<DeliverySettlement>("/delivery-settlements", { method: "POST", body, idempotencyKey });
}

export interface DeliverySettlementVoidIn {
  reason: string;
}

/**
 * `POST /delivery-settlements/{id}/void` — deshacer una liquidación: el
 * movimiento espejo (egreso, misma causa) se escribe en el turno abierto al
 * momento de deshacerla; el original queda vivo (nada financiero se borra)
 * y los cobros vuelven a "pendiente". Sin turno abierto, `409`.
 */
export function voidDeliverySettlement(
  settlementId: number,
  body: DeliverySettlementVoidIn,
  idempotencyKey: string,
): Promise<DeliverySettlement> {
  return api<DeliverySettlement>(`/delivery-settlements/${settlementId}/void`, {
    method: "POST",
    body,
    idempotencyKey,
  });
}
