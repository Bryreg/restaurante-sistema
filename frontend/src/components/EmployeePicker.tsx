import { useQuery } from "@tanstack/react-query";
import { AlertCircle, Users } from "lucide-react";

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
  disabled = false,
}: EmployeePickerProps): React.JSX.Element {
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

  return (
    <div role="radiogroup" aria-label={label} className="grid grid-cols-2 gap-3 sm:grid-cols-3">
      {employees.map((employee) => {
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
              checked
                ? "border-primary bg-primary/10"
                : "border-border bg-background hover:bg-muted",
              disabled && "pointer-events-none opacity-50",
            )}
          >
            <span
              aria-hidden="true"
              className="flex size-10 items-center justify-center rounded-full bg-muted text-sm font-semibold"
            >
              {initials(employee.name)}
            </span>
            <span className="w-full truncate text-sm font-medium">{employee.name}</span>
            <span className="text-xs text-muted-foreground">{roleLabel(employee.role)}</span>
          </button>
        );
      })}
    </div>
  );
}
