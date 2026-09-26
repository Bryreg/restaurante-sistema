import { useEffect, useState } from "react";

import type { Puesto } from "@/api/auth";
import type { Employee, EmployeeCreateIn, EmployeeRole, EmployeeUpdateIn } from "@/api/employees";
import { FormField, FormSection } from "@/components/admin";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const ROLE_LABEL: Record<EmployeeRole, string> = {
  operator: "Operador",
  supervisor: "Supervisor",
  admin: "Administrador",
};

/** «Todo» es `null` en el servidor: la persona ve la barra completa, como siempre. */
const PUESTO_TODO = "todo";

const PUESTO_OPCIONES: Array<{ value: Puesto | typeof PUESTO_TODO; label: string; lectura: string }> = [
  {
    value: PUESTO_TODO,
    label: "Todo (sin puesto)",
    lectura: "ve todas las pantallas del salón y entra por Mesas, como hasta ahora",
  },
  { value: "caja", label: "Caja", lectura: "entra directo al Turno y ve Mesas, Mostrador, Turno y Cocina" },
  { value: "salon", label: "Salón (mesero)", lectura: "entra directo a Mesas y ve sólo Mesas, Mostrador y Turno" },
  {
    value: "cocina",
    label: "Cocina",
    lectura: "entra directo a los tiquetes de cocina y ve Tiquetes, Producción, Merma y Turno",
  },
  {
    value: "bar",
    label: "Bar",
    lectura: "entra directo a los tiquetes del bar y ve Tiquetes, Producción, Merma y Turno",
  },
];

interface FormState {
  name: string;
  role: EmployeeRole;
  pin: string;
  can_charge: boolean;
  puesto: Puesto | typeof PUESTO_TODO;
  discount_limit_pct: string;
  document: string;
  email: string;
  password: string;
}

function emptyState(): FormState {
  return {
    name: "",
    role: "operator",
    pin: "",
    can_charge: false,
    puesto: PUESTO_TODO,
    discount_limit_pct: "",
    document: "",
    email: "",
    password: "",
  };
}

function fromEmployee(employee: Employee): FormState {
  return {
    name: employee.name,
    role: employee.role,
    pin: "",
    can_charge: employee.can_charge,
    puesto: employee.puesto ?? PUESTO_TODO,
    discount_limit_pct: employee.discount_limit_pct !== null ? String(employee.discount_limit_pct) : "",
    document: employee.document ?? "",
    email: employee.email ?? "",
    password: "",
  };
}

export interface EmployeeFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  employee?: Employee;
  storeId: number | null;
  onSubmit: (values: EmployeeCreateIn | EmployeeUpdateIn) => Promise<void>;
  error?: string | null;
}

/**
 * Alta y edición de una persona (patrón 9). Dos secciones, porque son dos
 * cosas distintas: **quién es** —lo que no sale de Ajustes— y **con qué
 * entra y hasta dónde llega**, que es lo que el salón le va a exigir.
 *
 * Los dos campos de la segunda sección llevan marcas de alcance (patrón 10)
 * porque ninguno de los dos se nota acá:
 * - el **PIN** es lo que la tablet pide en «Identificar persona»;
 * - el **límite de descuento** es lo que dispara `DISCOUNT_LIMIT_EXCEEDED` y
 *   con él el pedido del PIN de un supervisor
 *   (`backend/app/orders/service.py`). Vacío **no es 0**: es «rige el
 *   general de la sede».
 *
 * El PIN nunca vuelve del servidor: en edición se manda vacío = «sin
 * cambio», y por eso el rótulo cambia entre alta y edición.
 */
