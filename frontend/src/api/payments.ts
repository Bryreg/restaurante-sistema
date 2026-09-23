/**
 * Cobro de la comanda: pagos mixtos, propina y el documento emitido.
 * Tipado contra `features/fase-1b-venta/CONTRATO-INTERNO-1b-1.md` §2.4
 * ("Cobro y comprobante") — el contrato vinculante de este pedido — y
 * `backend/app/payments/schemas.py` cuando ya existe (territorio de
 * `backend-cobro`, en construcción en paralelo a este archivo).
 *
 * Todo campo de `PaymentOut` es opcional o `| null` (AGENTS.md § convenciones
 * de frontend): un backend que todavía no lo manda no puede romper esta
 * pantalla. `PaymentIn` es estricto: es un payload que este código construye.
 *
 * Como el resto del frontend, `payOrder` nunca calcula plata: pinta
 * `PaymentOut.change` y `PaymentOut.total` tal como llegan
 * (CONTRATO-INTERNO §6.1, "una sola matemática, en el backend").
 */
import { api } from "@/api/client";
import type { OrderOut } from "@/api/orders";

/**
 * Los seis medios de pago del contrato (§2.2 modelos de `backend-cobro`,
 * `class PaymentMethod`). El backend valida cada `method` contra
 * `StoreSalesSettings.payment_methods[].code` con `enabled=True`: esta
 * lista es fija (los seis códigos posibles), no la disponibilidad real de la
 * sede — no hay todavía una ruta de dispositivo para leerla (gap declarado
 * en el entregable).
 */
export type PaymentMethod = "cash" | "card" | "transfer" | "platform" | "voucher" | "other";

export const PAYMENT_METHOD_LABEL: Record<PaymentMethod, string> = {
  cash: "Efectivo",
  card: "Tarjeta",
  transfer: "Transferencia",
  platform: "Plataforma",
  voucher: "Bono",
  other: "Otro",
};

export const PAYMENT_METHODS: PaymentMethod[] = ["cash", "card", "transfer", "platform", "voucher", "other"];

/**
 * Medio de pago habilitado en la sede (`GET /device/payment-methods`, pedido
 * 1b-2 — gap de 1b-1: el POS ofrecía siempre los seis códigos fijos de
 * `PAYMENT_METHODS`, aunque la sede hubiera deshabilitado alguno). Nunca
 * trae `cost`/`margin` (AGENTS.md, "el operador no recibe costos").
 */
export interface DevicePaymentMethod {
  code: PaymentMethod;
  label: string;
  dian_code: string;
  requires_reference: boolean;
}

export function listDevicePaymentMethods(): Promise<DevicePaymentMethod[]> {
  return api<DevicePaymentMethod[]>("/device/payment-methods");
}

export interface PaymentSplitIn {
  method: PaymentMethod;
  /** Pesos, entero. */
  amount: number;
  /** Sólo en `cash`: lo entregado por el cliente (`change` lo calcula el servidor). */
  tendered?: number;
  reference?: string;
}

export interface PaymentTipIn {
  asked: boolean;
  accepted: boolean;
  modified: boolean;
  /** Pesos, entero; `0` si no se aceptó propina. */
  amount: number;
}

/**
 * Prueba de habeas data (Ley 1581 de 2012, SPEC-NEGOCIO §8.4): finalidad
 * declarada, canal y versión de texto. El dispositivo sólo la crea al
 * cobrar; el admin la administra (`src/api/customers.ts`).
 */
export interface CustomerConsentIn {
  text_version: string;
  channel: string;
}

/**
 * `customer?` de `POST /orders/{id}/payments` (SPEC-NEGOCIO §8.3, §8.4): el
 * dispositivo sólo CREA clientes al cobrar. `consent` es obligatorio en
 * cuanto se manda `customer` — proveer los datos para pedir factura ES el
 * acto de autorizar esa finalidad.
 */
export interface CustomerIn {
  doc_type: string;
  doc_number: string;
  dv?: string;
  name: string;
  email?: string;
  address?: string;
  municipality_dane?: string;
  consent: CustomerConsentIn;
}

export interface PaymentIn {
  /** Versión optimista de la comanda (o de la sub-cuenta, si aplica igual). */
  expected_version?: number;
  sub_account_id?: number;
  /** PIN propio de quien cobra — se vuelve a pedir aunque haya persona activa. */
  pin: string;
  /** Ausente u omitido si `pos.tips` está apagada. */
  tip?: PaymentTipIn;
  splits: PaymentSplitIn[];
  /** Sólo si el cliente pide factura o queda identificado por otra razón. */
  customer?: CustomerIn;
  /** Fuerza `invoice` aunque el neto no supere `invoice_threshold_uvt` × UVT. */
  requests_invoice?: boolean;
}

export interface PaymentDocumentRef {
  id?: number;
  document_type?: string;
  prefix?: string;
  number?: number;
  /** "POS-000123". */
  full_number?: string;
  dian_status?: string | null;
  legend?: string;
  cude?: string | null;
  qr_url?: string | null;
  contingency?: boolean;
}

export interface PaymentOut {
  order_id?: number;
  sub_account_id?: number | null;
  /** `null` cuando el total es 0 (staff_meal o todo cortesía): no se emite documento. */
  document?: PaymentDocumentRef | null;
  total?: number;
  tip_amount?: number;
  /**
   * A-10 (`features/fase-1b-venta/outputs-1b-1/auditor-venta.md §3`): venta
   * + propina, YA sumadas por el servidor (`app/payments/schemas.py:106`,
   * `total + tip.amount`). Se pinta tal cual llega, nunca se recalcula acá
   * (`?? 0` sobre este campo está prohibido: si falta, `formatCOP(null)`
   * muestra «—», no «$0»).
   */
  amount_due?: number;
  requires_invoice?: boolean;
  /** Sólo si hubo `cash` con `tendered`; el frontend nunca lo calcula. */
  change?: number;
  paid_at?: string;
  order?: OrderOut;
}

export function payOrder(orderId: number, body: PaymentIn, idempotencyKey: string): Promise<PaymentOut> {
  return api<PaymentOut>(`/orders/${orderId}/payments`, { method: "POST", body, idempotencyKey });
}

/**
 * El vuelto ANTES de cobrar (`POST /payments/change-preview`): la caja lo
 * pide mientras teclea lo recibido, para decírselo al cliente. La cuenta la
 * hace el servidor con la misma función del cobro; esta pantalla sólo la
 * pinta. `change: null` = lo recibido no alcanza (no es un vuelto de 0).
 */
export interface ChangePreviewSplit {
  change: number | null;
  short_by: number | null;
}

export interface ChangePreviewOut {
  splits: ChangePreviewSplit[];
  change_total: number;
}

export function previewChange(splits: { amount: number; tendered: number }[]): Promise<ChangePreviewOut> {
  return api<ChangePreviewOut>("/payments/change-preview", { method: "POST", body: { splits } });
}
