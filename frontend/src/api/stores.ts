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
  /** Días que la plata de un cierre puede quedarse sin consignar antes del aviso ámbar (0035). */
  deposit_overdue_days?: number | null;
  /**
   * Cómo abre el cajón (2026-09-26): `envelopes` = sólo los sobres por
   * consignar, y `cash_reserve_default` es el monto fijo de la base de
   * respaldo; `fixed_base` = la base fija de siempre (`opening_cash_fixed`).
   * Ausente al guardar = la sede conserva la que tenía.
   */
  opening_mode?: "envelopes" | "fixed_base" | null;
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
  /**
   * Los supuestos del panel del dueño (0032): las rayas de «barra + raya»
   * que son decisión del dueño. Margen meta en por ciento entero (65), mesa
   * larga y tiquete demorado en minutos, comandas por hora que alcanza un
   * mesero. El umbral de retiro es `CashSettings.cash_pickup_threshold`.
   */
  margin_target_pct: number;
  long_table_minutes: number;
  late_ticket_minutes: number;
  orders_per_waiter: number;
  /** Factura electrónica cuando el neto supera este número de UVT y el cliente está identificado. */
  invoice_threshold_uvt: number;
  /**
   * Configurables desde el panel (0035). Objetivo de cocina por estación
   * (minutos, ya resuelto contra los de fábrica), notas rápidas del POS por
   * curso (`_default` = la lista para el resto), sesión y bloqueo del PIN
   * (`null` = el de la variable de entorno, que viene en `*_default`) y el
   * mínimo de comandas debajo del cual un porcentaje de Informes es muestra
   * chica.
   */
  station_target_minutes: Record<string, number>;
  quick_notes: Record<string, string[]>;
  employee_session_minutes: number | null;
  pin_lock_attempts: number | null;
  pin_lock_minutes: number | null;
  period_low_base_orders: number;
  daily_low_base_orders: number;
  employee_session_minutes_default?: number;
  pin_lock_attempts_default?: number;
  pin_lock_minutes_default?: number;
}

export function getSalesSettings(storeId: number): Promise<SalesSettings> {
  return api<SalesSettings>(`/admin/stores/${storeId}/sales-settings`);
}

/** Los tres de seguridad de las tablets: los edita Ajustes › Seguridad, no Ventas. */
export const SECURITY_SETTINGS_KEYS = ["employee_session_minutes", "pin_lock_attempts", "pin_lock_minutes"] as const;
export type SecuritySettingsKey = (typeof SECURITY_SETTINGS_KEYS)[number];

/**
 * El `PUT` de la configuración de ventas. Los de seguridad pueden faltar: el
 * servidor conserva lo guardado (`CONFIG_FIELDS_KEPT_WHEN_ABSENT`), así Ventas
 * guarda lo suyo sin pisar lo que se cambió en Seguridad.
 */
export type SalesSettingsUpdate = Omit<SalesSettings, SecuritySettingsKey> & Partial<Pick<SalesSettings, SecuritySettingsKey>>;

export function setSalesSettings(storeId: number, body: SalesSettingsUpdate): Promise<SalesSettings> {
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

/**
 * Las notas rápidas del POS por curso (Ajustes › Ventas, 0035). Lectura de
 * dispositivo: sólo textos. `_default` es la lista para un curso sin lista
 * propia.
 */
export function getQuickNotes(): Promise<Record<string, string[]>> {
  return api<Record<string, string[]>>("/quick-notes");
}
