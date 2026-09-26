/**
 * Comandas, mesas y precuenta. Tipado contra
 * `features/fase-1b-venta/CONTRATO-INTERNO-1b-1.md § 2.4` (contrato de API
 * de 1b-1, vinculante) y contra `backend/app/orders/schemas.py` (mismo
 * territorio de `backend-comanda`, ya escrito cuando este archivo se creó).
 *
 * Todo campo de un tipo `Out` es opcional o `| null` (AGENTS.md § convenciones
 * de frontend, CONTRATO-INTERNO §6.1: "todo campo nuevo de respuesta es
 * opcional en los tipos Out") — el backend puede no mandarlo todavía y un
 * tipo que lo exige no puede romper la pantalla. Los tipos `In` son
 * estrictos: acá el frontend sabe exactamente qué manda.
 *
 * El frontend NUNCA calcula plata: todo total, impuesto y propina sugerida
 * se pinta tal como llega en `totals`/`tip`/`PreBillOut` (AGENTS.md, §6.1).
 */

import { api } from "@/api/client"

// ---------------------------------------------------------------------------
// Enums de la comanda (mismos valores que `app/orders/models.py`).
// ---------------------------------------------------------------------------

export type OrderChannel = "counter" | "dine_in" | "takeout" | "delivery" | "platform" | "staff_meal"
/**
 * `compensated` (pedido 2c, `app/orders/schemas.py::OrderStatusLiteral`):
 * una venta de plataforma cancelada DESPUÉS de preparar. No es `voided`
 * (`app/channels/service.py::cancel_platform_sale` — territorio de
 * `backend-dinero-canales` — la deja marcada aparte para que el reporte de
 * mermas y el de anulaciones no la confundan con una anulación común: el
 * insumo ya se descontó y se queda descontado, y la compensación es de la
 * VENTA, nunca del inventario).
 */
export type OrderStatus = "open" | "to_pay" | "paid" | "merged" | "voided" | "compensated"
export type OrderItemStatus = "pending" | "sent" | "ready" | "served" | "voided"
export type VoidReason =
  | "customer_changed_mind"
  | "server_error"
  | "kitchen_error"
  | "long_wait"
  | "walkout"
  | "duplicate"
  | "other"
export type CourtesyReason = "complaint" | "promo_owner" | "guest_of_owner" | "other"
export type DiscountReason = "promo" | "complaint" | "owner" | "employee" | "other"
export type DiscountScope = "order" | "item"
export type DiscountKind = "percent" | "amount"
export type TableStatusValue = "free" | "occupied" | "to_pay"
export type SubAccountStatus = "open" | "paid"

// ---------------------------------------------------------------------------
// Piezas compartidas de salida.
// ---------------------------------------------------------------------------

export interface EmployeeRefOut {
  id?: number
  name?: string
}

export interface TableRefOut {
  id?: number
  number?: string
  zone_name?: string
}

export interface TakeoutOut {
  customer_name?: string | null
  phone?: string | null
  promised_at?: string | null
}

/**
 * Domicilio propio (`pos.delivery`, §3.3): dirección, teléfono y
 * domiciliario, congelados en la comanda al crearla. **El cargo de
 * domicilio NO viaja acá**: es una línea más de `OrderOut.items`
 * (`app/orders/service.py::_build_delivery_fee_item`), con su impuesto ya
 * calculado — este componente nunca lo suma, resta ni deriva.
 */
export interface DeliveryOut {
  address?: string
  phone?: string
  courier?: EmployeeRefOut
}

/**
 * Pedido de plataforma (`pos.platforms`, §3.3). **Nunca trae
 * `commission_bp`** (`app/orders/schemas.py::PlatformOut`, mismo esquema
 * que ve el dispositivo): la comisión es plata del negocio frente a la
 * plataforma, no algo que el operador necesite ver para tomar un pedido.
 */
export interface OrderPlatformInfoOut {
  id?: number
  name?: string
  external_id?: string
}

/** «Marchar» un curso (`pos.courses`, requiere `kitchen.view`): sella la
 * hora la PRIMERA vez; el backend es idempotente (`fire_course`) y una
 * segunda llamada legítima no vuelve a mover `fired_at`. */
export interface CourseFireOut {
  course?: string
  fired_at?: string
  fired_by?: EmployeeRefOut
}

export interface ModifierOut {
  option_id?: number
  group_name?: string
  name?: string
  price_delta?: number
}

export interface ComboSelectionOut {
  group_id?: number
  group_name?: string
  option_id?: number
  product_id?: number
  product_name?: string
}

