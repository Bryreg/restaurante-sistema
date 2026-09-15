/**
 * Comprobante interno de venta (`fiscal_document`, hoy `type: "pos_equivalent"`
 * o `"internal_receipt"`, `dian_status: "pending"` — nada se emite ni se
 * transmite en 1b-1). Representación imprimible, último documento de la
 * sede, reimpresión contada y la lista mínima de admin.
 * `features/fase-1b-venta/CONTRATO-INTERNO-1b-1.md` §2.4.
 *
 * Todo campo de `DocumentPrintable` es opcional o `| null` (AGENTS.md §
 * convenciones de frontend) — este archivo sólo tipa y transporta lo que el
 * servidor decide, nunca recalcula un total ni una tarifa.
 */
import { api } from "@/api/client";

export interface DocumentStoreRef {
  legal_name?: string;
  nit?: string | null;
  dv?: string | null;
  address?: string | null;
  municipality_dane?: string | null;
}

export interface DocumentCustomerRef {
  doc_type?: string;
  doc_number?: string;
  name?: string;
}

export interface DocumentOrderRef {
  id?: number;
  channel?: string;
  tables?: string[];
  covers?: number | null;
  served_by?: string | null;
  charged_by?: string | null;
}

export interface DocumentTaxLine {
  rate?: number;
  base?: number;
  tax?: number;
}

export interface DocumentLine {
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

/** Línea de propina APARTE de la venta — nunca se suma a `total` (SPEC §6.2). */
export interface DocumentTipInfo {
  amount?: number;
  suggested_pct?: number;
  accepted?: boolean;
  modified?: boolean;
}

export interface DocumentPaymentLine {
  method?: string;
  label?: string;
  dian_code?: string;
  amount?: number;
  tip_amount?: number;
  tendered?: number | null;
  change?: number | null;
  reference?: string | null;
}

export interface DocumentReprintEntry {
  at?: string;
  by?: string;
}

/** Todo `null` en 1b-1: los rangos DIAN, el CUDE y el QR son de 1b-2. */
export interface DocumentFiscalInfo {
  range?: unknown | null;
  cude?: string | null;
  qr_url?: string | null;
}

export interface DocumentPrintable {
  id: number;
  document_type?: string;
  type_label?: string;
  prefix?: string;
  number?: number;
  /** "POS-000123". */
  full_number?: string;
  dian_status?: string | null;
  /** Leyenda del documento tal cual la manda el servidor — nunca se reescribe. */
  legend?: string;
  business_date?: string;
  issued_at?: string;
  store?: DocumentStoreRef;
  customer?: DocumentCustomerRef;
  order?: DocumentOrderRef;
  lines?: DocumentLine[];
  subtotal?: number;
  discount_total?: number;
  tax_lines?: DocumentTaxLine[];
  tax_total?: number;
  total?: number;
  tip?: DocumentTipInfo | null;
  payments?: DocumentPaymentLine[];
  change?: number;
  print_count?: number;
  reprint_count?: number;
  reprints?: DocumentReprintEntry[];
  fiscal?: DocumentFiscalInfo;
}

export function getDocument(documentId: number): Promise<DocumentPrintable> {
  return api<DocumentPrintable>(`/documents/${documentId}`);
}

/** El último documento emitido en la sede, o `null` si todavía no hay ninguno. */
export function getLastDocument(): Promise<DocumentPrintable | null> {
  return api<DocumentPrintable | null>("/documents/last");
}

export function reprintDocument(documentId: number): Promise<DocumentPrintable> {
  return api<DocumentPrintable>(`/documents/${documentId}/reprint`, { method: "POST" });
}

export interface AdminDocumentListItem {
  id: number;
  full_number?: string;
  document_type?: string;
  dian_status?: string | null;
  business_date?: string;
  issued_at?: string;
  order_id?: number;
  total?: number;
  tip_amount?: number;
  charged_by?: string;
}

export function adminListDocuments(params: {
  storeId: number;
  from?: string;
  to?: string;
}): Promise<AdminDocumentListItem[]> {
  return api<AdminDocumentListItem[]>("/admin/documents", {
    query: { store_id: params.storeId, from: params.from, to: params.to },
  });
}
