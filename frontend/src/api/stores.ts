/**
 * Admin → Configuración: organización, sedes, fiscal con vigencia, caja,
 * ventas, UVT, zonas y mesas. Rutas de `features/fase-1a-cimientos/spec.md`
 * § "Store & settings" y § "Zones, tables, employees".
 */
import { api } from "./client";

export type Profile = "basic" | "standard" | "full";

export interface OrganizationOut {
  id: number;
  name: string;
  profile: Profile;
  declared_not_obliged_to_invoice?: { at: string; by: string } | null;
}

export function getOrganization(): Promise<OrganizationOut> {
  return api<OrganizationOut>("/admin/organization");
}

export function updateOrganization(body: { name: string }): Promise<OrganizationOut> {
  return api<OrganizationOut>("/admin/organization", { method: "PATCH", body });
}

export interface OpeningHour {
  weekday: number;
  open: string;
  close: string;
}

export interface StoreOut {
  id: number;
  name: string;
  nit: string | null;
  dv: string | null;
  legal_name: string | null;
  address: string | null;
  municipality_dane: string | null;
  opening_hours: OpeningHour[];
  cutoff_hour: number;
  active_channels: string[];
  active: boolean;
}

export interface StoreCreateIn {
  name: string;
  nit?: string | null;
  dv?: string | null;
  legal_name?: string | null;
  address?: string | null;
  municipality_dane?: string | null;
  opening_hours?: OpeningHour[];
  cutoff_hour?: number;
  active_channels?: string[];
  store_pin: string;
}

export type StoreUpdateIn = Partial<Omit<StoreCreateIn, "store_pin">>;

export function listStores(): Promise<StoreOut[]> {
  return api<StoreOut[]>("/admin/stores");
}

export function createStore(body: StoreCreateIn): Promise<StoreOut> {
  return api<StoreOut>("/admin/stores", { method: "POST", body });
}

export function updateStore(storeId: number, body: StoreUpdateIn): Promise<StoreOut> {
  return api<StoreOut>(`/admin/stores/${storeId}`, { method: "PATCH", body });
}

export function rotateStorePin(storeId: number, newPin: string): Promise<{ ok: boolean }> {
  return api<{ ok: boolean }>(`/admin/stores/${storeId}/rotate-pin`, {
    method: "POST",
    body: { new_pin: newPin },
  });
}

export type PersonType = "natural" | "legal";
export type Regime = "ordinary" | "simple";
export type TaxCode = "inc_8" | "iva_19" | "excluded";

export interface FiscalConfig {
  id: number;
  valid_from: string;
  person_type: PersonType;
  regime: Regime;
  franchise: boolean;
  inc_responsible: boolean;
  iva_responsible: boolean;
  rut_codes: string[];
  price_includes_tax: boolean;
  default_tax: TaxCode;
}

export interface FiscalConfigIn {
  valid_from: string;
  person_type: PersonType;
  regime: Regime;
  franchise: boolean;
  inc_responsible: boolean;
  iva_responsible: boolean;
  rut_codes: string[];
  price_includes_tax: boolean;
  default_tax: TaxCode;
}

export function getFiscal(storeId: number): Promise<FiscalConfig> {
  return api<FiscalConfig>(`/admin/stores/${storeId}/fiscal`);
}

/** Cada cambio es una versión nueva con `valid_from`; nunca sobrescribe. */
export function setFiscal(storeId: number, body: FiscalConfigIn): Promise<FiscalConfig> {
  return api<FiscalConfig>(`/admin/stores/${storeId}/fiscal`, { method: "PUT", body });
}

export function getFiscalHistory(storeId: number): Promise<FiscalConfig[]> {
  return api<FiscalConfig[]>(`/admin/stores/${storeId}/fiscal/history`);
}

export interface CashSettings {
  opening_cash_fixed: number;
  cash_reserve_default: number;
  tolerance_unknown_cause: number;
  critical_difference: number;
  cash_pickup_threshold: number;
  petty_cash_limit: number;
  photo_required_on_close: boolean;
  photo_required_on_pickup: boolean;
  streak_alert_shifts: number;
}

export function getCashSettings(storeId: number): Promise<CashSettings> {
  return api<CashSettings>(`/admin/stores/${storeId}/cash-settings`);
}

export function setCashSettings(storeId: number, body: CashSettings): Promise<CashSettings> {
  return api<CashSettings>(`/admin/stores/${storeId}/cash-settings`, { method: "PUT", body });
}

export interface PaymentMethod {
  code: string;
  label: string;
  dian_code: string;
  enabled: boolean;
  requires_reference: boolean;
}

export interface SalesSettings {
  tip_suggested_pct: number;
  discount_limit_pct: number;
  discount_daily_limit_pct: number;
  courtesy_shift_limit: number;
  payment_methods: PaymentMethod[];
  void_reasons: string[];
  discount_reasons: string[];
  courtesy_reasons: string[];
  courses: string[];
  stations: string[];
  course_target_minutes: Record<string, number>;
}

export function getSalesSettings(storeId: number): Promise<SalesSettings> {
  return api<SalesSettings>(`/admin/stores/${storeId}/sales-settings`);
}

export function setSalesSettings(storeId: number, body: SalesSettings): Promise<SalesSettings> {
  return api<SalesSettings>(`/admin/stores/${storeId}/sales-settings`, { method: "PUT", body });
}

export interface UvtEntry {
  year: number;
  value: number;
}

export function listUvt(): Promise<UvtEntry[]> {
  return api<UvtEntry[]>("/admin/uvt");
}

export function setUvt(entries: UvtEntry[]): Promise<UvtEntry[]> {
  return api<UvtEntry[]>("/admin/uvt", { method: "PUT", body: entries });
}

export interface Zone {
  id: number;
  store_id: number;
  name: string;
  sort_order: number;
  active: boolean;
}

export function listZones(storeId: number): Promise<Zone[]> {
  return api<Zone[]>("/admin/zones", { query: { store_id: storeId } });
}

export function createZone(storeId: number, body: { name: string; sort_order?: number }): Promise<Zone> {
  return api<Zone>("/admin/zones", { method: "POST", query: { store_id: storeId }, body });
}

export function updateZone(
  zoneId: number,
  body: Partial<{ name: string; sort_order: number; active: boolean }>,
): Promise<Zone> {
  return api<Zone>(`/admin/zones/${zoneId}`, { method: "PATCH", body });
}

export interface Table {
  id: number;
  zone_id: number;
  store_id: number;
  number: string;
  seats: number;
  active: boolean;
}

export function listTables(storeId: number): Promise<Table[]> {
  return api<Table[]>("/admin/tables", { query: { store_id: storeId } });
}

export function createTable(body: { zone_id: number; number: string; seats?: number }): Promise<Table> {
  return api<Table>("/admin/tables", { method: "POST", body });
}

export function updateTable(
  tableId: number,
  body: Partial<{ zone_id: number; number: string; seats: number; active: boolean }>,
): Promise<Table> {
  return api<Table>(`/admin/tables/${tableId}`, { method: "PATCH", body });
}
