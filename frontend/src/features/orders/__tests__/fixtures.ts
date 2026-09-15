/**
 * Fixtures de `OrderOut`, `TablesStatusOut`, rondas de cocina y `Me` de
 * dispositivo — CONTRATO-INTERNO-1b-1.md §6.3 "Tests". Cada builder acepta
 * overrides parciales para no repetir el objeto completo en cada test.
 */
import type { Me } from "@/api/auth"
import type { CatalogComboOut, CatalogOut, CatalogProductOut } from "@/api/catalog"
import type { KitchenRoundOut } from "@/api/kitchen"
import type { OrderItemOut, OrderOut, TablesStatusOut } from "@/api/orders"

export function buildOrderItem(overrides: Partial<OrderItemOut> = {}): OrderItemOut {
  return {
    id: 1,
    product_id: 10,
    combo_id: null,
    name: "Limonada de coco",
    qty: 1,
    seat: null,
    course: "beverage",
    station: "bar",
    list_price: 8000,
    unit_price: 8000,
    tax_code: "inc_8",
    tax_rate: 8,
    modifiers: [],
    modifiers_text: null,
    combo_selections: null,
    note: null,
    status: "pending",
    round_no: null,
    sent_at: null,
    ready_at: null,
    served_at: null,
    sent_at_payment: false,
    gross: 8000,
    discount: 0,
    net: 8000,
    tax: 593,
    courtesy: null,
    void: null,
    ...overrides,
  }
}

export function buildOrder(overrides: Partial<OrderOut> = {}): OrderOut {
  return {
    id: 501,
    version: 1,
    channel: "dine_in",
    status: "open",
    business_date: "2026-09-15",
    shift_id: 7,
    tables: [{ id: 3, number: "5", zone_name: "Salón" }],
    covers: 4,
    note: null,
    takeout: null,
    consumed_by: null,
    opened_by: { id: 2, name: "Ana" },
    opened_at: "2026-09-15T18:00:00Z",
    bill_presented_at: null,
    bill_print_count: 0,
    paid_at: null,
    closed_at: null,
    paid_by: null,
    voided_at: null,
    void_reason: null,
    merged_into_order_id: null,
    transferred_from_shift_id: null,
    kitchen_view_enabled: true,
    split_parts: null,
    rounds: [],
    items: [buildOrderItem()],
    discounts: [],
    sub_accounts: [],
    totals: { subtotal: 8000, discount_total: 0, tax_lines: [{ rate: 8, base: 7407, tax: 593 }], tax_total: 593, total: 8000 },
    tip: { base: 7407, suggested_pct: 10, suggested_amount: 741 },
    document_id: null,
    ...overrides,
  }
}

export function buildTablesStatus(overrides: Partial<TablesStatusOut> = {}): TablesStatusOut {
  return {
    zones: [
      {
        id: 1,
        name: "Salón",
        tables: [
          { id: 1, number: "1", seats: 4, status: "free" },
          { id: 2, number: "2", seats: 2, status: "occupied", order_id: 501, opened_at: "2026-09-15T18:00:00Z", covers: 2, total: 25000 },
          { id: 3, number: "3", seats: 4, status: "to_pay", order_id: 502, opened_at: "2026-09-15T17:00:00Z", covers: 3, total: 40000 },
        ],
      },
    ],
    ...overrides,
  }
}

export function buildKitchenRound(overrides: Partial<KitchenRoundOut> = {}): KitchenRoundOut {
  return {
    order_id: 501,
    round_no: 1,
    sent_at: "2026-09-15T18:05:00Z",
    elapsed_seconds: 300,
    channel: "dine_in",
    tables: ["5"],
    takeout_name: null,
    covers: 4,
    items: [
      {
        item_id: 1,
        name: "Limonada de coco",
        qty: 1,
        modifiers_text: null,
        note: null,
        course: "beverage",
        station: "bar",
        status: "sent",
        elapsed_seconds: 300,
        target_minutes: 10,
        semaphore: "green",
      },
    ],
    ...overrides,
  }
}

export function buildCatalogProduct(overrides: Partial<CatalogProductOut> = {}): CatalogProductOut {
  return {
    id: 10,
    category_id: 1,
    name: "Limonada de coco",
    description: null,
    station: "bar",
    default_course: "beverage",
    prices: { dine_in: 8000, takeout: 8000, delivery: 8000, platform: 8000 },
    tax_code: "inc_8",
    available: true,
    daily_count: null,
    daily_remaining: null,
    modifier_groups: [],
    ...overrides,
  }
}

export function buildCatalogCombo(overrides: Partial<CatalogComboOut> = {}): CatalogComboOut {
  return {
    id: 20,
    name: "Menú ejecutivo",
    price: 22000,
    active_now: true,
    schedule: { days: [0, 1, 2, 3, 4], from: "12:00", to: "15:00" },
    groups: [
      {
        id: 1,
        name: "Plato fuerte",
        sort_order: 1,
        options: [
          { id: 100, name: "Pollo", product_id: 10, available_today: true },
          { id: 101, name: "Pescado", product_id: 11, available_today: true },
        ],
      },
    ],
    ...overrides,
  }
}

export function buildCatalog(overrides: Partial<CatalogOut> = {}): CatalogOut {
  return {
    categories: [{ id: 1, name: "Bebidas", sort_order: 1, active: true }],
    products: [buildCatalogProduct()],
    combos: [],
    ...overrides,
  }
}

export function deviceMe(features: Record<string, boolean> = {}, overrides: Partial<Me> = {}): Me {
  return {
    kind: "device",
    store: { id: 1, name: "Sede Centro", cutoff_hour: 6, active_channels: ["counter", "dine_in", "takeout"] },
    employee: { id: 2, name: "Ana", role: "operator", can_charge: false },
    employee_expires_at: null,
    organization: { id: 1, name: "Organización de prueba" },
    features,
    ...overrides,
  }
}

export function adminMe(features: Record<string, boolean> = {}): Me {
  return {
    kind: "admin",
    user: { id: 1, name: "Admin de prueba", role: "admin" },
    organization: { id: 1, name: "Organización de prueba" },
    features,
  }
}
