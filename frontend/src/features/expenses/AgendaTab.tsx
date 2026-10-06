/**
 * Admin → Obligaciones y gastos → Agenda (c5, `GET /admin/obligations/agenda`):
 * qué hay que pagar en los próximos 30 o 60 días, con lo vencido arriba y
 * resaltado. Los totales son de SALDO y los calcula el servidor; esta
 * pantalla sólo pinta. Las copias de recurrentes que todavía no se armaron
 * se listan aparte: no suman porque todavía no existen.
 */
import { useQuery } from "@tanstack/react-query"
import { useState } from "react"

import { getAgenda, type AgendaItem } from "@/api/expenses"
import { DenseTable, DenseTableBar, Segmentado, type DenseColumn } from "@/components/admin"
import { EmptyState } from "@/components/EmptyState"
import { formatBusinessDate } from "@/lib/businessDate"
import { errorMessage } from "@/lib/errors"
import { formatCOP } from "@/lib/money"

import { obligationCategoryLabel, obligationStatusLabel } from "./lib"

const WINDOWS: readonly { value: number; label: string }[] = [
  { value: 30, label: "30 días" },
  { value: 60, label: "60 días" },
]

function whenLabel(item: AgendaItem): string {
  const days = item.days_until_due
  if (days < 0) return days === -1 ? "venció ayer" : `venció hace ${-days} días`
  if (days === 0) return "vence hoy"
  if (days === 1) return "vence mañana"
  return `en ${days} días`
}

export function AgendaTab({ storeId }: { storeId: number }): React.JSX.Element {
  const [days, setDays] = useState<number>(30)
  const query = useQuery({
    queryKey: ["expenses", "obligations", "agenda", storeId, days],
    queryFn: () => getAgenda(storeId, days),
  })

  if (query.isError) {
    return (
      <EmptyState
        role="alert"
        title="No se pudo cargar la agenda"
        description={errorMessage(query.error)}
        action={{ label: "Reintentar", onClick: () => void query.refetch() }}
      />
    )
  }

  const data = query.data
  const rows = data?.items ?? []

  const columns: readonly DenseColumn<AgendaItem>[] = [
    {
      key: "due",
      header: "Vence",
      cell: (i) => (
        <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
          {formatBusinessDate(i.due_date)}
          <span
            className={
              i.overdue
                ? "rounded border border-destructive/40 px-1 text-[0.7rem] font-medium text-destructive"
                : "text-xs text-muted-foreground"
            }
          >
            {whenLabel(i)}
          </span>
        </span>
      ),
    },
    {
      key: "description",
      header: "Descripción",
      kind: "name",
      widthPx: 260,
      cell: (i) => <span className="block truncate">{i.description}</span>,
      cellTitle: (i) => `${i.description} · ${obligationCategoryLabel(i.category)}`,
    },
    { key: "pending", header: "Falta", kind: "number", cell: (i) => formatCOP(i.pending_amount) },
    { key: "amount", header: "Monto", kind: "number", secondary: true, cell: (i) => formatCOP(i.amount) },
    { key: "paid", header: "Pagado", kind: "number", secondary: true, cell: (i) => formatCOP(i.paid_amount) },
    { key: "status", header: "Estado", cell: (i) => obligationStatusLabel(i.status) },
  ]

  return (
    <div className="space-y-4">
      {data ? (
        <dl className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div
            className={
              data.overdue_count > 0
                ? "rounded-lg border border-destructive/50 bg-destructive/5 p-3"
                : "rounded-lg border p-3"
            }
          >
            <dt className="text-sm text-muted-foreground">Vencido</dt>
            <dd className={data.overdue_count > 0 ? "text-xl font-semibold text-destructive" : "text-xl font-semibold"}>
              {formatCOP(data.overdue_total)}
            </dd>
            <dd className="text-xs text-muted-foreground">
              {data.overdue_count === 1 ? "1 obligación" : `${data.overdue_count} obligaciones`}
            </dd>
          </div>
          <div className="rounded-lg border p-3">
            <dt className="text-sm text-muted-foreground">Vence hasta el {formatBusinessDate(data.horizon)}</dt>
            <dd className="text-xl font-semibold">{formatCOP(data.upcoming_total)}</dd>
          </div>
          <div className="rounded-lg border p-3">
            <dt className="text-sm text-muted-foreground">Total por pagar</dt>
            <dd className="text-xl font-semibold">{formatCOP(data.total_pending)}</dd>
          </div>
        </dl>
      ) : null}

      <DenseTable
        caption="Agenda de pagos"
        columns={columns}
        rows={rows}
        rowKey={(i) => String(i.obligation_id)}
        rowStatus={(i) => (i.overdue ? "critical" : i.days_until_due <= 7 ? "warning" : "none")}
        bar={
          <DenseTableBar shown={rows.length} total={rows.length} noun="por pagar">
            <Segmentado etiqueta="Ventana de la agenda" opciones={WINDOWS} valor={days} onChange={setDays} chico />
          </DenseTableBar>
        }
        empty={
          query.isLoading ? undefined : (
            <EmptyState
              title="Nada por pagar en esta ventana"
              description="No hay obligaciones con saldo que venzan en estos días ni vencidas."
            />
          )
        }
      />

      {data && data.not_generated.length > 0 ? (
        <section aria-labelledby="agenda-not-generated" className="space-y-2 rounded-lg border border-dashed p-3">
          <h3 id="agenda-not-generated" className="text-sm font-medium">
            Recurrentes que todavía no se armaron
          </h3>
          <p className="text-xs text-muted-foreground">
            Vencen en esta ventana pero no están en la agenda ni en los totales: armá el mes en «Recurrentes».
          </p>
          <ul className="space-y-1 text-sm">
            {data.not_generated.map((line) => (
              <li key={`${line.template_id}-${line.period_month}`}>
                {formatBusinessDate(line.due_date)} · {line.description} · {formatCOP(line.amount)}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  )
}

export default AgendaTab
