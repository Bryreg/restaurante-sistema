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
  /** «C.C.», «NIT»… en vez del código DIAN. */
  doc_type_label?: string | null;
  /** Adquirente genérico («222222222222»): el papel no repite el número. */
  final_consumer?: boolean;
  doc_number?: string;
  name?: string;
  email?: string | null;
  address?: string | null;
  municipality_dane?: string | null;
}

export interface DocumentOrderRef {
  id?: number;
  channel?: string;
  /** «Mesa», «Mostrador»… — lo que se imprime en vez del código. */
  channel_label?: string | null;
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

/** Rango DIAN que amparó el consecutivo (`GET /admin/fiscal/documents/{id}/evidence` trae más detalle). */
export interface DocumentFiscalRangeRef {
  id?: number;
  prefix?: string;
  from_number?: number;
  to_number?: number;
  resolution_number?: string;
  valid_until?: string;
}

/**
 * A-11 (`features/fase-1b-venta/outputs-1b-1/auditor-venta.md §3`): acá va
 * lo que en 1b-2 hace variar la leyenda — estado DIAN y contingencia — más
 * el rango vigente. `DocumentPrintable.legend` en sí SIEMPRE sale ya
 * redactada del servidor (nunca se arma un texto legal en el cliente).
 */
export interface DocumentFiscalInfo {
  dian_status?: string | null;
  cude?: string | null;
  qr_url?: string | null;
  contingency?: boolean;
  range?: DocumentFiscalRangeRef | null;
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

export interface AdminDocumentsQuery {
  storeId: number;
  from?: string;
  to?: string;
  /** Pedido 1b-2: `GET /admin/documents` ahora también acepta `type`/`status`. */
  type?: string;
  status?: string;
}

export function adminListDocuments(params: AdminDocumentsQuery): Promise<AdminDocumentListItem[]> {
  return api<AdminDocumentListItem[]>("/admin/documents", {
    query: {
      store_id: params.storeId,
      from: params.from,
      to: params.to,
      type: params.type,
      status: params.status,
    },
  });
}

/** URL directa (con `format=csv`) — mismo patrón que `adminOrdersCsvUrl`. */
export function adminDocumentsCsvUrl(params: AdminDocumentsQuery): string {
  const query = new URLSearchParams();
  query.set("format", "csv");
  query.set("store_id", String(params.storeId));
  if (params.from) query.set("from", params.from);
  if (params.to) query.set("to", params.to);
  if (params.type) query.set("type", params.type);
  if (params.status) query.set("status", params.status);
  return `/api/v1/admin/documents?${query.toString()}`;
}
