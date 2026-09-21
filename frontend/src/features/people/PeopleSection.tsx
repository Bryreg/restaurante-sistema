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
import {
  ConsequenceZone,
  DenseTable,
  DenseTableBar,
  type DenseColumn,
  type LegendEntry,
} from "@/components/admin";
import { EmptyState } from "@/components/EmptyState";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { errorMessage } from "@/lib/errors";

import { EmployeeFormDialog } from "./EmployeeFormDialog";

const ROLE_LABEL: Record<string, string> = {
  operator: "Operador",
  supervisor: "Supervisor",
  admin: "Administrador",
};

/**
 * **La leyenda del pie** (patrón 8 d): las distinciones que este sistema
 * separa a propósito y que una tabla sin leyenda aplana.
 *
 * La primera es la cara de «`null` no es `0`» en esta pantalla, y no es una
 * sutileza de estilo: `backend/app/orders/service.py` resuelve el límite con
 * `employee.discount_limit_pct if ... is not None else settings.discount_limit_pct`.
 * Vacío **no** es «sin límite» ni «0 %»: es «rige el general de la sede».
 * Dibujarlo como `0 %` le enseñaría al dueño que esa persona no puede
 * descontar nada, que es exactamente al revés de lo que pasa.
 */
const PEOPLE_LEGEND: readonly LegendEntry[] = [
  {
    term: "Límite de descuento «—»",
    meaning: (
      <>
        no es <b>0 %</b> ni «sin límite»: esa persona no tiene uno propio y rige el{" "}
        <b>límite general de la sede</b>, el de Ajustes › Ventas.
      </>
    ),
  },
  {
    term: "Cobra",
    meaning:
      "puede cerrar la cuenta y manejar el cajón. Es distinto del rol: un operador puede cobrar y un supervisor puede no hacerlo.",
  },
  {
    term: "Inactivo",
    meaning: (
      <>
        no borra: deja de aparecer en «Identificar persona» y su PIN deja de abrir el salón, pero{" "}
        <b>todo lo que firmó sigue firmado por ella</b>.
      </>
    ),
  },
];

/**
 * Ajustes → Empleados. Quién trabaja acá, con qué rol, con qué PIN y hasta
 * qué descuento puede dar sin pedir permiso.
 *
 * Es la pestaña de Ajustes que **más sale de Ajustes**: el PIN personal es
 * con lo que alguien se identifica en la tablet del salón, y el límite de
 * descuento es lo que dispara —o no— el pedido de autorización de un
 * supervisor (`DISCOUNT_LIMIT_EXCEEDED`). Por eso los dos campos llevan
 * marcas de alcance en el formulario (patrón 10) y por eso la baja tiene su
 * zona de consecuencia (patrón 11).
 *
 * El PIN nunca vuelve del servidor (`app/auth/schemas.py::EmployeeOut` no lo
 * incluye): sólo se puede reemplazar. La baja es lógica, nunca un `DELETE`.
 */
