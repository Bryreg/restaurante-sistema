import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useState } from "react"

import { listIngredients } from "@/api/inventory"
import { listReceptions, receptionsCsvUrl, type ReceptionOut, type ReceptionStatus, type SupplierOut } from "@/api/purchases"
import { CsvExportButton } from "@/components/CsvExportButton"
import DateRangeFilter from "@/components/DateRangeFilter"
import { EmptyState } from "@/components/EmptyState"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
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

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-wrap items-end gap-3">
          <DateRangeFilter idPrefix="rec-range" from={range.from} to={range.to} onChange={setRange} />
          <div className="space-y-1">
            <Select
              value={supplierId === null ? "all" : String(supplierId)}
              onValueChange={(value) => setSupplierId(value === "all" ? null : Number(value))}
            >
              <SelectTrigger aria-label="Proveedor" className="h-10 w-48">
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
          </div>
          <div className="space-y-1">
            <Select value={status} onValueChange={(value) => setStatus(value as ReceptionStatus | "all")}>
              <SelectTrigger aria-label="Estado" className="h-10 w-44">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Todos los estados</SelectItem>
                <SelectItem value="confirmed">Confirmada</SelectItem>
                <SelectItem value="reversed">Revertida</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <CsvExportButton
            href={receptionsCsvUrl({ storeId, from: range.from, to: range.to, supplierId, status: status === "all" ? undefined : status })}
          />
          <Dialog open={creating} onOpenChange={setCreating}>
            <DialogTrigger render={<Button disabled={activeSuppliers.length === 0} />}>Nueva recepción</DialogTrigger>
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
        </div>
      </div>
      {activeSuppliers.length === 0 ? (
        <p className="text-sm text-muted-foreground">Creá al menos un proveedor activo en la pestaña «Proveedores» antes de recibir mercancía.</p>
      ) : null}

      {query.isLoading ? (
        <p className="text-sm text-muted-foreground">Cargando recepciones…</p>
      ) : query.isError ? (
        <EmptyState
          role="alert"
          title="No se pudieron cargar las recepciones"
          description={errorMessage(query.error)}
          action={{ label: "Reintentar", onClick: () => void query.refetch() }}
        />
      ) : receptions.length === 0 ? (
        <EmptyState title="Sin recepciones en el rango" description="Cambiá el rango de fechas o registrá una nueva." />
      ) : (
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>#</TableHead>
                <TableHead>Proveedor</TableHead>
                <TableHead>Factura</TableHead>
                <TableHead>Fecha</TableHead>
                <TableHead>Líneas</TableHead>
                <TableHead>Estado</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {receptions.map((reception: ReceptionOut) => (
                <TableRow key={reception.id}>
                  <TableCell className="tabular-nums">{reception.id}</TableCell>
                  <TableCell className="font-medium">{supplierName(suppliers, reception.supplier_id)}</TableCell>
                  <TableCell>{reception.no_invoice ? "Sin factura" : (reception.invoice_number ?? "—")}</TableCell>
                  <TableCell>{formatBusinessDate(reception.invoice_date)}</TableCell>
                  <TableCell className="tabular-nums">{reception.lines.length}</TableCell>
                  <TableCell>
                    <Badge variant={reception.status === "confirmed" ? "secondary" : "outline"}>
                      {RECEPTION_STATUS_LABEL[reception.status]}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <ReceptionDetailDialog reception={reception} suppliers={suppliers} ingredients={ingredients} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  )
}

export default ReceptionsTab