export function EmployeeFormDialog({
  open,
  onOpenChange,
  employee,
  storeId,
  onSubmit,
  error,
}: EmployeeFormDialogProps): React.JSX.Element {
  const [values, setValues] = useState<FormState>(employee ? fromEmployee(employee) : emptyState());
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (open) {
      setValues(employee ? fromEmployee(employee) : emptyState());
    }
  }, [open, employee]);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    try {
      const discountLimit = values.discount_limit_pct.trim() === "" ? null : Number(values.discount_limit_pct);
      if (employee) {
        const patch: EmployeeUpdateIn = {
          name: values.name,
          role: values.role,
          store_id: values.role === "admin" ? null : storeId,
          can_charge: values.can_charge,
          puesto: values.puesto === PUESTO_TODO ? null : values.puesto,
          discount_limit_pct: discountLimit,
          document: values.document || null,
          email: values.email || null,
        };
        if (values.pin.trim() !== "") patch.pin = values.pin;
        if (values.password.trim() !== "") patch.password = values.password;
        await onSubmit(patch);
      } else {
        await onSubmit({
          name: values.name,
          role: values.role,
          pin: values.pin,
          store_id: values.role === "admin" ? null : storeId,
          can_charge: values.can_charge,
          puesto: values.puesto === PUESTO_TODO ? null : values.puesto,
          discount_limit_pct: discountLimit,
          document: values.document || null,
          email: values.email || null,
          password: values.password || null,
        });
      }
    } finally {
      setSubmitting(false);
    }
  }

  const isAdmin = values.role === "admin";
  // Supervisores y administradores ven todo: el puesto no les cambia nada.
  const puestoAplica = values.role === "operator";
  const puestoElegido = PUESTO_OPCIONES.find((o) => o.value === values.puesto) ?? PUESTO_OPCIONES[0]!;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{employee ? `Editar a ${employee.name}` : "Nuevo empleado"}</DialogTitle>
          <DialogDescription>El PIN nunca se muestra; sólo se puede reemplazar.</DialogDescription>
        </DialogHeader>
        <form className="space-y-3" onSubmit={handleSubmit}>
          <FormSection
            title="Quién es"
            governs="Cómo aparece esta persona en cada comanda, cada cobro y cada fila del Historial. El nombre se congela en lo que firma: cambiarlo acá no reescribe lo viejo."
            reading={
              isAdmin ? (
                <>
                  Un <b>administrador</b> entra al escritorio con correo y contraseña, y además tiene PIN para el
                  salón. No queda atado a una sede: ve y autoriza en todas.
                </>
              ) : (
                <>
                  Un <b>{ROLE_LABEL[values.role].toLowerCase()}</b> trabaja en la sede activa y entra al salón sólo
                  con su PIN: no tiene usuario del escritorio.
                </>
              )
            }
          >
            <FormField
              label="Nombre"
              help="Es el que va a ver el salón y el que queda firmando cada acción en el Historial."
            >
              {({ fieldId, describedBy }) => (
                <Input
                  id={fieldId}
                  aria-describedby={describedBy}
                  required
                  value={values.name}
                  onChange={(e) => setValues((v) => ({ ...v, name: e.target.value }))}
                />
              )}
            </FormField>

            <FormField
              label="Rol"
              help="Decide qué puede hacer sin pedirle permiso a nadie, y si su PIN sirve para autorizar lo que otro no puede hacer solo."
              scope={{
                flag: "roles.supervisor",
                affects: [{ screen: "Salón › Anular, Descontar, Cortesía", verb: "Autoriza en" }],
              }}
            >
              {({ fieldId, describedBy }) => (
                <Select
                  value={values.role}
                  onValueChange={(v) => setValues((prev) => ({ ...prev, role: v as EmployeeRole }))}
                >
                  <SelectTrigger id={fieldId} aria-describedby={describedBy} className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {Object.entries(ROLE_LABEL).map(([value, label]) => (
                      <SelectItem key={value} value={value}>
                        {label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </FormField>

            <FormField
              label="Documento"
              help="Opcional. Sirve para identificarla en nómina y en los reportes que salen del sistema."
            >
              {({ fieldId, describedBy }) => (
                <Input
                  id={fieldId}
                  aria-describedby={describedBy}
                  value={values.document}
                  onChange={(e) => setValues((v) => ({ ...v, document: e.target.value }))}
                />
              )}
            </FormField>

            <FormField
              label="Puede cobrar"
              help="Marcada, esta persona puede cerrar la cuenta y responder por el cajón. Es distinto del rol: un operador puede cobrar y un supervisor puede no hacerlo."
              scope={{ affects: [{ screen: "Salón › Cobro" }] }}
            >
              {({ fieldId, describedBy }) => (
                <span className="flex h-8 items-center">
                  <Checkbox
                    id={fieldId}
                    aria-describedby={describedBy}
                    checked={values.can_charge}
                    onCheckedChange={(c) => setValues((v) => ({ ...v, can_charge: c === true }))}
                  />
                </span>
              )}
            </FormField>

            {isAdmin ? (
              <>
                <FormField
                  label="Correo"
                  help="Con esto entra al escritorio del administrador. El salón no lo pide nunca: ahí se entra con el PIN."
                >
                  {({ fieldId, describedBy }) => (
                    <Input
                      id={fieldId}
                      aria-describedby={describedBy}
                      type="email"
                      value={values.email}
                      onChange={(e) => setValues((v) => ({ ...v, email: e.target.value }))}
                    />
                  )}
                </FormField>
                <FormField
                  label={employee ? "Nueva contraseña (opcional)" : "Contraseña"}
                  help={
                    employee
                      ? "Vacío deja la contraseña como está. Lo que escribas la reemplaza: la vieja deja de servir en ese momento."
                      : "Con el correo, es lo que abre el escritorio. No se vuelve a mostrar."
                  }
                >
                  {({ fieldId, describedBy }) => (
                    <Input
                      id={fieldId}
                      aria-describedby={describedBy}
                      type="password"
                      value={values.password}
                      onChange={(e) => setValues((v) => ({ ...v, password: e.target.value }))}
                    />
                  )}
                </FormField>
              </>
            ) : null}
          </FormSection>

          {/* Patrón 10 · los dos campos que NO se notan en esta pantalla: el
              PIN abre el salón y el límite decide si hace falta un supervisor.
              Sin las marcas, el alcance habría que recordarlo. */}
          <FormSection
            title="Con qué entra al salón, y hasta dónde llega sola"
            governs="Lo único de esta pestaña que el salón le exige a la persona, en la tablet, mientras atiende."
            reading={
              values.discount_limit_pct.trim() === "" ? (
                <>
                  Sin límite propio, a esta persona la rige el <b>límite general de la sede</b> (Ajustes › Ventas).
                  Vacío <b>no es 0 %</b>: no significa que no pueda descontar.
                </>
              ) : (
                <>
                  Hasta <b>{values.discount_limit_pct} %</b> de descuento esta persona lo aplica sola. Pasado ese
                  punto el salón le pide el <b>PIN de un supervisor o administrador</b>, y esa autorización queda
                  listada en «Turnos y personal › Autorizaciones por autorizador».
                </>
              )
            }
            doesNotDo="Nada de esto le impide vender ni cobrar: el límite no bloquea el descuento, le pide una segunda persona."
          >
            <FormField
              label={employee ? "Nuevo PIN (opcional)" : "PIN de 4 dígitos"}
              help={
                employee
                  ? "Vacío deja el PIN como está. Lo que escribas lo reemplaza: el viejo deja de abrir el salón en ese momento, y el nuevo no se vuelve a mostrar."
                  : "Es lo único que esta persona teclea para identificarse en la tablet compartida. No se vuelve a mostrar."
              }
              scope={{ affects: [{ screen: "Salón › Identificar persona", verb: "Abre" }] }}
            >
              {({ fieldId, describedBy }) => (
                <Input
                  id={fieldId}
                  aria-describedby={describedBy}
                  required={!employee}
                  inputMode="numeric"
                  pattern="[0-9]{4}"
                  maxLength={4}
                  value={values.pin}
                  onChange={(e) => setValues((v) => ({ ...v, pin: e.target.value }))}
                />
              )}
            </FormField>

            {puestoAplica ? (
              <FormField
                label="Puesto"
                help={`Dónde trabaja en la tablet: decide a qué pantalla llega apenas teclea su PIN y qué botones ve en la barra. Con este puesto ${puestoElegido.lectura}. No le quita permisos: lo que puede cobrar lo decide «Puede cobrar».`}
                scope={{ affects: [{ screen: "Salón › Barra y pantalla de inicio" }] }}
              >
                {({ fieldId, describedBy }) => (
                  <Select
                    value={values.puesto}
                    onValueChange={(v) => setValues((prev) => ({ ...prev, puesto: v as FormState["puesto"] }))}
                  >
                    <SelectTrigger id={fieldId} aria-describedby={describedBy} className="w-full">
                      <SelectValue>{puestoElegido.label}</SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      {PUESTO_OPCIONES.map((opcion) => (
                        <SelectItem key={opcion.value} value={opcion.value}>
                          {opcion.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </FormField>
            ) : null}

            <FormField
              label="Límite de descuento (%, opcional)"
              help="Hasta acá descuenta sola. Dejalo vacío para que la rija el límite general de la sede — vacío no es 0 %."
              scope={{
                affects: [{ screen: "Salón › Comanda › Descuento" }],
                requires: "PIN de supervisor al pasarse",
              }}
            >
              {({ fieldId, describedBy }) => (
                <Input
                  id={fieldId}
                  aria-describedby={describedBy}
                  type="number"
                  min={0}
                  max={100}
                  placeholder="El general de la sede"
                  value={values.discount_limit_pct}
                  onChange={(e) => setValues((v) => ({ ...v, discount_limit_pct: e.target.value }))}
                />
              )}
            </FormField>
          </FormSection>

          {error ? (
            <p role="alert" className="text-sm font-medium text-destructive">
              {error}
            </p>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancelar
            </Button>
            <Button type="submit" disabled={submitting}>
              {submitting ? "Guardando…" : "Guardar"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
