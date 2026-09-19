import { useState } from "react"

import type { SupplierIn, SupplierOut, SupplierUpdateIn } from "@/api/purchases"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { DialogClose, DialogFooter } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

export interface SupplierFormValues {
  name: string
  nit: string
  paymentTermDays: string
  contactName: string
  contactPhone: string
  invoicesRequired: boolean
  active: boolean
}

function toFormValues(supplier?: SupplierOut): SupplierFormValues {
  return {
    name: supplier?.name ?? "",
    nit: supplier?.nit ?? "",
    paymentTermDays: supplier ? String(supplier.payment_term_days) : "0",
    contactName: supplier?.contact_name ?? "",
    contactPhone: supplier?.contact_phone ?? "",
    invoicesRequired: supplier?.invoices_required ?? true,
    active: supplier?.active ?? true,
  }
}

export function formValuesToSupplierIn(values: SupplierFormValues): SupplierIn {
  return {
    name: values.name.trim(),
    nit: values.nit.trim() === "" ? null : values.nit.trim(),
    payment_term_days: Number(values.paymentTermDays),
    contact_name: values.contactName.trim() === "" ? null : values.contactName.trim(),
    contact_phone: values.contactPhone.trim() === "" ? null : values.contactPhone.trim(),
    invoices_required: values.invoicesRequired,
    active: values.active,
  }
}

export function formValuesToSupplierUpdateIn(values: SupplierFormValues): SupplierUpdateIn {
  return formValuesToSupplierIn(values)
}

/**
 * Alta y edición de proveedor (SPEC-NEGOCIO §5.6: entidad canónica, nunca
 * texto libre — "41 grafías para 23 proveedores en la referencia"). El
 * error `400 SUPPLIER_DUPLICATE_NIT` del servidor ya nombra la acción
 * correctiva ("Ya existe un proveedor con NIT... reactivalo o..."); este
 * formulario lo muestra tal cual llegó, nunca como un toast genérico.
 */
export function SupplierForm({
  supplier,
  onSubmit,
  submitting,
  submitLabel,
  serverError,
}: {
  supplier?: SupplierOut
  onSubmit: (values: SupplierFormValues) => void
  submitting: boolean
  submitLabel: string
  serverError?: string | null
}): React.JSX.Element {
  const [values, setValues] = useState<SupplierFormValues>(() => toFormValues(supplier))
  const canSubmit = values.name.trim() !== "" && Number(values.paymentTermDays) >= 0

  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault()
        if (!canSubmit) return
        onSubmit(values)
      }}
    >
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <Label htmlFor="sup-name">Nombre</Label>
          <Input
            id="sup-name"
            required
            value={values.name}
            onChange={(event) => setValues((v) => ({ ...v, name: event.target.value }))}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="sup-nit">NIT (opcional)</Label>
          <Input id="sup-nit" value={values.nit} onChange={(event) => setValues((v) => ({ ...v, nit: event.target.value }))} />
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div className="space-y-1">
          <Label htmlFor="sup-payment-term">Plazo de pago (días)</Label>
          <Input
            id="sup-payment-term"
            type="number"
            min={0}
            required
            value={values.paymentTermDays}
            onChange={(event) => setValues((v) => ({ ...v, paymentTermDays: event.target.value }))}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="sup-contact-name">Contacto (opcional)</Label>
          <Input
            id="sup-contact-name"
            value={values.contactName}
            onChange={(event) => setValues((v) => ({ ...v, contactName: event.target.value }))}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="sup-contact-phone">Teléfono (opcional)</Label>
          <Input
            id="sup-contact-phone"
            value={values.contactPhone}
            onChange={(event) => setValues((v) => ({ ...v, contactPhone: event.target.value }))}
          />
        </div>
      </div>

      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <Checkbox
            id="sup-invoices-required"
            checked={values.invoicesRequired}
            onCheckedChange={(checked) => setValues((v) => ({ ...v, invoicesRequired: checked === true }))}
          />
          <Label htmlFor="sup-invoices-required">Obligado a facturar</Label>
        </div>
        <p className="pl-6 text-xs text-muted-foreground">
          Con esto marcado, una recepción sin factura de este proveedor se rechaza con «Falta la factura».
        </p>
        {supplier ? (
          <div className="flex items-center gap-2">
            <Checkbox
              id="sup-active"
              checked={values.active}
              onCheckedChange={(checked) => setValues((v) => ({ ...v, active: checked === true }))}
            />
            <Label htmlFor="sup-active">Activo</Label>
          </div>
        ) : null}
      </div>

      {serverError ? (
        <p role="alert" className="text-sm font-medium text-destructive">
          {serverError}
        </p>
      ) : null}

      <DialogFooter>
        <DialogClose render={<Button type="button" variant="outline" />}>Cancelar</DialogClose>
        <Button type="submit" disabled={submitting || !canSubmit}>
          {submitLabel}
        </Button>
      </DialogFooter>
    </form>
  )
}

export default SupplierForm