export interface CourtesyOut {
  reason?: CourtesyReason
  note?: string | null
  authorized_by?: EmployeeRefOut | null
  at?: string
  after_bill?: boolean
}

export interface VoidInfoOut {
  reason?: VoidReason
  note?: string | null
  by?: EmployeeRefOut | null
  authorized_by?: EmployeeRefOut | null
  at?: string
  after_bill?: boolean
  minutes_since_sent?: number | null
}

export interface OrderItemOut {
  id: number
  product_id?: number | null
  combo_id?: number | null
  name?: string
  qty?: number
  seat?: number | null
  course?: string
  station?: string | null
  list_price?: number
  unit_price?: number
  tax_code?: string
  tax_rate?: number
  modifiers?: ModifierOut[]
  modifiers_text?: string | null
  combo_selections?: ComboSelectionOut[] | null
  note?: string | null
  status?: OrderItemStatus
  round_no?: number | null
  sent_at?: string | null
  ready_at?: string | null
  served_at?: string | null
  sent_at_payment?: boolean
  /** De `compute_order_totals`: 0 en cortesía/anulado. El frontend sólo pinta. */
  gross?: number
  discount?: number
  net?: number
  tax?: number
  courtesy?: CourtesyOut | null
  void?: VoidInfoOut | null
  /**
   * El cargo de domicilio: una línea de plata, no un plato. Nunca va a
   * cocina (`station` nula), no cuenta en «Enviar a cocina · N» y no se
   * «marcha». Ausente en un backend viejo = no es cargo.
   */
  is_delivery_fee?: boolean
}

export interface OrderRoundOut {
  round_no?: number
  sent_at?: string
  sent_at_payment?: boolean
}

export interface OrderDiscountOut {
  id: number
  scope?: DiscountScope
  item_id?: number | null
  kind?: DiscountKind
  value?: number
  amount?: number
  reason?: DiscountReason
  note?: string | null
  by?: EmployeeRefOut
  authorized_by?: EmployeeRefOut | null
  after_bill?: boolean
  at?: string
}

export interface TaxLineOut {
  rate?: number
  base?: number
  tax?: number
}

export interface TotalsOut {
  subtotal?: number
  discount_total?: number
  tax_lines?: TaxLineOut[]
  tax_total?: number
  total?: number
}

export interface TipInfoOut {
  base?: number
  suggested_pct?: number
  suggested_amount?: number
}

export interface SubAccountItemOut {
  item_id?: number
  name?: string
  qty?: number
  portions?: number
  of_portions?: number
  share?: number
}

export interface SubAccountOut {
  id: number
  seq?: number
  label?: string
  seat?: number | null
  status?: SubAccountStatus
  items?: SubAccountItemOut[]
  totals?: TotalsOut
  tip?: TipInfoOut | null
  document_id?: number | null
}

export interface OrderOut {
  id: number
  version?: number
  channel?: OrderChannel
  status?: OrderStatus
  business_date?: string
  shift_id?: number | null
  tables?: TableRefOut[]
  covers?: number | null
  note?: string | null
  takeout?: TakeoutOut | null
  delivery?: DeliveryOut | null
  platform?: OrderPlatformInfoOut | null
  consumed_by?: EmployeeRefOut | null
  opened_by?: EmployeeRefOut
  opened_at?: string
  bill_presented_at?: string | null
  bill_print_count?: number
  paid_at?: string | null
  closed_at?: string | null
  paid_by?: EmployeeRefOut | null
  voided_at?: string | null
  void_reason?: VoidReason | null
  merged_into_order_id?: number | null
  transferred_from_shift_id?: number | null
  kitchen_view_enabled?: boolean
  split_parts?: number | null
  /** Cursos ya marchados (`pos.courses`); un curso ausente acá todavía no se marchó. */
  courses_fired?: CourseFireOut[]
  rounds?: OrderRoundOut[]
  items?: OrderItemOut[]
  discounts?: OrderDiscountOut[]
  sub_accounts?: SubAccountOut[]
  totals?: TotalsOut
  tip?: TipInfoOut | null
  document_id?: number | null
}

// ---------------------------------------------------------------------------
// Mesas.
// ---------------------------------------------------------------------------

export interface TableStatusOut {
  id: number
  number?: string
  seats?: number
  status?: TableStatusValue
  order_id?: number | null
  opened_at?: string | null
  covers?: number | null
  /** Total tal como llega de `compute_order_totals` — el servidor lo calcula. */
  total?: number | null
  /** Platos que cocina marcó listos y nadie sirvió todavía (conteo del servidor). */
  ready_count?: number
  /** Unidades todavía sin enviar a cocina (conteo del servidor, sin el cargo de domicilio). */
  unsent_count?: number
  /** Quién abrió la mesa: iniciales en la tarjeta y el filtro «Mis mesas». */
  opened_by?: EmployeeRefOut | null
}

