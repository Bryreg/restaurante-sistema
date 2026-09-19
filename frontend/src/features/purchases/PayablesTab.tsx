import { useQuery } from "@tanstack/react-query"
import { useState } from "react"

import { listPayables, payablesCsvUrl, type PayableOut, type PayableStatus, type SupplierOut } from "@/api/purchases"
import { CsvExportButton } from "@/components/CsvExportButton"
import DateRangeFilter from "@/components/DateRangeFilter"
import { EmptyState } from "@/components/EmptyState"
import { Badge } from "@/components/ui/badge"
import { Checkbox } from "@/components/ui/checkbox"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { formatBusinessDate } from "@/lib/businessDate"
import { errorMessage } from "@/lib/errors"
import { formatCOP } from "@/lib/money"

import { PayableDetailDialog } from "./PayableDetailDialog"
import { defaultDateRange, PAYABLE_STATUS_LABEL, supplierName } from "./lib"

/**
 * Admin → Compras → Cuentas por pagar (SPEC-NEGOCIO §9.3: «¿a quién le
 * debo?»). El saldo es SIEMPRE el que manda el servidor (`PayableOut.
 * balance`, derivado de los pagos vivos) — esta pantalla nunca lo calcula.
 * Mientras una cuenta está `pending_review` no hay ningún botón de pagar
 * en su detalle (`PayableDetailDialog`): es el control mínimo entre quien
 * recibe y quien paga.
 */
export function PayablesTab({ storeId, suppliers }: { storeId: number; suppliers: SupplierOut[] }): React.JSX.Element {
  const [range, setRange] = useState(() => defaultDateRange(90))
  const [supplierId, setSupplierId] = useState<number | null>(null)
  const [status, setStatus] = useState<PayableStatus | "all">("all")
  const [overdueOnly, setOverdueOnly] = useState(false)

  const query = useQuery({
    queryKey: ["purchases", "payables", storeId, range.from, range.to, supplierId, status, overdueOnly],
    queryFn: () =>
      listPayables({
        storeId,
        from: range.from,
        to: range.to,
        supplierId,
        status: status === "all" ? undefined : status,
        overdue: overdueOnly ? true : undefined,
      }),
  })

  const payables = query.data ?? []

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-wrap items-end gap-3">
          <DateRangeFilter idPrefix="pay-range" from={range.from} to={range.to} onChange={setRange} />
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
          <Select value={status} onValueChange={(value) => setStatus(value as PayableStatus | "all")}>
            <SelectTrigger aria-label="Estado" className="h-10 w-48">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Todos los estados</SelectItem>
              <SelectItem value="pending_review">Pendiente de revisión</SelectItem>
              <SelectItem value="approved">Aprobada</SelectItem>
              <SelectItem value="cancelled">Cancelada</SelectItem>
            </SelectContent>
          </Select>
          <div className="flex items-center gap-2 pb-2">
            <Checkbox id="pay-overdue" checked={overdueOnly} onCheckedChange={(v) => setOverdueOnly(v === true)} />
            <Label htmlFor="pay-overdue">Sólo vencidas</Label>
          </div>
        </div>
        <CsvExportButton
          href={payablesCsvUrl({
            storeId,
            from: range.from,
            to: range.to,
            supplierId,
            status: status === "all" ? undefined : status,
            overdue: overdueOnly ? true : undefined,
          })}
        />
      </div>

      {query.isLoading ? (
        <p className="text-sm text-muted-foreground">Cargando cuentas por pagar…</p>
      ) : query.isError ? (
        <EmptyState
          role="alert"
          title="No se pudieron cargar las cuentas por pagar"
          description={errorMessage(query.error)}
          action={{ label: "Reintentar", onClick: () => void query.refetch() }}
        />
      ) : payables.length === 0 ? (
        <EmptyState title="Sin cuentas por pagar en el rango" description="Una recepción confirmada crea una automáticamente." />
      ) : (
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>#</TableHead>
                <TableHead>Proveedor</TableHead>
                <TableHead>Estado</TableHead>
                <TableHead>Vencimiento</TableHead>
                <TableHead>Total</TableHead>
                <TableHead>Saldo</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {payables.map((payable: PayableOut) => (
                <TableRow key={payable.id}>
                  <TableCell className="tabular-nums">{payable.id}</TableCell>
                  <TableCell className="font-medium">{supplierName(suppliers, payable.supplier_id)}</TableCell>
                  <TableCell>
                    <Badge variant={payable.status === "approved" ? "secondary" : "outline"}>{PAYABLE_STATUS_LABEL[payable.status]}</Badge>
                    {payable.overdue ? (
                      <Badge variant="destructive" className="ml-1">
                        Vencida
                      </Badge>
                    ) : null}
                  </TableCell>
                  <TableCell>{formatBusinessDate(payable.due_date)}</TableCell>
                  <TableCell className="tabular-nums">{formatCOP(payable.amount)}</TableCell>
                  <TableCell className="tabular-nums font-semibold">{formatCOP(payable.balance)}</TableCell>
                  <TableCell>
                    <PayableDetailDialog payable={payable} supplierLabel={supplierName(suppliers, payable.supplier_id)} />
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

export default PayablesTab
