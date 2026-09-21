import { useQuery } from "@tanstack/react-query"
import { useState } from "react"

import { listPayables, payablesCsvUrl, type PayableOut, type PayableStatus, type SupplierOut } from "@/api/purchases"
import { CsvExportButton } from "@/components/CsvExportButton"
import DateRangeFilter from "@/components/DateRangeFilter"
import {
  DenseTable,
  DenseTableBar,
  FilterEmptyState,
  type DenseColumn,
  type LegendEntry,
} from "@/components/admin"
import { EmptyState } from "@/components/EmptyState"

/** La leyenda del pie: los tres estados NO son grados de lo mismo. */
const PAYABLES_LEGEND: readonly LegendEntry[] = [
  {
    term: "Pendiente de revisión",
    meaning: (
      <>
        nadie la aprobó todavía, y <b>sin aprobar no se puede pagar</b>. Es el control entre quien recibe y
        quien paga.
      </>
    ),
  },
  {
    term: "Vencida",
    meaning: "pasó el plazo del proveedor y sigue con saldo. No la aprueba ni la cancela nadie por vieja.",
  },
  {
    term: "Cancelada",
    meaning: "la recepción que la originó se revirtió. No es «pagada»: es que ya no hay nada que pagar.",
  },
]
import { Checkbox } from "@/components/ui/checkbox"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
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

  const overdue = payables.filter((p) => p.overdue).length

  const columns: readonly DenseColumn<PayableOut>[] = [
    { key: "id", header: "#", kind: "id", cell: (p) => `#${p.id}` },
    {
      key: "supplier",
      header: "Proveedor",
      kind: "name",
      cell: (p) => supplierName(suppliers, p.supplier_id),
    },
    {
      key: "status",
      header: "Estado",
      cell: (p) => (
        <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
          <span
            className={
              p.status === "approved"
                ? "size-1.5 rounded-full bg-success"
                : p.status === "cancelled"
                  ? "size-1.5 rounded-full bg-muted-foreground"
                  : "size-1.5 rounded-full bg-warning"
            }
            aria-hidden="true"
          />
          {PAYABLE_STATUS_LABEL[p.status]}
          {p.overdue ? (
            <span className="rounded border border-destructive/40 px-1 text-[0.7rem] text-destructive">Vencida</span>
          ) : null}
        </span>
      ),
    },
    { key: "due", header: "Vencimiento", cell: (p) => formatBusinessDate(p.due_date) },
    { key: "amount", header: "Total", kind: "number", cell: (p) => formatCOP(p.amount) },
    {
      key: "balance",
      header: "Saldo",
      kind: "number",
      cell: (p) => <span className="font-bold">{formatCOP(p.balance)}</span>,
    },
    {
      key: "actions",
      header: "",
      kind: "actions",
      cell: (p) => (
        <PayableDetailDialog payable={p} supplierLabel={supplierName(suppliers, p.supplier_id)} />
      ),
    },
  ]

  if (query.isError) {
    return (
      <EmptyState
        role="alert"
        title="No se pudieron cargar las cuentas por pagar"
        description={errorMessage(query.error)}
        action={{ label: "Reintentar", onClick: () => void query.refetch() }}
      />
    )
  }

  return (
    <DenseTable
      caption="Cuentas por pagar"
      columns={columns}
      rows={payables}
      rowKey={(p) => String(p.id)}
      rowInactive={(p) => p.status === "cancelled"}
      rowStatus={(p) => (p.overdue ? "critical" : p.status === "pending_review" ? "warning" : "none")}
      legend={PAYABLES_LEGEND}
      bar={
        <DenseTableBar
          shown={payables.length}
          total={payables.length}
          noun="cuentas por pagar"
          hidden={query.isLoading ? "contando…" : overdue > 0 ? `${overdue} ya vencidas` : undefined}
        >
          <DateRangeFilter idPrefix="pay-range" from={range.from} to={range.to} onChange={setRange} />
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
          <Select value={status} onValueChange={(value) => setStatus(value as PayableStatus | "all")}>
            <SelectTrigger aria-label="Estado" className="h-8 w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Todos los estados</SelectItem>
              <SelectItem value="pending_review">Pendiente de revisión</SelectItem>
              <SelectItem value="approved">Aprobada</SelectItem>
              <SelectItem value="cancelled">Cancelada</SelectItem>
            </SelectContent>
          </Select>
          <div className="flex items-center gap-2">
            <Checkbox id="pay-overdue" checked={overdueOnly} onCheckedChange={(v) => setOverdueOnly(v === true)} />
            <Label htmlFor="pay-overdue">Sólo vencidas</Label>
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
        </DenseTableBar>
      }
      note={
        <>
          <b>Sin aprobar no se puede pagar</b>: aprobar es el control entre quien recibió la mercancía y quien
          paga la plata, y pide PIN de administrador. Pagar «desde el cajón» además crea un egreso en el turno
          abierto.
        </>
      }
      empty={
        query.isLoading ? undefined : overdueOnly ? (
          <FilterEmptyState
            title="Sin cuentas por pagar en el rango"
            filters={["sólo vencidas"]}
            onRemove={() => setOverdueOnly(false)}
          />
        ) : (
          <EmptyState
            title="Sin cuentas por pagar en el rango"
            description="Una recepción confirmada crea una automáticamente. Probá otro rango de fechas."
          />
        )
      }
    />
  )
}

export default PayablesTab
