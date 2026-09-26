/**
 * CRUD de empleados (Admin → Configuración → Empleados). El PIN nunca vuelve
 * en una respuesta (AGENTS.md, checklist § pedido 1a); la baja es lógica
 * (`active=false`), nunca un `DELETE`.
 */
import type { Puesto } from "./auth";
import { api } from "./client";

export type EmployeeRole = "operator" | "supervisor" | "admin";

export interface Employee {
  id: number;
  name: string;
  role: EmployeeRole;
  store_id: number | null;
  can_charge: boolean;
  /** Inicio por rol: dónde trabaja en el POS; `null` = ve todo. */
  puesto?: Puesto | null;
  discount_limit_pct: number | null;
  document?: string | null;
  email?: string | null;
  active: boolean;
}

export interface EmployeeCreateIn {
  name: string;
  role: EmployeeRole;
  pin: string;
  store_id?: number | null;
  can_charge?: boolean;
  puesto?: Puesto | null;
  discount_limit_pct?: number | null;
  document?: string | null;
  email?: string | null;
  password?: string | null;
}

export interface EmployeeUpdateIn {
  name?: string;
  role?: EmployeeRole;
  pin?: string;
  store_id?: number | null;
  can_charge?: boolean;
  puesto?: Puesto | null;
  discount_limit_pct?: number | null;
  document?: string | null;
  email?: string | null;
  password?: string | null;
  active?: boolean;
}

export function listEmployees(params: { storeId?: number | null; active?: boolean | null } = {}): Promise<
  Employee[]
> {
  return api<Employee[]>("/admin/employees", {
    query: { store_id: params.storeId ?? undefined, active: params.active ?? undefined },
  });
}

export function createEmployee(body: EmployeeCreateIn): Promise<Employee> {
  return api<Employee>("/admin/employees", { method: "POST", body });
}

export function updateEmployee(employeeId: number, body: EmployeeUpdateIn): Promise<Employee> {
  return api<Employee>(`/admin/employees/${employeeId}`, { method: "PATCH", body });
}

/** Baja lógica: PATCH con `active: false` (nunca hay un DELETE de empleado). */
export function deactivateEmployee(employeeId: number): Promise<Employee> {
  return updateEmployee(employeeId, { active: false });
}

// ---------------------------------------------------------------------------
// Personal del dispositivo — "Quién opera" (SPEC-NEGOCIO §9.1, A-9 de 1a;
// CONTRATO-INTERNO-1b-1.md §2.4 y §7 orden de arranque). `GET
// /device/employees` (la escribe `backend-base`) devuelve SOLO estos tres
// campos del personal activo de la sede del dispositivo (más los admins de
// la organización): nunca `document`, `email`, `discount_limit_pct` ni
// `can_charge`. Es el tipo que consume `EmployeePicker`.
// ---------------------------------------------------------------------------

export interface DeviceEmployee {
  id: number;
  name: string;
  role: EmployeeRole;
}

export function listDeviceEmployees(): Promise<DeviceEmployee[]> {
  return api<DeviceEmployee[]>("/device/employees");
}
