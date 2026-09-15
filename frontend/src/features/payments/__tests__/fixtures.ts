/**
 * Fixtures de `OrderOut`/`PreBillOut`/`DocumentPrintable` para los tests de
 * `frontend-cobro` (CONTRATO-INTERNO-1b-1.md §2.4, §6.3 "Tests"). Sólo estos
 * tres archivos (`api/orders.ts`, `api/payments.ts`, `api/documents.ts`)
 * definen la forma; acá sólo se arman objetos de ejemplo.
 */
import type { DocumentPrintable } from "@/api/documents";
import type { OrderOut, PreBillOut } from "@/api/orders";
import type { PaymentOut } from "@/api/payments";

export function buildOrder(overrides: Partial<OrderOut> = {}): OrderOut {
  return {
    id: 42,
    version: 3,
    channel: "dine_in",
    status: "open",
    business_date: "2026-09-15",
    shift_id: 1,
    tables: [{ id: 1, number: "5", zone_name: "Salón" }],
    covers: 4,
    note: null,
    takeout: null,
    consumed_by: null,
    opened_by: { id: 7, name: "Ana" },
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
    rounds: [{ round_no: 1, sent_at: "2026-09-15T18:05:00Z", sent_at_payment: false }],
    items: [
      {
        id: 100,
        product_id: 10,
        combo_id: null,
        name: "Hamburguesa clásica",
        qty: 2,
        seat: null,
        course: "main",
        station: "grill",
        list_price: 25000,
        unit_price: 25000,
        tax_code: "inc_8",
        tax_rate: 8,
        modifiers: [],
        modifiers_text: null,
        combo_selections: null,
        note: null,
        status: "served",
        round_no: 1,
        sent_at: "2026-09-15T18:05:00Z",
        ready_at: "2026-09-15T18:15:00Z",
        served_at: "2026-09-15T18:16:00Z",
        sent_at_payment: false,
        gross: 50000,
        discount: 0,
        net: 50000,
        tax: 3704,
        courtesy: null,
        void: null,
      },
    ],
    discounts: [],
    sub_accounts: [],
    totals: {
      subtotal: 50000,
      discount_total: 0,
      tax_lines: [{ rate: 8, base: 46296, tax: 3704 }],
      tax_total: 3704,
      total: 50000,
    },
    tip: { base: 46296, suggested_pct: 10, suggested_amount: 4630 },
    document_id: null,
    ...overrides,
  };
}

export function buildPreBill(overrides: Partial<PreBillOut> = {}): PreBillOut {
  return {
    order_id: 42,
    version: 4,
    lines: [{ description: "Hamburguesa clásica", qty: 2, unit_price: 25000, gross: 50000, discount: 0, net: 50000 }],
    subtotal: 50000,
    discount_total: 0,
    tax_lines: [{ rate: 8, base: 46296, tax: 3704 }],
    tax_total: 3704,
    total: 50000,
    tip: { base: 46296, suggested_pct: 10, suggested_amount: 4630 },
    legend: "NO ES FACTURA — documento informativo",
    bill_presented_at: "2026-09-15T18:20:00Z",
    bill_print_count: 1,
    ...overrides,
  };
}

export function buildPaymentOut(overrides: Partial<PaymentOut> = {}): PaymentOut {
  return {
    order_id: 42,
    sub_account_id: null,
    document: {
      id: 900,
      document_type: "internal_receipt",
      prefix: "POS",
      number: 123,
      full_number: "POS-000123",
      dian_status: null,
      legend: "COMPROBANTE INTERNO — no es factura ni documento equivalente",
      cude: null,
      qr_url: null,
      contingency: false,
    },
    total: 50000,
    tip_amount: 4630,
    change: 0,
    paid_at: "2026-09-15T18:25:00Z",
    order: buildOrder({ status: "paid", version: 4, paid_at: "2026-09-15T18:25:00Z", document_id: 900 }),
    ...overrides,
  };
}

export function buildDocument(overrides: Partial<DocumentPrintable> = {}): DocumentPrintable {
  return {
    id: 900,
    document_type: "internal_receipt",
    type_label: "Comprobante interno",
    prefix: "POS",
    number: 123,
    full_number: "POS-000123",
    dian_status: null,
    legend: "COMPROBANTE INTERNO — no es factura ni documento equivalente",
    business_date: "2026-09-15",
    issued_at: "2026-09-15T18:25:00Z",
    store: {
      legal_name: "Restaurante Demo SAS",
      nit: "900123456",
      dv: "7",
      address: "Cra 1 # 2-34",
      municipality_dane: "05001",
    },
    customer: { doc_type: "13", doc_number: "222222222222", name: "Consumidor final" },
    order: {
      id: 42,
      channel: "dine_in",
      tables: ["5"],
      covers: 4,
      served_by: "Ana",
      charged_by: "Ana",
    },
    lines: [{ item_id: 100, qty: 2, description: "Hamburguesa clásica", unit_price: 25000, gross: 50000, discount: 0, net: 50000, tax_rate: 8, base: 46296, tax: 3704 }],
    subtotal: 50000,
    discount_total: 0,
    tax_lines: [{ rate: 8, base: 46296, tax: 3704 }],
    tax_total: 3704,
    total: 50000,
    tip: { amount: 4630, suggested_pct: 10, accepted: true, modified: false },
    payments: [{ method: "cash", label: "Efectivo", dian_code: "10", amount: 50000, tip_amount: 4630, tendered: 60000, change: 5370, reference: null }],
    change: 5370,
    print_count: 1,
    reprint_count: 0,
    reprints: [],
    fiscal: { range: null, cude: null, qr_url: null },
    ...overrides,
  };
}
