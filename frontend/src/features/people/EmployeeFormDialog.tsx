import { useEffect, useState } from "react";

import type { Employee, EmployeeCreateIn, EmployeeRole, EmployeeUpdateIn } from "@/api/employees";
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
import { Label } from "@/components/ui/label";
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

interface FormState {
  name: string;
  role: EmployeeRole;
  pin: string;
  can_charge: boolean;
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

/** PIN nunca vuelve del servidor: en edición se manda vacío = "sin cambio". */
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

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{employee ? `Editar a ${employee.name}` : "Nuevo empleado"}</DialogTitle>
          <DialogDescription>El PIN nunca se muestra; sólo se puede reemplazar.</DialogDescription>
        </DialogHeader>
        <form className="space-y-4" onSubmit={handleSubmit}>
          <div className="space-y-1.5">
            <Label htmlFor="emp-name">Nombre</Label>
            <Input
              id="emp-name"
              required
              className="h-11"
              value={values.name}
              onChange={(e) => setValues((v) => ({ ...v, name: e.target.value }))}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="emp-role">Rol</Label>
            <Select value={values.role} onValueChange={(v) => setValues((prev) => ({ ...prev, role: v as EmployeeRole }))}>
              <SelectTrigger id="emp-role" className="h-11">
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
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="emp-pin">{employee ? "Nuevo PIN (opcional)" : "PIN de 4 dígitos"}</Label>
            <Input
              id="emp-pin"
              required={!employee}
              inputMode="numeric"
              pattern="[0-9]{4}"
              maxLength={4}
              className="h-11"
              value={values.pin}
              onChange={(e) => setValues((v) => ({ ...v, pin: e.target.value }))}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="emp-document">Documento</Label>
            <Input
              id="emp-document"
              className="h-11"
              value={values.document}
              onChange={(e) => setValues((v) => ({ ...v, document: e.target.value }))}
            />
          </div>
          {values.role === "admin" ? (
            <>
              <div className="space-y-1.5">
                <Label htmlFor="emp-email">Correo</Label>
                <Input
                  id="emp-email"
                  type="email"
                  className="h-11"
                  value={values.email}
                  onChange={(e) => setValues((v) => ({ ...v, email: e.target.value }))}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="emp-password">{employee ? "Nueva contraseña (opcional)" : "Contraseña"}</Label>
                <Input
                  id="emp-password"
                  type="password"
                  className="h-11"
                  value={values.password}
                  onChange={(e) => setValues((v) => ({ ...v, password: e.target.value }))}
                />
              </div>
            </>
          ) : null}
          <label className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={values.can_charge}
              onCheckedChange={(c) => setValues((v) => ({ ...v, can_charge: c === true }))}
            />
            Puede cobrar
          </label>
          <div className="space-y-1.5">
            <Label htmlFor="emp-discount-limit">Límite de descuento (%, opcional)</Label>
            <Input
              id="emp-discount-limit"
              type="number"
              min={0}
              max={100}
              className="h-11"
              value={values.discount_limit_pct}
              onChange={(e) => setValues((v) => ({ ...v, discount_limit_pct: e.target.value }))}
            />
          </div>
          {error ? (
            <p role="alert" className="text-sm font-medium text-destructive">
              {error}
            </p>
          ) : null}
          <DialogFooter>
            <Button type="submit" disabled={submitting}>
              {submitting ? "Guardando…" : "Guardar"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
