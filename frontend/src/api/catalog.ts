/**
 * Carta plana: categorías, productos, modificadores, combos y menú del día.
 * Tipado contra `features/fase-1a-cimientos/spec.md` (contrato Catalog) y
 * `features/fase-1a-cimientos/CONTRATO-INTERNO.md`. Todo campo que el
 * backend puede agregar más adelante es opcional acá (nunca se asume que un
 * campo nuevo existe).
 */

import { api } from "@/api/client"

export type TaxCode = "inc_8" | "iva_19" | "excluded"

// ---------------------------------------------------------------------------
// Categorías.
// ---------------------------------------------------------------------------

export interface CategoryOut {
  id: number
  name: string
  sort_order: number
  default_course?: string | null
  default_station?: string | null
  active: boolean
}

export interface CategoryIn {
  name: string
  sort_order?: number
  default_course?: string | null
  default_station?: string | null
}

export interface CategoryUpdateIn {
  name?: string
  sort_order?: number
  default_course?: string | null
  default_station?: string | null
  active?: boolean
}

// ---------------------------------------------------------------------------
// Productos.
// ---------------------------------------------------------------------------

export interface ProductPricesIn {
  dine_in: number
  takeout?: number | null
  delivery?: number | null
  platform?: number | null
}

/** Precio crudo (admin): un canal ausente viene `null` — es lo que la tabla
 * de productos pinta como "—", a diferencia de la carta resuelta del POS. */
export interface ProductPricesRawOut {
  dine_in: number
  takeout: number | null
  delivery: number | null
  platform: number | null
}

/** Precio resuelto (lo que devuelve `GET /catalog`): todo canal opcional cae
 * al de mesa, nunca `null`. */
export interface ProductPricesResolvedOut {
  dine_in: number
  takeout: number
  delivery: number
  platform: number
}

export interface ModifierOptionOut {
  id: number
  name: string
  price_delta: number
  available: boolean
}

export interface ModifierGroupOut {
  id: number
  product_id: number
  name: string
  required: boolean
  min: number
  max: number
  sort_order: number
  options: ModifierOptionOut[]
}

export interface ProductAdminOut {
  id: number
  category_id: number
  name: string
  description?: string | null
  station?: string | null
  default_course?: string | null
  prices: ProductPricesRawOut
  tax_code: TaxCode
  active: boolean
  available: boolean
  daily_count?: number | null
  daily_remaining?: number | null
  /** Pedido 2c: este producto ES el cargo de domicilio de la sede (§4.3).
   * A lo sumo uno activo por sede — el backend corta con `409
   * DELIVERY_FEE_ALREADY_CONFIGURED` si ya hay otro. Nunca se agrega a
   * mano a una comanda (`400 DELIVERY_FEE_NOT_ORDERABLE`): el servidor lo
   * suma solo, como línea, al crear una comanda de domicilio. */
  is_delivery_fee: boolean
  modifier_groups?: ModifierGroupOut[]
}

export interface ProductIn {
  category_id: number
  name: string
  description?: string | null
  station?: string | null
  default_course?: string | null
  prices: ProductPricesIn
  tax_code?: TaxCode | null
  daily_count?: number | null
  is_delivery_fee?: boolean
}

export interface ProductUpdateIn {
  category_id?: number
  name?: string
  description?: string | null
  station?: string | null
  default_course?: string | null
  prices?: ProductPricesIn
  tax_code?: TaxCode | null
  active?: boolean
  is_delivery_fee?: boolean
}

export interface ProductAvailabilityIn {
  available: boolean
  daily_count?: number | null
}

// ---------------------------------------------------------------------------
// Grupos y opciones de modificadores.
// ---------------------------------------------------------------------------

export interface ModifierOptionIn {
  id?: number
  name: string
  price_delta?: number
}

export interface ModifierGroupIn {
  name: string
  required?: boolean
  min?: number
  max?: number
  sort_order?: number
  options?: ModifierOptionIn[]
}

export interface ModifierGroupUpdateIn {
  name?: string
  required?: boolean
  min?: number
  max?: number
  sort_order?: number
  options?: ModifierOptionIn[]
}

// ---------------------------------------------------------------------------
// Combos y menú del día.
// ---------------------------------------------------------------------------

/** `days`: 0 = lunes ... 6 = domingo (igual que `date.weekday()` en el backend). */
export interface ComboSchedule {
  days: number[]
  from: string
  to: string
}

export interface ComboOptionOut {
  id: number
  name: string
  product_id: number
  available_today: boolean
}

/** Sólo en la vista de admin: `active_today` es lo que pinta el checklist
 * de "armar el menú de hoy" (no viaja en `GET /catalog`, que ya filtra por él). */
export interface ComboOptionAdminOut extends ComboOptionOut {
  active_today: boolean
}

export interface ComboGroupOut {
  id: number
  name: string
  sort_order: number
  options: ComboOptionOut[]
}

export interface ComboGroupAdminOut {
  id: number
  name: string
  sort_order: number
  options: ComboOptionAdminOut[]
}

export interface ComboAdminOut {
  id: number
  name: string
  price: number
  active: boolean
  active_now: boolean
  schedule: ComboSchedule
  groups: ComboGroupAdminOut[]
}

export interface ComboOptionIn {
  id?: number
  product_id: number
}