export interface ZoneStatusOut {
  id: number
  name?: string
  tables?: TableStatusOut[]
}

export interface TablesStatusOut {
  zones?: ZoneStatusOut[]
}

export interface FavoriteOut {
  product_id: number
  qty?: number
}

// ---------------------------------------------------------------------------
// Precuenta y división.
// ---------------------------------------------------------------------------

export interface PreBillLineOut {
  description?: string
  qty?: number
  unit_price?: number
  gross?: number
  discount?: number
  net?: number
}

export interface PreBillOut {
  order_id?: number
  version?: number
  lines?: PreBillLineOut[]
  subtotal?: number
  discount_total?: number
  tax_lines?: TaxLineOut[]
  tax_total?: number
  total?: number
  tip?: TipInfoOut | null
  legend?: string
  bill_presented_at?: string
  bill_print_count?: number
}

export interface BillSplitEqualOut {
  mode?: "equal"
  parts?: number
  per_part?: number[]
  total?: number
}

export interface BillSplitItemsOut {
  mode?: "items"
  sub_accounts?: SubAccountOut[]
}

export type BillSplitOut = BillSplitEqualOut | BillSplitItemsOut

// ---------------------------------------------------------------------------
// Admin.
// ---------------------------------------------------------------------------

/** Un ítem anulado de la fila (contrato ampliado 1b-2, `app/orders/service.py::admin_list_orders`). */
export interface AdminOrderVoidDetailOut {
  item_id?: number
  reason?: VoidReason | null
  after_bill?: boolean
  minutes_since_sent?: number | null
  authorized_by?: string | null
}

export interface AdminOrderListItem {
  id: number
  business_date?: string
  shift_id?: number | null
  channel?: OrderChannel
  tables?: string[]
  covers?: number | null
  status?: OrderStatus
  opened_by?: string
  opened_at?: string
  bill_presented_at?: string | null
  paid_at?: string | null
  /** Sólo si la comanda ya cerró (pagada o anulada). Mesa: cerrada − abierta. */
  closed_at?: string | null
  table_minutes?: number | null
  /** Cobro: pagada − cuenta presentada. */
  bill_to_paid_minutes?: number | null
  items_count?: number
  total?: number
  voided_items?: number
  voids_after_bill?: number
  void_details?: AdminOrderVoidDetailOut[]
  courtesies?: number
  /** Σ `list_price × qty` de los ítems de cortesía (a precio de lista, sin costo — fase 2). */
  courtesy_list_value?: number
  discount_total?: number
  sent_at_payment_items?: number
  /** `sent_at_payment_items / items_count` de ESTA comanda; `null` sin ítems vivos. */
  sent_at_payment_ratio?: number | null
  is_staff_meal?: boolean
  transferred?: boolean
  /** Medios de pago con los que se cobró (documentos emitidos, no anulados/reversados). */
  payment_methods?: string[]
}

/** Tiempo de cocina "listo − enviado" (p50/p90) por estación, sobre todo el período filtrado. */
export interface AdminOrderKitchenStationTimeOut {
  station: string
  p50_seconds: number
  p90_seconds: number
  samples: number
}

/** `GET /admin/orders` (1b-2): ya no es una lista plana — trae la tabla por
 * comanda más los agregados del período completo (un percentil no es una
 * fila de esa tabla). `format=csv` sigue exportando sólo `rows`. */
export interface AdminOrdersReportOut {
  rows: AdminOrderListItem[]
  kitchen_times_by_station: AdminOrderKitchenStationTimeOut[]
  sent_at_payment_ratio: number | null
}

export interface AdminOrdersQuery {
  storeId: number
  from?: string
  to?: string
  status?: string
  channel?: string
  flags?: string
}

// ---------------------------------------------------------------------------
// Entradas (estrictas).
// ---------------------------------------------------------------------------

export interface TakeoutIn {
  customer_name: string
  phone?: string
  promised_at?: string
}

/**
 * Los tres datos propios de `delivery` (§3.3), los tres obligatorios al
 * crear (`app/orders/schemas.py::DeliveryIn`). El cargo de domicilio NO va
 * acá: lo agrega el servidor solo, como ítem, al crear la comanda.
 */