export function PeopleSection({ storeId }: { storeId: number | null }): React.JSX.Element {
  const queryClient = useQueryClient();
  const [showInactive, setShowInactive] = useState(false);
  const query = useQuery({
    queryKey: ["admin-employees", showInactive],
    queryFn: () => listEmployees(showInactive ? {} : { active: true }),
  });
  const [editing, setEditing] = useState<Employee | "new" | null>(null);
  const [deactivating, setDeactivating] = useState<Employee | null>(null);
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
      setDeactivating(null);
      await refetch();
    } catch (err) {
      setActionError(errorMessage(err));
    }
  }

  const employees = query.data ?? [];
  const inactive = employees.filter((e) => !e.active).length;

  const columns: readonly DenseColumn<Employee>[] = [
    { key: "name", header: "Nombre", kind: "name", cell: (e) => e.name },
    // La palabra del negocio, nunca el enum (`operator`, `admin`).
    { key: "role", header: "Rol", cell: (e) => ROLE_LABEL[e.role] ?? e.role },
    { key: "document", header: "Documento", kind: "id", cell: (e) => e.document ?? "—" },
    { key: "charge", header: "Cobra", cell: (e) => (e.can_charge ? "Sí" : "No") },
    {
      key: "discount",
      header: "Límite de descuento",
      kind: "number",
      // `null` ≠ `0`: sin límite propio rige el general de la sede. La
      // leyenda del pie lo dice entero; acá se dibuja apagado, nunca en rojo
      // —no tener uno propio no es estar mal—.
      cell: (e) =>
        e.discount_limit_pct !== null ? (
          `${e.discount_limit_pct} %`
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
      cellTitle: (e) =>
        e.discount_limit_pct === null
          ? "Sin límite propio: rige el límite general de la sede (Ajustes › Ventas)."
          : undefined,
    },
    { key: "state", header: "Estado", cell: (e) => (e.active ? "Activo" : "Inactivo") },
    {
      key: "actions",
      header: "",
      kind: "actions",
      cell: (e) => (
        <span className="flex flex-nowrap justify-end gap-1">
          <Button type="button" variant="outline" size="sm" onClick={() => setEditing(e)}>
            Editar
          </Button>
          {/* «Desactivar» sólo existe si la persona está activa. */}
          {e.active ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                setActionError(null);
                setDeactivating(e);
              }}
            >
              Desactivar
            </Button>
          ) : null}
        </span>
      ),
    },
  ];

  return (
    <div className="space-y-3">
      {/* Patrón 11 · zona ÁMBAR, «cambia otra pantalla»: dar de baja a alguien
          no pierde nada —sus firmas quedan, y se puede reactivar desde
          «Editar»— pero apaga su PIN en el salón, que es una pantalla que el
          dueño no está mirando ahora mismo. Rojo se reserva para lo que no se
          deshace. El marco avisa; el botón es azul y secundario. */}
      {deactivating ? (
        <ConsequenceZone
          level="reversible"
          scope={deactivating.name}
          explanation="La baja es lógica: no se borra ninguna fila y nada de lo que esta persona hizo cambia. Se puede volver a activar desde «Editar»."
          action={{
            label: "Desactivar",
            confirmTitle: `Desactivar a ${deactivating.name}`,
            consequences: [
              "Deja de aparecer en «Salón › Identificar persona»: su PIN no vuelve a abrir el dispositivo.",
              "Las comandas, cobros y cierres que ya firmó siguen firmados por ella, con su nombre congelado.",
              "Si era responsable de un turno abierto, ese turno no se cierra solo: hay que cerrarlo desde Dinero.",
              "Se puede revertir: «Editar» vuelve a marcarla como activa.",
            ],
            onClick: () => void handleDeactivate(deactivating),
          }}
        >
          <Button type="button" variant="ghost" onClick={() => setDeactivating(null)}>
            Dejarla activa
          </Button>
        </ConsequenceZone>
      ) : null}

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
          reason="error"
          title="No se pudo cargar el personal"
          description={errorMessage(query.error)}
          action={{ label: "Reintentar", onClick: () => void query.refetch() }}
        />
      ) : (
        <DenseTable
          caption="Empleados de la organización"
          columns={columns}
          rows={employees}
          rowKey={(e) => String(e.id)}
          rowStatus={(e) => (e.active ? "ok" : "none")}
          rowInactive={(e) => !e.active}
          legend={PEOPLE_LEGEND}
          bar={
            <DenseTableBar
              shown={employees.length}
              total={employees.length}
              noun={showInactive ? "empleados" : "empleados activos"}
              hidden={
                showInactive
                  ? inactive > 0
                    ? `${inactive} inactivos, a la vista`
                    : undefined
                  : "los inactivos no se están mostrando"
              }
            >
              <div className="flex items-center gap-2">
                <Checkbox
                  id="emp-show-inactive"
                  checked={showInactive}
                  onCheckedChange={(v) => setShowInactive(v === true)}
                />
                <Label htmlFor="emp-show-inactive">Mostrar inactivos</Label>
              </div>
              <Button type="button" className="gap-2" onClick={() => setEditing("new")}>
                <Plus className="size-4" aria-hidden="true" />
                Nuevo empleado
              </Button>
            </DenseTableBar>
          }
          note={
            <>
              El <b>PIN nunca se muestra</b> —el servidor no lo devuelve— y por eso no se «consulta»: sólo se
              reemplaza por uno nuevo desde «Editar». Un PIN que nadie recuerda se rota, no se busca.
            </>
          }
          empty={
            <EmptyState
              title="Todavía no hay empleados"
              description="Creá el primero con «Nuevo empleado». Sin personal nadie puede identificarse en la tablet del salón."
            />
          }
        />
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
