import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useState } from "react"

import { createSupplier, deactivateSupplier, listSuppliers, updateSupplier, type SupplierOut } from "@/api/purchases"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { EmptyState } from "@/components/EmptyState"
import { errorMessage } from "@/lib/errors"

import { downloadSuppliersCsv } from "./lib"
import { formValuesToSupplierIn, formValuesToSupplierUpdateIn, SupplierForm } from "./SupplierForm"
import { SupplierReliabilityDialog } from "./SupplierReliabilityDialog"

function SupplierRow({ supplier }: { supplier: SupplierOut }): React.JSX.Element {
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
    <TableRow>
      <TableCell className="font-medium">{supplier.name}</TableCell>
      <TableCell>{supplier.nit ?? "—"}</TableCell>
      <TableCell className="tabular-nums">{supplier.payment_term_days} días</TableCell>
      <TableCell>
        {supplier.contact_name ?? "—"}
        {supplier.contact_phone ? ` · ${supplier.contact_phone}` : ""}
      </TableCell>
      <TableCell>
        {supplier.invoices_required ? <Badge variant="secondary">Obligado a facturar</Badge> : <Badge variant="outline">Factura opcional</Badge>}
      </TableCell>
      <TableCell>{supplier.active ? <Badge variant="secondary">Activo</Badge> : <Badge variant="outline">Inactivo</Badge>}</TableCell>
      <TableCell>
        <div className="flex flex-wrap gap-2">
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
          {supplier.active ? (
            <Button variant="outline" size="sm" disabled={deactivateMutation.isPending} onClick={() => deactivateMutation.mutate()}>
              Desactivar
            </Button>
          ) : null}
        </div>
      </TableCell>
    </TableRow>
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
    mutationFn: (values: Parameters<typeof formValuesToSupplierIn>[0]) => createSupplier(storeId, formValuesToSupplierIn(values)),
    onSuccess: () => {
      setCreating(false)
      void queryClient.invalidateQueries({ queryKey: ["purchases", "suppliers"] })
    },
  })

  const suppliers = query.data ?? []

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="max-w-2xl text-sm text-muted-foreground">
          Nombre canónico, NIT, plazo de pago y si el proveedor exige factura. Nunca texto libre: cada recepción elige
          uno de esta lista.
        </p>
        <div className="flex items-center gap-3">
          <Button variant="outline" onClick={() => downloadSuppliersCsv(suppliers)} disabled={suppliers.length === 0}>
            Exportar CSV
          </Button>
          <Dialog open={creating} onOpenChange={setCreating}>
            <DialogTrigger render={<Button />}>Nuevo proveedor</DialogTrigger>
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
        </div>
      </div>

      <div className="flex items-center gap-2">
        <Checkbox id="sup-show-inactive" checked={showInactive} onCheckedChange={(v) => setShowInactive(v === true)} />
        <Label htmlFor="sup-show-inactive">Mostrar inactivos</Label>
      </div>

      {query.isLoading ? (
        <p className="text-sm text-muted-foreground">Cargando proveedores…</p>
      ) : query.isError ? (
        <EmptyState
          role="alert"
          title="No se pudieron cargar los proveedores"
          description={errorMessage(query.error)}
          action={{ label: "Reintentar", onClick: () => void query.refetch() }}
        />
      ) : suppliers.length === 0 ? (
        <EmptyState title="Todavía no hay proveedores" description="Creá el primero con «Nuevo proveedor»." />
      ) : (
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Nombre</TableHead>
                <TableHead>NIT</TableHead>
                <TableHead>Plazo</TableHead>
                <TableHead>Contacto</TableHead>
                <TableHead>Factura</TableHead>
                <TableHead>Estado</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {suppliers.map((supplier) => (
                <SupplierRow key={supplier.id} supplier={supplier} />
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  )
}

export default SuppliersTab
