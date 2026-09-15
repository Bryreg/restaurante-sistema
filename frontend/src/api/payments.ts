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

export interface PaymentIn {
  /** Versión optimista de la comanda (o de la sub-cuenta, si aplica igual). */
  expected_version?: number;
  sub_account_id?: number;
  /** PIN propio de quien cobra — se vuelve a pedir aunque haya persona activa. */
  pin: string;
  /** Ausente u omitido si `pos.tips` está apagada. */
  tip?: PaymentTipIn;
  splits: PaymentSplitIn[];
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
  /** Sólo si hubo `cash` con `tendered`; el frontend nunca lo calcula. */
  change?: number;
  paid_at?: string;
  order?: OrderOut;
}

export function payOrder(orderId: number, body: PaymentIn, idempotencyKey: string): Promise<PaymentOut> {
  return api<PaymentOut>(`/orders/${orderId}/payments`, { method: "POST", body, idempotencyKey });
}