export interface DeliveryIn {
  address: string
  phone: string
  courier_employee_id: number
}

/**
 * `platform_id` referencia una plataforma activa de la sede (CONTRATO C7,
 * `@/api/channels`); `external_id` es el número del pedido en la
 * plataforma, tecleado a mano (la integración por API es fase 3).
 */
export interface PlatformOrderIn {
  platform_id: number
  external_id: string
}

export interface OrderCreateIn {
  channel: OrderChannel
  table_ids?: number[]
  covers?: number
  takeout?: TakeoutIn
  delivery?: DeliveryIn
  platform?: PlatformOrderIn
  consumed_by_employee_id?: number
  note?: string
}

export interface ModifierSelectionIn {
  option_id: number
}

export interface ComboSelectionIn {
  group_id: number
  option_id: number
}

export interface OrderItemIn {
  product_id?: number
  combo_id?: number
  qty: number
  seat?: number
  course?: string
  modifiers?: ModifierSelectionIn[]
  combo_selections?: ComboSelectionIn[]
  note?: string
}

export interface AddItemsIn {
  expected_version: number
  items: OrderItemIn[]
  authorizer_pin?: string
}

export interface PatchItemIn {
  expected_version: number
  qty?: number
  note?: string
  seat?: number
  /** Con la cuenta ya presentada, el servidor pide el PIN igual que al agregar. */
  authorizer_pin?: string
}

export interface ExpectedVersionIn {
  expected_version: number
}

export interface VoidItemIn {
  expected_version: number
  reason: VoidReason
  note?: string
  authorizer_pin?: string
}

export interface CourtesyItemIn {
  expected_version: number
  reason: CourtesyReason
  note?: string
  authorizer_pin: string
}

export interface DiscountIn {
  expected_version: number
  scope: DiscountScope
  item_id?: number
  kind: DiscountKind
  value: number
  reason: DiscountReason
  note?: string
  authorizer_pin?: string
}

export interface MergeIn {
  expected_version: number
  from_order_id: number
  authorizer_pin?: string
}

export interface MoveIn {
  expected_version: number
  table_ids: number[]
  authorizer_pin?: string
}

export interface VoidOrderIn {
  expected_version: number
  reason: VoidReason
  note?: string
  authorizer_pin?: string
}

export interface SharedItemIn {
  item_id: number
  portions: number
}

export interface SplitGroupIn {
  label?: string
  seat?: number
  item_ids: number[]
  shared?: SharedItemIn[]
}

export type BillSplitIn =
  | { expected_version: number; mode: "equal"; parts: number }
  | { expected_version: number; mode: "items"; groups: SplitGroupIn[] }

// ---------------------------------------------------------------------------
// Mesas.
// ---------------------------------------------------------------------------

export function listTablesStatus(): Promise<TablesStatusOut> {
  return api<TablesStatusOut>("/tables/status")
}

// ---------------------------------------------------------------------------
// Comandas.
// ---------------------------------------------------------------------------

export function createOrder(body: OrderCreateIn): Promise<OrderOut> {
  return api<OrderOut>("/orders", { method: "POST", body })
}

export function listOrders(params?: { status?: string; channel?: string }): Promise<OrderOut[]> {
  return api<OrderOut[]>("/orders", { query: { status: params?.status, channel: params?.channel } })
}

export function getOrder(orderId: number): Promise<OrderOut> {
  return api<OrderOut>(`/orders/${orderId}`)
}

export function listFavorites(): Promise<FavoriteOut[]> {
  return api<FavoriteOut[]>("/orders/favorites")
}

export function addItems(orderId: number, body: AddItemsIn, idempotencyKey: string): Promise<OrderOut> {
  return api<OrderOut>(`/orders/${orderId}/items`, { method: "POST", body, idempotencyKey })
}

export function patchItem(orderId: number, itemId: number, body: PatchItemIn): Promise<OrderOut> {
  return api<OrderOut>(`/orders/${orderId}/items/${itemId}`, { method: "PATCH", body })
}

export function sendOrder(orderId: number, body: ExpectedVersionIn, idempotencyKey: string): Promise<OrderOut> {
  return api<OrderOut>(`/orders/${orderId}/send`, { method: "POST", body, idempotencyKey })
}

/**
 * «Marchar» un curso (`pos.courses`, requiere `kitchen.view`):
 * `POST /orders/{id}/courses/{course}/fire`. Idempotente en el backend
 * (`fire_course`): una segunda llamada con la versión ya actualizada tras
 * la primera no mueve `fired_at` otra vez — pero SÍ exige la versión
 * vigente (`409 STALE_VERSION` con una vieja), así que la UI deshabilita
 * el botón en cuanto `courses_fired` trae el curso, en vez de confiar en
 * que un segundo click "no pasa nada".
 */
