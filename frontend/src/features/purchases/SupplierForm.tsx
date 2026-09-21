import { useState } from "react"

import type { SupplierIn, SupplierOut, SupplierUpdateIn } from "@/api/purchases"
import { FormField, FormSection } from "@/components/admin"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { DialogClose, DialogFooter } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"

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
 * texto libre — "41 grafías para 23 proveedores en la referencia"), con el
 * patrón 9. El error `400 SUPPLIER_DUPLICATE_NIT` del servidor ya nombra la
 * acción correctiva ("Ya existe un proveedor con NIT... reactivalo o...");
 * este formulario lo muestra tal cual llegó, nunca como un toast genérico.
 *
 * Las dos casillas llevan marca de alcance porque ninguna se nota acá:
 * «obligado a facturar» hace que el servidor **rechace** una recepción sin
 * factura de este proveedor, y «activo» decide si aparece siquiera en el
 * selector de una recepción nueva.
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
      className="space-y-3"
      onSubmit={(event) => {
        event.preventDefault()
        if (!canSubmit) return
        onSubmit(values)
      }}
    >
      <FormSection
        title="Quién es y cómo se le paga"
        governs="La entidad con la que se registra cada compra. Una recepción elige siempre uno de acá, nunca escribe un nombre."
        reading={
          Number(values.paymentTermDays) === 0 ? (
            <>
              Con plazo <b>0</b>, la cuenta por pagar de este proveedor nace <b>vencida el mismo día</b> de la
              recepción: es lo que corresponde a quien se le paga de contado.
            </>
          ) : (
            <>
              Cada recepción de este proveedor crea una cuenta por pagar que vence{" "}
              <b>{values.paymentTermDays} días</b> después, y de ahí sale el «Vencida» de Cuentas por pagar.
            </>
          )
        }
      >
        <FormField
          label="Nombre"
          help="El canónico. Si ya existe con otra grafía, corregí el que existe en vez de crear un segundo."
        >
          {({ fieldId, describedBy }) => (
            <Input
              id={fieldId}
              aria-describedby={describedBy}
              required
              value={values.name}
              onChange={(event) => setValues((v) => ({ ...v, name: event.target.value }))}
            />
          )}
        </FormField>

        <FormField
          label="NIT (opcional)"
          help="Si lo cargás, el sistema no deja crear dos proveedores con el mismo NIT en la sede."
        >
          {({ fieldId, describedBy }) => (
            <Input
              id={fieldId}
              aria-describedby={describedBy}
              value={values.nit}
              onChange={(event) => setValues((v) => ({ ...v, nit: event.target.value }))}
            />
          )}
        </FormField>

        <FormField
          label="Plazo de pago (días)"
          help="Desde la recepción hasta que la cuenta vence. Es lo que decide qué aparece como «Vencida»."
          scope={{ affects: [{ screen: "Compras › Cuentas por pagar" }] }}
        >
          {({ fieldId, describedBy }) => (
            <Input
              id={fieldId}
              aria-describedby={describedBy}
              type="number"
              min={0}
              required
              value={values.paymentTermDays}
              onChange={(event) => setValues((v) => ({ ...v, paymentTermDays: event.target.value }))}
            />
          )}
        </FormField>

        <FormField label="Contacto (opcional)" help="A quién se le reclama cuando falta mercancía o sobra una factura.">
          {({ fieldId, describedBy }) => (
            <Input
              id={fieldId}
              aria-describedby={describedBy}
              value={values.contactName}
              onChange={(event) => setValues((v) => ({ ...v, contactName: event.target.value }))}
            />
          )}
        </FormField>

        <FormField label="Teléfono (opcional)" help="El número al que se llama por un faltante, sin buscarlo en otro lado.">
          {({ fieldId, describedBy }) => (
            <Input
              id={fieldId}
              aria-describedby={describedBy}
              value={values.contactPhone}
              onChange={(event) => setValues((v) => ({ ...v, contactPhone: event.target.value }))}
            />
          )}
        </FormField>

        <FormField
          label="Obligado a facturar"
          help="Con esto marcado, una recepción sin factura de este proveedor se rechaza con «Falta la factura». No es una preferencia: el servidor la hace cumplir."
          scope={{ affects: [{ screen: "Compras › Nueva recepción", verb: "Frena en" }] }}
        >
          {({ fieldId, describedBy }) => (
            <span className="flex h-8 items-center">
              <Checkbox
                id={fieldId}
                aria-describedby={describedBy}
                checked={values.invoicesRequired}
                onCheckedChange={(checked) => setValues((v) => ({ ...v, invoicesRequired: checked === true }))}
              />
            </span>
          )}
        </FormField>

        {supplier ? (
          <FormField
            label="Activo"
            help="Desmarcado deja de ofrecerse en recepciones nuevas. No borra nada: las compras viejas quedan enteras."
            scope={{ affects: [{ screen: "Compras › Nueva recepción" }] }}
          >
            {({ fieldId, describedBy }) => (
              <span className="flex h-8 items-center">
                <Checkbox
                  id={fieldId}
                  aria-describedby={describedBy}
                  checked={values.active}
                  onCheckedChange={(checked) => setValues((v) => ({ ...v, active: checked === true }))}
                />
              </span>
            )}
          </FormField>
        ) : null}
      </FormSection>

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
