import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useState } from "react"

import { createSupplier, deactivateSupplier, listSuppliers, updateSupplier, type SupplierOut } from "@/api/purchases"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"
import {
  DenseTable,
  DenseTableBar,
  type DenseColumn,
  type LegendEntry,
} from "@/components/admin"
import { EmptyState } from "@/components/EmptyState"

/** La leyenda del pie: qué cambia que un proveedor exija factura. */
const SUPPLIERS_LEGEND: readonly LegendEntry[] = [
  {
    term: "Obligado a facturar",
    meaning: (
      <>
        una recepción de este proveedor <b>sin factura se rechaza</b>. No es una preferencia: el servidor la
        hace cumplir.
      </>
    ),
  },
  {
    term: "Plazo",
    meaning: "los días desde la recepción hasta que la cuenta por pagar vence. De ahí sale el «Vencida».",
  },
  {
    term: "Desactivar",
    meaning: "no borra: el proveedor deja de ofrecerse en recepciones nuevas y sus compras viejas quedan enteras.",
  },
]
import { errorMessage } from "@/lib/errors"

import { downloadSuppliersCsv } from "./lib"
import { formValuesToSupplierIn, formValuesToSupplierUpdateIn, SupplierForm } from "./SupplierForm"
import { SupplierReliabilityDialog } from "./SupplierReliabilityDialog"

function SupplierActions({ supplier }: { supplier: SupplierOut }): React.JSX.Element {
  const queryClient = useQueryClient()
  const [editing, setEditing] = useState(false)

  const updateMutation = useMutation({
    mutationFn: (values: Parameters<typeof formValuesToSupplierUpdateIn>[0]) =>
      updateSupplier(supplier.id, formValuesToSupplierUpdateIn(values)),
    onSuccess: () => {
      setEditing(false)
      void queryClient.invalidateQueries({ queryKey: ["purchases", "suppliers"] })
    },
  })

  const deactivateMutation = useMutation({
    mutationFn: () => deactivateSupplier(supplier.id),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["purchases", "suppliers"] }),
  })

  return (
    <div className="flex flex-nowrap justify-end gap-1">
      <SupplierReliabilityDialog supplier={supplier} />
      <Dialog open={editing} onOpenChange={setEditing}>
        <DialogTrigger render={<Button variant="outline" size="sm" />}>Editar</DialogTrigger>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>Editar {supplier.name}</DialogTitle>
          </DialogHeader>
          <SupplierForm
            supplier={supplier}
            submitting={updateMutation.isPending}
            submitLabel="Guardar"
            serverError={updateMutation.isError ? errorMessage(updateMutation.error) : null}
            onSubmit={(values) => updateMutation.mutate(values)}
          />
        </DialogContent>
      </Dialog>
      {/* «Desactivar» sólo existe si el proveedor está activo. */}
      {supplier.active ? (
        <Button
          variant="outline"
          size="sm"
          disabled={deactivateMutation.isPending}
          onClick={() => deactivateMutation.mutate()}
        >
          Desactivar
        </Button>
      ) : null}
    </div>
  )
}

/**
 * Admin → Compras → Proveedores (SPEC-NEGOCIO §5.6 / §9.3: «¿a quién le
 * debo?»). Entidad canónica: alta, edición y baja LÓGICA (nunca un
 * `DELETE` de fila). `400 SUPPLIER_DUPLICATE_NIT` se muestra tal cual el
 * servidor lo redactó — ya nombra la acción correctiva — nunca como un
 * toast genérico.
 */