export function fireCourse(
  orderId: number,
  course: string,
  body: ExpectedVersionIn,
  idempotencyKey: string,
): Promise<OrderOut> {
  return api<OrderOut>(`/orders/${orderId}/courses/${encodeURIComponent(course)}/fire`, {
    method: "POST",
    body,
    idempotencyKey,
  })
}

export function markReady(orderId: number, itemId: number, idempotencyKey: string): Promise<OrderOut> {
  return api<OrderOut>(`/orders/${orderId}/items/${itemId}/ready`, { method: "POST", idempotencyKey })
}

export function markServed(orderId: number, itemId: number, idempotencyKey: string): Promise<OrderOut> {
  return api<OrderOut>(`/orders/${orderId}/items/${itemId}/served`, { method: "POST", idempotencyKey })
}

export function voidItem(orderId: number, itemId: number, body: VoidItemIn): Promise<OrderOut> {
  return api<OrderOut>(`/orders/${orderId}/items/${itemId}/void`, { method: "POST", body })
}

export function courtesyItem(orderId: number, itemId: number, body: CourtesyItemIn): Promise<OrderOut> {
  return api<OrderOut>(`/orders/${orderId}/items/${itemId}/courtesy`, { method: "POST", body })
}

export function addDiscount(orderId: number, body: DiscountIn): Promise<OrderOut> {
  return api<OrderOut>(`/orders/${orderId}/discounts`, { method: "POST", body })
}

/**
 * `DELETE /orders/{id}/discounts/{discount_id}`: `expected_version` va en la
 * query (decisión de `backend-comanda`, `app/orders/router.py`) — un `DELETE`
 * con cuerpo JSON no es confiable en todos los clientes HTTP.
 */
export function removeDiscount(orderId: number, discountId: number, expectedVersion: number): Promise<OrderOut> {
  return api<OrderOut>(`/orders/${orderId}/discounts/${discountId}`, {
    method: "DELETE",
    query: { expected_version: expectedVersion },
  })
}

export function mergeOrders(orderId: number, body: MergeIn): Promise<OrderOut> {
  return api<OrderOut>(`/orders/${orderId}/merge`, { method: "POST", body })
}

export function moveOrder(orderId: number, body: MoveIn): Promise<OrderOut> {
  return api<OrderOut>(`/orders/${orderId}/move`, { method: "POST", body })
}

export function voidOrder(orderId: number, body: VoidOrderIn): Promise<OrderOut> {
  return api<OrderOut>(`/orders/${orderId}/void`, { method: "POST", body })
}

export function presentBill(orderId: number, body: ExpectedVersionIn, idempotencyKey: string): Promise<PreBillOut> {
  return api<PreBillOut>(`/orders/${orderId}/bill/present`, { method: "POST", body, idempotencyKey })
}

export function splitBill(orderId: number, body: BillSplitIn): Promise<BillSplitOut> {
  return api<BillSplitOut>(`/orders/${orderId}/bill/split`, { method: "POST", body })
}

export function listSubAccounts(orderId: number): Promise<SubAccountOut[]> {
  return api<SubAccountOut[]>(`/orders/${orderId}/sub-accounts`)
}

// ---------------------------------------------------------------------------
// Admin.
// ---------------------------------------------------------------------------

export function adminListOrders(params: AdminOrdersQuery): Promise<AdminOrdersReportOut> {
  return api<AdminOrdersReportOut>("/admin/orders", {
    query: {
      store_id: params.storeId,
      from: params.from,
      to: params.to,
      status: params.status,
      channel: params.channel,
      flags: params.flags,
    },
  })
}

export function adminGetOrder(orderId: number): Promise<OrderOut> {
  return api<OrderOut>(`/admin/orders/${orderId}`)
}

/** URL directa (con `format=csv`) para el enlace "Exportar" — mismo patrón que `adminShiftsCsvUrl`. */
export function adminOrdersCsvUrl(params: AdminOrdersQuery): string {
  const query = new URLSearchParams()
  query.set("format", "csv")
  query.set("store_id", String(params.storeId))
  if (params.from) query.set("from", params.from)
  if (params.to) query.set("to", params.to)
  if (params.status) query.set("status", params.status)
  if (params.channel) query.set("channel", params.channel)
  if (params.flags) query.set("flags", params.flags)
  return `/api/v1/admin/orders?${query.toString()}`
}
