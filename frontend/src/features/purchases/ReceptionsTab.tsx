import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useState } from "react"

import { listIngredients } from "@/api/inventory"
import { listReceptions, receptionsCsvUrl, type ReceptionOut, type ReceptionStatus, type SupplierOut } from "@/api/purchases"
import { CsvExportButton } from "@/components/CsvExportButton"
import DateRangeFilter from "@/components/DateRangeFilter"
import {
  DenseTable,
  DenseTableBar,
  DependencyEmptyState,
  type DenseColumn,
  type LegendEntry,
} from "@/components/admin"
import { EmptyState } from "@/components/EmptyState"

/** La leyenda del pie: recibido ≠ facturado, revertida ≠ borrada. */
const RECEPTIONS_LEGEND: readonly LegendEntry[] = [
  {
    term: "Sin factura",
    meaning: (
      <>
        compra de plaza, declarada como tal. <b>No es una factura vacía</b>: es una compra que nunca tuvo
        papel, y sólo se acepta si el proveedor no está obligado a facturar.
      </>
    ),
  },
  {
    term: "Revertida",
    meaning: (
      <>
        se deshizo el ingreso al inventario y la cuenta por pagar quedó cancelada. <b>No se borra</b>: queda a
        la vista, con quién la revirtió.
      </>
    ),
  },
]
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { formatBusinessDate } from "@/lib/businessDate"
import { errorMessage } from "@/lib/errors"

import { ReceptionDetailDialog } from "./ReceptionDetailDialog"
import { ReceptionForm } from "./ReceptionForm"
import { defaultDateRange, RECEPTION_STATUS_LABEL, supplierName } from "./lib"

/**
 * Admin → Compras → Recepciones (spec.md § Receptions). Lista con filtros,
 * exportación CSV (el backend sí declara `format` acá, a diferencia de
 * Proveedores) y el formulario de captura — la pantalla que decide si el
 * costo del restaurante es real.
 */
