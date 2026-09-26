import { useQuery } from "@tanstack/react-query";
import { AlertCircle, ChevronDown, ChevronUp, Users } from "lucide-react";
import { useState } from "react";

import { listDeviceEmployees, type DeviceEmployee, type EmployeeRole } from "@/api/employees";
import { EmptyState } from "@/components/EmptyState";
import { Skeleton } from "@/components/ui/skeleton";
import { errorMessage } from "@/lib/errors";
import { cn } from "@/lib/utils";

export interface EmployeePickerProps {
  value: number | null;
  onChange: (id: number, employee: DeviceEmployee) => void;
  label: string;
  /** Si viene, sólo muestra personal con alguno de estos roles. */
  roles?: string[];
  /** Ids que nunca se muestran (p. ej. el responsable actual en un relevo). */
  excludeIds?: number[];
  /**
   * Si viene con alguien, esas personas van primero y en grande (en el orden
   * dado) y el resto queda detrás de «Otra persona». Sin esto, la grilla de
   * siempre con todos.
   */
  destacados?: number[];
  disabled?: boolean;
}

const ROLE_LABEL: Record<EmployeeRole, string> = {
  operator: "Operador",
  supervisor: "Supervisor",
  admin: "Administrador",
};

function roleLabel(role: EmployeeRole | string): string {
  return ROLE_LABEL[role as EmployeeRole] ?? role;
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return `${parts[0]![0]}${parts[parts.length - 1]![0]}`.toUpperCase();
}

/**
 * "Quién opera" (SPEC-NEGOCIO §9.1): grilla de personal para elegir en un
 * toque, en vez de tipear un número de empleado. Carga `GET
 * /device/employees` (`["device","employees"]`, CONTRATO-INTERNO-1b-1.md
 * §6.2) — nunca recibe ni muestra documento, correo ni límites: el tipo
 * `DeviceEmployee` no los tiene.
 */
export function EmployeePicker({
  value,
  onChange,
  label,
  roles,
  excludeIds,
  destacados,
  disabled = false,
}: EmployeePickerProps): React.JSX.Element {
  const [verOtras, setVerOtras] = useState(false);
  const query = useQuery({
    queryKey: ["device", "employees"] as const,
    queryFn: listDeviceEmployees,
  });

  if (query.isLoading) {
    return (
      <div aria-label={label} aria-busy="true" className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {Array.from({ length: 6 }).map((_, index) => (
          <Skeleton key={index} className="h-20 w-full rounded-md" />
        ))}
      </div>
    );
  }

  if (query.isError) {
    return (
      <EmptyState
        role="alert"
        title="No se pudo cargar el personal"
        description={errorMessage(query.error)}
        icon={AlertCircle}
        action={{ label: "Reintentar", onClick: () => void query.refetch() }}
      />
    );
  }

  const excluded = new Set(excludeIds ?? []);
  const employees = (query.data ?? []).filter(
    (employee) => (!roles || roles.includes(employee.role)) && !excluded.has(employee.id),
  );

  if (employees.length === 0) {
    return <EmptyState title="No hay nadie disponible para elegir" icon={Users} />;
  }

  const orden = destacados ?? [];
  const primeros = orden
    .map((id) => employees.find((employee) => employee.id === id))
    .filter((employee): employee is DeviceEmployee => employee !== undefined);
  const idsPrimeros = new Set(primeros.map((employee) => employee.id));
  const resto = employees.filter((employee) => !idsPrimeros.has(employee.id));
  // Sin destacados (o ninguno en la lista) se ve la grilla de siempre. Si
  // la persona elegida está en «el resto», el resto se ve: nunca se esconde
  // lo que está marcado.
  const conDestacados = primeros.length > 0;
  const mostrarResto = !conDestacados || verOtras || resto.some((employee) => employee.id === value);

  function tarjeta(employee: DeviceEmployee, grande: boolean): React.JSX.Element {
    const checked = value === employee.id;
    return (
      <button
        key={employee.id}
        type="button"
        role="radio"
        aria-checked={checked}
        aria-label={`${employee.name}, ${roleLabel(employee.role)}`}
        disabled={disabled}
        onClick={() => onChange(employee.id, employee)}
        className={cn(
          "flex min-h-11 flex-col items-center gap-1.5 rounded-md border p-3 text-center transition-colors",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
          grande && "min-h-24 p-4",
          checked
            ? "border-primary bg-primary/10"
            : "border-border bg-background hover:bg-muted",
          disabled && "pointer-events-none opacity-50",
        )}
      >
        <span
          aria-hidden="true"
          className={cn(
            "flex size-10 items-center justify-center rounded-full bg-muted text-sm font-semibold",
            grande && "size-12 text-base",
          )}
        >
          {initials(employee.name)}
        </span>
        {/* El nombre completo, en varias líneas si hace falta: dos «Ana M…»
            iguales no se distinguen. */}
        <span className={cn("w-full text-sm font-medium break-words", grande && "text-base")}>{employee.name}</span>
        <span className="text-xs text-muted-foreground">{roleLabel(employee.role)}</span>
      </button>
    );
  }

  if (!conDestacados) {
    return (
      <div role="radiogroup" aria-label={label} className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {employees.map((employee) => tarjeta(employee, false))}
      </div>
    );
  }

  return (
    <div role="radiogroup" aria-label={label} className="space-y-3">
      <div className="grid grid-cols-2 gap-3">{primeros.map((employee) => tarjeta(employee, true))}</div>
      {resto.length > 0 ? (
        <>
          <button
            type="button"
            aria-expanded={mostrarResto}
            disabled={disabled}
            onClick={() => setVerOtras((prev) => !prev)}
            className="inline-flex min-h-11 items-center gap-2 rounded-md px-3 text-sm font-medium text-primary hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {mostrarResto ? (
              <ChevronUp className="size-4" aria-hidden="true" />
            ) : (
              <ChevronDown className="size-4" aria-hidden="true" />
            )}
            Otra persona
          </button>
          {mostrarResto ? (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              {resto.map((employee) => tarjeta(employee, false))}
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
