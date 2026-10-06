/**
 * Lo que viene (`GET /admin/bank/projection`): con cuánto cerraría el banco
 * los próximos meses, desde el saldo de hoy, las obligaciones agendadas, las
 * cuentas por pagar, los gastos recurrentes y lo que entra en un mes normal.
 * Una guía, no una promesa. Toda cifra viene del servidor; un dato que no se
 * puede estimar va con su motivo, nunca como $ 0.
 */
import { useQuery } from "@tanstack/react-query"
import { useState } from "react"

import { getBankProjection, type BankProjectionMonthOut } from "@/api/banking"
import { Cargando } from "@/components/Cargando"
import { EmptyState } from "@/components/EmptyState"
import { SinDato } from "@/components/SinDato"
import { DenseTable, type DenseColumn } from "@/components/admin"
import { formatBusinessDateShort } from "@/lib/businessDate"
import { errorMessage } from "@/lib/errors"
import { formatCOP } from "@/lib/money"

const MESES = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"]

function nombreDeFila(m: BankProjectionMonthOut): string {
  const mes = MESES[m.month - 1] ?? String(m.month)
  // La primera fila puede ser lo que queda del mes en curso: se dice con sus fechas.
  if (!m.date_from.endsWith("-01")) return `Resto de ${mes} (desde el ${formatBusinessDateShort(m.date_from)})`
  return `${mes.charAt(0).toUpperCase()}${mes.slice(1)} ${m.year}`
}

const COLUMNS: readonly DenseColumn<BankProjectionMonthOut>[] = [
  { key: "month", header: "Mes", kind: "name", cell: nombreDeFila },
  { key: "in", header: "Entraría", kind: "number", cell: (m) => formatCOP(m.expected_inflows) },
  {
    key: "out",
    header: "Obligaciones y cuentas por pagar",
    kind: "number",
    cell: (m) => `${formatCOP(m.scheduled_obligations)} · ${formatCOP(m.payables_due)}`,
  },
  { key: "recurring", header: "Gastos recurrentes", kind: "number", cell: (m) => formatCOP(m.recurring_expenses) },
  { key: "closing", header: "Cierre estimado", kind: "number", cell: (m) => formatCOP(m.closing_balance) },
  { key: "gmf", header: "4×1000", kind: "number", secondary: true, cell: (m) => formatCOP(m.gmf) },
  { key: "net", header: "Neto del mes", kind: "number", secondary: true, cell: (m) => formatCOP(m.net) },
]

export function BankProjection({ storeId }: { storeId: number }): React.JSX.Element {
  const [months, setMonths] = useState(3)
  const query = useQuery({
    queryKey: ["banking", "projection", storeId, months],
    queryFn: () => getBankProjection(storeId, months),
  })
  const data = query.data
  return (
    <section aria-labelledby="banco-proyeccion" className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <h2 id="banco-proyeccion" className="text-base font-semibold">
          Lo que viene
        </h2>
        <label className="inline-flex items-center gap-2 text-sm">
          Meses
          <select
            className="h-9 rounded-md border border-input bg-card px-2"
            value={months}
            onChange={(e) => setMonths(Number(e.target.value))}
          >
            <option value={1}>1</option>
            <option value={2}>2</option>
            <option value={3}>3</option>
          </select>
        </label>
      </div>
      {query.isLoading ? (
        <Cargando texto="Calculando lo que viene…" />
      ) : query.isError || !data ? (
        <EmptyState
          reason="error"
          title="No se pudo calcular la proyección"
          description={errorMessage(query.error)}
          action={{ label: "Reintentar", onClick: () => void query.refetch() }}
        />
      ) : (
        <div className="space-y-2">
          <p className="text-sm text-muted-foreground">
            Una guía para prepararse, no una promesa: arranca del saldo de hoy, suma lo que entra en un mes normal
            {data.history_months > 0 ? ` (promedio de ${data.history_months} ${data.history_months === 1 ? "mes" : "meses"})` : ""} y
            resta las obligaciones agendadas, las cuentas por pagar que vencen y los gastos que se repiten. Lo vencido
            sin pagar va en la primera fila.
          </p>
          {data.reason ? <SinDato motivo={data.reason} forma="bloque" /> : null}
          <DenseTable
            caption="Cierre estimado del banco en los próximos meses."
            columns={COLUMNS}
            rows={data.months}
            rowKey={(m) => m.date_from}
          />
        </div>
      )}
    </section>
  )
}

export default BankProjection