export function SuppliersTab({ storeId }: { storeId: number }): React.JSX.Element {
  const [creating, setCreating] = useState(false)
  const [showInactive, setShowInactive] = useState(false)
  const queryClient = useQueryClient()

  const query = useQuery({
    queryKey: ["purchases", "suppliers", storeId, showInactive],
    queryFn: () => listSuppliers(storeId, { active: showInactive ? undefined : true }),
  })

  const createMutation = useMutation({
    mutationFn: (values: Parameters<typeof formValuesToSupplierIn>[0]) =>
      createSupplier(storeId, formValuesToSupplierIn(values)),
    onSuccess: () => {
      setCreating(false)
      void queryClient.invalidateQueries({ queryKey: ["purchases", "suppliers"] })
    },
  })

  const suppliers = query.data ?? []
  const inactive = suppliers.filter((s) => !s.active).length

  const columns: readonly DenseColumn<SupplierOut>[] = [
    { key: "name", header: "Nombre", kind: "name", cell: (s) => s.name },
    { key: "nit", header: "NIT", kind: "id", cell: (s) => s.nit ?? "—" },
    { key: "term", header: "Plazo", kind: "number", cell: (s) => `${s.payment_term_days} días` },
    {
      key: "contact",
      header: "Contacto",
      widthPx: 200,
      cell: (s) => (
        <span className="block truncate">
          {s.contact_name ?? "—"}
          {s.contact_phone ? ` · ${s.contact_phone}` : ""}
        </span>
      ),
      cellTitle: (s) => [s.contact_name, s.contact_phone].filter(Boolean).join(" · ") || undefined,
    },
    {
      key: "invoice",
      header: "Factura",
      cell: (s) => (s.invoices_required ? "Obligado a facturar" : "Factura opcional"),
    },
    {
      key: "actions",
      header: "",
      kind: "actions",
      cell: (s) => <SupplierActions supplier={s} />,
    },
  ]

  if (query.isError) {
    return (
      <EmptyState
        role="alert"
        title="No se pudieron cargar los proveedores"
        description={errorMessage(query.error)}
        action={{ label: "Reintentar", onClick: () => void query.refetch() }}
      />
    )
  }

  return (
    <DenseTable
      caption="Proveedores de la sede"
      columns={columns}
      rows={suppliers}
      rowKey={(s) => String(s.id)}
      rowInactive={(s) => !s.active}
      legend={SUPPLIERS_LEGEND}
      bar={
        <DenseTableBar
          shown={suppliers.length}
          total={suppliers.length}
          noun={showInactive ? "proveedores" : "proveedores activos"}
          hidden={
            query.isLoading
              ? "contando…"
              : showInactive
                ? inactive > 0
                  ? `${inactive} inactivos, a la vista`
                  : undefined
                : "los inactivos no se están mostrando"
          }
        >
          <div className="flex items-center gap-2">
            <Checkbox
              id="sup-show-inactive"
              checked={showInactive}
              onCheckedChange={(v) => setShowInactive(v === true)}
            />
            <Label htmlFor="sup-show-inactive">Mostrar inactivos</Label>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => downloadSuppliersCsv(suppliers)}
            disabled={suppliers.length === 0}
          >
            Exportar CSV
          </Button>
          <Dialog open={creating} onOpenChange={setCreating}>
            <DialogTrigger render={<Button size="sm" />}>Nuevo proveedor</DialogTrigger>
            <DialogContent className="max-w-xl">
              <DialogHeader>
                <DialogTitle>Nuevo proveedor</DialogTitle>
              </DialogHeader>
              <SupplierForm
                submitting={createMutation.isPending}
                submitLabel="Crear"
                serverError={createMutation.isError ? errorMessage(createMutation.error) : null}
                onSubmit={(values) => createMutation.mutate(values)}
              />
            </DialogContent>
          </Dialog>
        </DenseTableBar>
      }
      note="Nombre canónico, NIT, plazo de pago y si el proveedor exige factura. Nunca texto libre: cada recepción elige uno de esta lista."
      empty={
        query.isLoading ? undefined : (
          <EmptyState
            title="Todavía no hay proveedores"
            description="Creá el primero con «Nuevo proveedor». Sin proveedores no se puede registrar ninguna recepción."
          />
        )
      }
    />
  )
}

export default SuppliersTab
