/**
 * Maestro de clientes y habeas data (Ley 1581 de 2012, SPEC-NEGOCIO §8.4).
 * El dispositivo sólo crea clientes al cobrar (vía `PaymentIn.customer`,
 * `src/api/payments.ts`); este archivo es exclusivamente admin. Tipado
 * campo por campo contra `backend/app/customers/{router,schemas}.py`
 * (real, no en construcción — `features/fase-1b-venta/outputs-1b-2/
 * backend-clientes-dinero.md`).
 *
 * Todo campo de una respuesta es opcional o `| null` (AGENTS.md § frontend).
 * Ningún número acá es plata.
 *
 * GAP declarado (ver entregable): `app.customers`/`app.refunds` todavía no
 * están en `app.main.DOMAINS` ni en `app.core.models_registry.MODEL_MODULES`
 * (fuera del territorio de cualquier agente de este pedido — ver
 * `outputs-1b-2/backend-clientes-dinero.md § 6`), así que estas rutas
 * pueden no estar montadas en la app real todavía; contra un backend con
 * ese wiring pendiente, cualquier llamada de acá responde `404`.
 */
import { api } from "@/api/client";

export interface CustomerOut {
  id: number;
  doc_type?: string;
  doc_number?: string;
  dv?: string | null;
  name?: string;
  email?: string | null;
  address?: string | null;
  municipality_dane?: string | null;
  created_at?: string;
  updated_at?: string;
  /** No nulo cuando ya se anonimizó (`erase`); el snapshot del documento fiscal queda intacto. */
  erased_at?: string | null;
}

/** No permite tocar `doc_type`/`doc_number` (backend: cambiar el documento es, en los hechos, otra persona). */
export interface CustomerPatchIn {
  name?: string;
  email?: string | null;
  address?: string | null;
  municipality_dane?: string | null;
  dv?: string | null;
}

export type ConsentPurpose = "invoice" | "marketing";

export interface ConsentIn {
  purpose: ConsentPurpose;
  granted: boolean;
  channel: string;
  text_version: string;
}

export interface ConsentOut {
  id: number;
  purpose?: ConsentPurpose;
  granted?: boolean;
  channel?: string;
  text_version?: string;
  registered_by_employee_id?: number | null;
  registered_by_employee_name?: string | null;
  at?: string;
}

export type DataRequestKind = "access" | "rectify" | "revoke" | "erase";

export interface DataRequestOut {
  id: number;
  kind?: DataRequestKind;
  note?: string | null;
  response?: string | null;
  requested_at?: string;
  responded_at?: string | null;
  employee_id?: number | null;
  employee_name?: string | null;
}

export interface EraseIn {
  reason: string;
}

/** Gate `customers` — `400 FEATURE_DISABLED` si la sede la tiene apagada. */
export function listCustomers(params: { docNumber?: string } = {}): Promise<CustomerOut[]> {
  return api<CustomerOut[]>("/admin/customers", { query: { doc_number: params.docNumber } });
}

export function customersCsvUrl(params: { docNumber?: string } = {}): string {
  const query = new URLSearchParams();
  query.set("format", "csv");
  if (params.docNumber) query.set("doc_number", params.docNumber);
  return `/api/v1/admin/customers?${query.toString()}`;
}

/** Gate `customers`; `400 CUSTOMER_ERASED` sobre un cliente ya anonimizado. */
export function patchCustomer(customerId: number, body: CustomerPatchIn): Promise<CustomerOut> {
  return api<CustomerOut>(`/admin/customers/${customerId}`, { method: "PATCH", body });
}

/** Gate `customers`; `400 CUSTOMER_ERASED`. Nunca edita un consentimiento anterior: agrega evidencia nueva. */
export function addCustomerConsent(customerId: number, body: ConsentIn): Promise<ConsentOut> {
  return api<ConsentOut>(`/admin/customers/${customerId}/consents`, { method: "POST", body });
}

/** Sin gate: derecho legal, nunca se apaga. */
export function listCustomerRequests(customerId: number): Promise<DataRequestOut[]> {
  return api<DataRequestOut[]>(`/admin/customers/${customerId}/requests`);
}

export function customerRequestsCsvUrl(customerId: number): string {
  return `/api/v1/admin/customers/${customerId}/requests?format=csv`;
}

/**
 * Sin gate: derecho legal, nunca se apaga. Anonimiza el maestro y deja
 * INTACTO el snapshot del documento fiscal ya emitido — un documento
 * emitido es inmutable (AGENTS.md). Idempotente: llamarlo de nuevo sobre un
 * cliente ya anonimizado no cambia nada.
 */
export function eraseCustomer(customerId: number, body: EraseIn): Promise<CustomerOut> {
  return api<CustomerOut>(`/admin/customers/${customerId}/erase`, { method: "POST", body });
}