export interface ComboGroupIn {
  id?: number
  name: string
  sort_order?: number
  options?: ComboOptionIn[]
}

export interface ComboIn {
  name: string
  price: number
  active?: boolean
  schedule: ComboSchedule
  groups?: ComboGroupIn[]
}

export interface ComboUpdateIn {
  name?: string
  price?: number
  active?: boolean
  schedule?: ComboSchedule
  groups?: ComboGroupIn[]
}

// ---------------------------------------------------------------------------
// `GET /catalog`.
// ---------------------------------------------------------------------------

export interface CatalogProductOut {
  id: number
  category_id: number
  name: string
  description?: string | null
  station?: string | null
  default_course?: string | null
  prices: ProductPricesResolvedOut
  tax_code: TaxCode
  available: boolean
  daily_count?: number | null
  daily_remaining?: number | null
  modifier_groups?: ModifierGroupOut[]
}

export interface CatalogComboOut {
  id: number
  name: string
  price: number
  active_now: boolean
  schedule: ComboSchedule
  groups: ComboGroupOut[]
}

export interface CatalogOut {
  categories: CategoryOut[]
  products: CatalogProductOut[]
  combos: CatalogComboOut[]
}

export function getCatalog(storeId?: number): Promise<CatalogOut> {
  return api<CatalogOut>("/catalog", { query: { store_id: storeId } })
}

// ---------------------------------------------------------------------------
// Admin: categorías.
// ---------------------------------------------------------------------------

export function listCategories(storeId: number): Promise<CategoryOut[]> {
  return api<CategoryOut[]>("/admin/categories", { query: { store_id: storeId } })
}

export function createCategory(storeId: number, data: CategoryIn): Promise<CategoryOut> {
  return api<CategoryOut>("/admin/categories", { method: "POST", query: { store_id: storeId }, body: data })
}

export function updateCategory(categoryId: number, data: CategoryUpdateIn): Promise<CategoryOut> {
  return api<CategoryOut>(`/admin/categories/${categoryId}`, { method: "PATCH", body: data })
}

// ---------------------------------------------------------------------------
// Admin: productos.
// ---------------------------------------------------------------------------

export function listProducts(
  storeId: number,
  params?: { categoryId?: number; search?: string }
): Promise<ProductAdminOut[]> {
  return api<ProductAdminOut[]>("/admin/products", {
    query: { store_id: storeId, category_id: params?.categoryId, search: params?.search },
  })
}

export function createProduct(storeId: number, data: ProductIn): Promise<ProductAdminOut> {
  return api<ProductAdminOut>("/admin/products", { method: "POST", query: { store_id: storeId }, body: data })
}

export function updateProduct(productId: number, data: ProductUpdateIn): Promise<ProductAdminOut> {
  return api<ProductAdminOut>(`/admin/products/${productId}`, { method: "PATCH", body: data })
}

export function setProductAvailability(
  productId: number,
  data: ProductAvailabilityIn
): Promise<ProductAdminOut> {
  return api<ProductAdminOut>(`/products/${productId}/availability`, { method: "POST", body: data })
}

// ---------------------------------------------------------------------------
// Admin: grupos de modificadores.
// ---------------------------------------------------------------------------

export function listModifierGroups(productId: number): Promise<ModifierGroupOut[]> {
  return api<ModifierGroupOut[]>("/admin/modifier-groups", { query: { product_id: productId } })
}

export function createModifierGroup(
  productId: number,
  data: ModifierGroupIn
): Promise<ModifierGroupOut> {
  return api<ModifierGroupOut>("/admin/modifier-groups", {
    method: "POST",
    query: { product_id: productId },
    body: data,
  })
}

export function updateModifierGroup(
  groupId: number,
  data: ModifierGroupUpdateIn
): Promise<ModifierGroupOut> {
  return api<ModifierGroupOut>(`/admin/modifier-groups/${groupId}`, { method: "PATCH", body: data })
}

export function setModifierOptionAvailability(
  optionId: number,
  available: boolean
): Promise<{ id: number; available: boolean }> {
  return api(`/modifier-options/${optionId}/availability`, { method: "POST", body: { available } })
}

// ---------------------------------------------------------------------------
// Admin: combos y menú del día.
// ---------------------------------------------------------------------------

export function listCombos(storeId: number): Promise<ComboAdminOut[]> {
  return api<ComboAdminOut[]>("/admin/combos", { query: { store_id: storeId } })
}

export function createCombo(storeId: number, data: ComboIn): Promise<ComboAdminOut> {
  return api<ComboAdminOut>("/admin/combos", { method: "POST", query: { store_id: storeId }, body: data })
}

export function updateCombo(comboId: number, data: ComboUpdateIn): Promise<ComboAdminOut> {
  return api<ComboAdminOut>(`/admin/combos/${comboId}`, { method: "PATCH", body: data })
}

export function setComboToday(comboId: number, activeOptionIds: number[]): Promise<ComboAdminOut> {
  return api<ComboAdminOut>(`/admin/combos/${comboId}/today`, {
    method: "PUT",
    body: { active_option_ids: activeOptionIds },
  })
}

export function setComboOptionAvailability(
  optionId: number,
  available: boolean
): Promise<{ id: number; available_today: boolean }> {
  return api(`/combo-options/${optionId}/availability`, { method: "POST", body: { available } })
}
