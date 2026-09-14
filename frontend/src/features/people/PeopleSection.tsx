import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { useState } from "react";

import {
  createEmployee,
  deactivateEmployee,
  listEmployees,
  updateEmployee,
  type Employee,
  type EmployeeCreateIn,
  type EmployeeUpdateIn,
} from "@/api/employees";
import { EmptyState } from "@/components/EmptyState";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { errorMessage } from "@/lib/errors";

import { EmployeeFormDialog } from "./EmployeeFormDialog";

const ROLE_LABEL: Record<string, string> = {
  operator: "Operador",
  supervisor: "Supervisor",
  admin: "Administrador",
};

/**
 * Empleados: crear, editar, desactivar. El PIN nunca se muestra
 * (`app/auth/schemas.py::EmployeeOut` no lo incluye); la baja es lógica.
 */
export function PeopleSection({ storeId }: { storeId: number | null }): React.JSX.Element {
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: ["admin-employees"], queryFn: () => listEmployees() });
  const [editing, setEditing] = useState<Employee | "new" | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  async function refetch() {
    await queryClient.invalidateQueries({ queryKey: ["admin-employees"] });
  }

  async function handleSubmit(values: EmployeeCreateIn | EmployeeUpdateIn) {
    setFormError(null);
    try {
      if (editing && editing !== "new") {
        await updateEmployee(editing.id, values as EmployeeUpdateIn);
      } else {
        await createEmployee(values as EmployeeCreateIn);
      }
      await refetch();
      setEditing(null);
    } catch (err) {
      setFormError(errorMessage(err));
    }
  }

  async function handleDeactivate(employee: Employee) {
    setActionError(null);
    try {
      await deactivateEmployee(employee.id);
      await refetch();
    } catch (err) {
      setActionError(errorMessage(err));
    }
  }

  const employees = query.data ?? [];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">Personal de la organización.</p>
        <Button type="button" className="gap-2" onClick={() => setEditing("new")}>
          <Plus className="size-4" aria-hidden="true" />
          Nuevo empleado
        </Button>
      </div>

      {actionError ? (
        <p role="alert" className="text-sm font-medium text-destructive">
          {actionError}
        </p>
      ) : null}

      {query.isLoading ? (
        <Skeleton className="h-32 w-full" />
      ) : query.isError ? (
        <EmptyState
          role="alert"
          title="No se pudo cargar el personal"
          description={errorMessage(query.error)}
          action={{ label: "Reintentar", onClick: () => void query.refetch() }}
        />
      ) : employees.length === 0 ? (
        <EmptyState title="Todavía no hay empleados" description="Creá el primero." />
      ) : (
        <div className="overflow-x-auto rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Nombre</TableHead>
                <TableHead>Rol</TableHead>
                <TableHead>Documento</TableHead>
                <TableHead>Cobra</TableHead>
                <TableHead>Límite de descuento</TableHead>
                <TableHead>Estado</TableHead>
                <TableHead className="text-right">Acciones</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {employees.map((employee) => (
                <TableRow key={employee.id}>
                  <TableCell>{employee.name}</TableCell>
                  <TableCell>{ROLE_LABEL[employee.role] ?? employee.role}</TableCell>
                  <TableCell>{employee.document ?? "—"}</TableCell>
                  <TableCell>{employee.can_charge ? "Sí" : "No"}</TableCell>
                  <TableCell>
                    {employee.discount_limit_pct !== null ? `${employee.discount_limit_pct}%` : "—"}
                  </TableCell>
                  <TableCell>
                    <Badge variant={employee.active ? "secondary" : "outline"}>
                      {employee.active ? "Activo" : "Inactivo"}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-1">
                      <Button type="button" variant="outline" size="sm" onClick={() => setEditing(employee)}>
                        Editar
                      </Button>
                      {employee.active ? (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => void handleDeactivate(employee)}
                        >
                          Desactivar
                        </Button>
                      ) : null}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <EmployeeFormDialog
        open={editing !== null}
        onOpenChange={(open) => {
          if (!open) {
            setEditing(null);
            setFormError(null);
          }
        }}
        employee={editing && editing !== "new" ? editing : undefined}
        storeId={storeId}
        onSubmit={handleSubmit}
        error={formError}
      />
    </div>
  );
}
