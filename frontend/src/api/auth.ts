/**
 * Identidad: admin (correo/contraseña), dispositivo (PIN de sede) y persona
 * (PIN de 4 dígitos). Rutas exactas de `features/fase-1a-cimientos/spec.md`
 * § "Auth & identity". Todo campo nuevo de una respuesta es opcional acá
 * (AGENTS.md § Reglas propias) — si el backend todavía no lo manda, no
 * puede romper un tipo que lo exige.
 */
import { api } from "./client";

export interface UserOut {
  id: number;
  name: string;
  role: string;
}

export interface OrganizationOut {
  id: number;
  name: string;
}

export interface StoreBrief {
  id: number;
  name: string;
  cutoff_hour: number;
  active_channels: string[];
}

export interface EmployeeBrief {
  id: number;
  name: string;
  role: string;
  can_charge: boolean;
  discount_limit_pct?: number | null;
  /** Dónde trabaja en el POS (inicio por rol). `null`/ausente = ve todo. */
  puesto?: Puesto | null;
}

/** `employees.puesto`: caja, salón, cocina o bar (0027). */
export type Puesto = "caja" | "salon" | "cocina" | "bar";

/** La entrada del día de una persona (asistencia, separada del turno de caja). */
export interface AttendanceBrief {
  id: number;
  business_date: string;
  in_at: string;
  /** Sólo en `identify`: `true` si este PIN acaba de marcar la entrada. */
  created?: boolean;
}

/** `GET /auth/me` — la sesión completa, con los flags vigentes de la sede. */
export interface Me {
  kind: "admin" | "device";
  user?: UserOut | null;
  store?: StoreBrief | null;
  employee?: EmployeeBrief | null;
  employee_expires_at?: string | null;
  /** Sólo dispositivo: la última persona que se identificó en esta tablet. */
  last_employee_id?: number | null;
  /** Sólo dispositivo: la entrada abierta de hoy de la persona identificada (asistencia). */
  employee_attendance?: AttendanceBrief | null;
  /** Sólo admin: la sesión se abrió desde una tablet del salón (corta; al salir vuelve el POS). */
  on_device?: boolean | null;
  /** Sólo admin: cuándo vence la sesión. */
  session_expires_at?: string | null;
  organization?: OrganizationOut | null;
  features?: Record<string, boolean> | null;
}

export function getMe(): Promise<Me> {
  return api<Me>("/auth/me");
}

export interface AdminLoginIn {
  email: string;
  password: string;
}

export interface AdminLoginOut {
  user: UserOut;
  organization: OrganizationOut;
}

/** La cookie `httpOnly` la pone el servidor; el frontend no toca sesión. */
export function adminLogin(body: AdminLoginIn): Promise<AdminLoginOut> {
  return api<AdminLoginOut>("/auth/admin/login", { method: "POST", body });
}

export function logout(): Promise<void> {
  return api<void>("/auth/logout", { method: "POST" });
}

export interface DeviceActivateIn {
  store_id: number;
  store_pin: string;
}

export interface DeviceActivateOut {
  store: StoreBrief;
}

export function deviceActivate(body: DeviceActivateIn): Promise<DeviceActivateOut> {
  return api<DeviceActivateOut>("/auth/device/activate", { method: "POST", body });
}

export interface DeviceIdentifyIn {
  employee_id: number;
  pin: string;
}

export interface DeviceIdentifyOut {
  employee: EmployeeBrief;
  /** `null` para el administrador: en la tablet sólo autoriza, no lleva asistencia. */
  attendance?: AttendanceBrief | null;
}

export function deviceIdentify(body: DeviceIdentifyIn): Promise<DeviceIdentifyOut> {
  return api<DeviceIdentifyOut>("/auth/device/identify", { method: "POST", body });
}

/** "Cambiar de persona": libera a la persona activa, el dispositivo sigue. */
export function deviceRelease(): Promise<void> {
  return api<void>("/auth/device/release", { method: "POST" });
}

export function deviceDeactivate(): Promise<void> {
  return api<void>("/auth/device/deactivate", { method: "POST" });
}

export interface AuthorizeIn {
  pin: string | null;
  action: string;
}

export interface AuthorizerOut {
  id: number;
  name: string;
  role: string;
}

export interface AuthorizeOut {
  authorizer: AuthorizerOut;
}

/** Autorización de un solo uso (PIN de supervisor o admin, según la acción). */
export function authorize(body: AuthorizeIn): Promise<AuthorizeOut> {
  return api<AuthorizeOut>("/auth/authorize", { method: "POST", body });
}