export function ReceptionsTab({ storeId, suppliers }: { storeId: number; suppliers: SupplierOut[] }): React.JSX.Element {
  const [range, setRange] = useState(() => defaultDateRange(30))
  const [supplierId, setSupplierId] = useState<number | null>(null)
  const [status, setStatus] = useState<ReceptionStatus | "all">("all")
  const [creating, setCreating] = useState(false)
  const queryClient = useQueryClient()

  const activeSuppliers = suppliers.filter((s) => s.active)

  const ingredientsQuery = useQuery({
    queryKey: ["inventory", "ingredients", storeId, true],
    queryFn: () => listIngredients(storeId, { activeOnly: true }),
  })

  const query = useQuery({
    queryKey: ["purchases", "receptions", storeId, range.from, range.to, supplierId, status],
    queryFn: () =>
      listReceptions({
        storeId,
        from: range.from,
        to: range.to,
        supplierId,
        status: status === "all" ? undefined : status,
      }),
  })

  const receptions = query.data ?? []
  const ingredients = ingredientsQuery.data ?? []

  function invalidate() {
    void queryClient.invalidateQueries({ queryKey: ["purchases", "receptions"] })
    void queryClient.invalidateQueries({ queryKey: ["purchases", "payables"] })
  }

  const columns: readonly DenseColumn<ReceptionOut>[] = [
    { key: "id", header: "#", kind: "id", cell: (r) => `#${r.id}` },
    {
      key: "supplier",
      header: "Proveedor",
      kind: "name",
      cell: (r) => supplierName(suppliers, r.supplier_id),
    },
    {
      key: "invoice",
      header: "Factura",
      // «Sin factura» NO es «factura número vacío»: es una compra de plaza de
      // mercado, declarada como tal.
      cell: (r) =>
        r.no_invoice ? (
          <span className="text-muted-foreground italic">Sin factura</span>
        ) : (
          (r.invoice_number ?? "—")
        ),
    },
    { key: "date", header: "Fecha", kind: "secondary", cell: (r) => formatBusinessDate(r.invoice_date) },
    { key: "lines", header: "Líneas", kind: "number", cell: (r) => r.lines.length },
    {
      key: "status",
      header: "Estado",
      cell: (r) => (
        <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
          <span
            className={
              r.status === "confirmed" ? "size-1.5 rounded-full bg-success" : "size-1.5 rounded-full bg-muted-foreground"
            }
            aria-hidden="true"
          />
          {RECEPTION_STATUS_LABEL[r.status]}
        </span>
      ),
    },
    {
      key: "actions",
      header: "",
      kind: "actions",
      cell: (r) => <ReceptionDetailDialog reception={r} suppliers={suppliers} ingredients={ingredients} />,
    },
  ]

  if (query.isError) {
    return (
      <EmptyState
        role="alert"
        title="No se pudieron cargar las recepciones"
        description={errorMessage(query.error)}
        action={{ label: "Reintentar", onClick: () => void query.refetch() }}
      />
    )
  }

  return (
    <div className="space-y-3">
      {/* Dependencia: sin proveedores activos no se puede recibir nada, y la
          pantalla lo dice antes de que alguien pulse un botón deshabilitado. */}
      {activeSuppliers.length === 0 ? (
        <DependencyEmptyState
          title="Todavía no hay proveedores activos"
          description="Una recepción elige siempre un proveedor de la lista. Primero tiene que existir alguno activo."
          create={{ label: "Ir a Proveedores", to: "/admin/compras?tab=proveedores" }}
        />
      ) : null}

      <DenseTable
        caption="Recepciones de compra"
        columns={columns}
        rows={receptions}
        rowKey={(r) => String(r.id)}
        rowInactive={(r) => r.status === "reversed"}
        legend={RECEPTIONS_LEGEND}
        bar={
          <DenseTableBar
            shown={receptions.length}
            total={receptions.length}
            noun="recepciones en el rango"
            hidden={
              query.isLoading
                ? "contando…"
                : status !== "all"
                  ? `sólo «${RECEPTION_STATUS_LABEL[status]}»`
                  : undefined
            }
          >
            <DateRangeFilter idPrefix="rec-range" from={range.from} to={range.to} onChange={setRange} />
            <Select
              value={supplierId === null ? "all" : String(supplierId)}
              onValueChange={(value) => setSupplierId(value === "all" ? null : Number(value))}
            >
              <SelectTrigger aria-label="Proveedor" className="h-8 w-40">
                <SelectValue placeholder="Todos los proveedores" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Todos los proveedores</SelectItem>
                {suppliers.map((s) => (
                  <SelectItem key={s.id} value={String(s.id)}>
                    {s.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={status} onValueChange={(value) => setStatus(value as ReceptionStatus | "all")}>
              <SelectTrigger aria-label="Estado" className="h-8 w-36">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Todos los estados</SelectItem>
                <SelectItem value="confirmed">Confirmada</SelectItem>
                <SelectItem value="reversed">Revertida</SelectItem>
              </SelectContent>
            </Select>
            <CsvExportButton
              href={receptionsCsvUrl({
                storeId,
                from: range.from,
                to: range.to,
                supplierId,
                status: status === "all" ? undefined : status,
              })}
            />
            <Dialog open={creating} onOpenChange={setCreating}>
              <DialogTrigger render={<Button size="sm" disabled={activeSuppliers.length === 0} />}>
                Nueva recepción
              </DialogTrigger>
              <DialogContent className="max-w-3xl">
                <DialogHeader>
                  <DialogTitle>Nueva recepción</DialogTitle>
                </DialogHeader>
                <ReceptionForm
                  storeId={storeId}
                  suppliers={activeSuppliers}
                  ingredients={ingredients}
                  onSuccess={() => {
                    setCreating(false)
                    invalidate()
                  }}
                />
              </DialogContent>
            </Dialog>
          </DenseTableBar>
        }
        note={
          <>
            Recibir <b>no es</b> facturar: la cantidad recibida y la facturada se cargan por separado, y la
            diferencia es lo que después discute la cuenta por pagar. Revertir una recepción pide PIN de
            administrador y enumera qué se deshace.
          </>
        }
        empty={
          query.isLoading ? undefined : (
            <EmptyState
              title="Sin recepciones en el rango"
              description="Cambiá el rango de fechas, el proveedor o el estado — o registrá una nueva."
            />
          )
        }
      />
    </div>
  )
}

export default ReceptionsTab
