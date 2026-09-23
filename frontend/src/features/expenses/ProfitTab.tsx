/**
 * Admin → Obligaciones y gastos → Utilidad del período (T2,
 * `GET /admin/profit`): ventas netas, costo, nómina, obligaciones y gastos,
 * hasta `profit`. Todos los números YA vienen sumados por el servidor —
 * ninguna resta acá (AGENTS.md § "una sola matemática, en el backend").
 * `available`/`reason` mandan igual que en punto de equilibrio.
 *
 * Informe de visualización #2: el titular concluye («Perdiste $X: la nómina
 * se come el 36 % de la venta»), la pérdida va en tono crítico, y cada
 * renglón lleva su % de la venta (`lines[].pct_of_sales_bp`) con el período
 * anterior al lado (`previous_period`, calculado por el servidor con la
 * misma matemática, nunca restado acá). Los costos fijos son EXACTAMENTE los
 * del punto de equilibrio: las dos pestañas no pueden contradecirse.
 */
import { useQuery } from "@tanstack/react-query"
import { useState } from "react"

import { getProfit, type ProfitLine } from "@/api/expenses"
import { DenseTable, FilterLink, HeadlineFigure, type DenseColumn } from "@/components/admin"
import { DateRangeFilter } from "@/components/DateRangeFilter"
import { EmptyState } from "@/components/EmptyState"
import { SinDato } from "@/components/SinDato"
import { formatPct } from "@/lib/format"
import { errorMessage } from "@/lib/errors"
import { formatCOP } from "@/lib/money"
import { cn } from "@/lib/utils"
import { formatRangoCorto } from "@/features/reports/lib"

import { daysAgoLocal, todayLocal } from "./lib"
import { lineOf, profitHeadline, type LineKey } from "./titulares"

/** Monto de un renglón o su «sin datos» con motivo. */
function Monto({ line, reason }: { line: ProfitLine | null; reason: string | null }): React.JSX.Element {
  if (line === null || line.amount === null) return <SinDato motivo={reason} />
  const perdida = line.key === "profit" && line.amount < 0
  return (
    <span className={cn(line.key === "profit" && "font-bold", perdida && "text-destructive")}>
      {perdida ? <span aria-hidden="true">▼ </span> : null}
      {formatCOP(line.amount)}
    </span>
  )
}

interface Fila {
  key: LineKey
  label: string
  actual: ProfitLine | null
  anterior: ProfitLine | null
}

export function ProfitTab({ storeId }: { storeId: number }): React.JSX.Element {
  const [from, setFrom] = useState(daysAgoLocal(30))
  const [to, setTo] = useState(todayLocal())

  const query = useQuery({
    queryKey: ["expenses", "profit", storeId, from, to],
    queryFn: () => getProfit({ storeId, from, to }),
  })

  const d = query.data
  const prev = d?.previous_period ?? null
  const prevRange = prev?.date_from && prev.date_to ? formatRangoCorto(prev.date_from, prev.date_to) : null

  // Del renglón publicado; si el servidor no mandó `lines`, del campo suelto.
  const value = (key: LineKey): string => {
    const line = lineOf(d, key)
    return formatCOP(line ? line.amount : (d?.[key] ?? null))
  }
  const pctTxt = (l: ProfitLine | null): string => (l?.pct_of_sales_bp === null || l?.pct_of_sales_bp === undefined ? "—" : formatPct(l.pct_of_sales_bp))

  const filas: Fila[] = (d?.lines ?? []).map((l) => ({
    key: l.key,
    label: l.label,
    actual: l,
    anterior: lineOf(prev, l.key),
  }))

  const columns: readonly DenseColumn<Fila>[] = [
    { key: "label", header: "Renglón", kind: "name", cell: (f) => f.label },
    {
      key: "amount",
      header: "Este período",
      kind: "number",
      cell: (f) => <Monto line={f.actual} reason={d?.reason ?? d?.payroll_reason ?? null} />,
    },
    { key: "pct", header: "% de la venta", kind: "number", cell: (f) => pctTxt(f.actual) },
    {
      key: "prev",
      header: prevRange ? `Anterior (${prevRange})` : "Período anterior",
      kind: "number",
      cell: (f) =>
        prev === null ? "—" : <Monto line={f.anterior} reason={prev.reason ?? prev.payroll_reason ?? null} />,
    },
    { key: "prev_pct", header: "% de la venta", kind: "number", cell: (f) => pctTxt(f.anterior) },
  ]

  /** La comparación de la banda: la utilidad anterior tal como la manda el servidor. */
  const comparison = (() => {
    if (prev === null) return undefined
    const label = `Período anterior${prevRange ? ` (${prevRange})` : ""}`
    if (!prev.available || prev.profit === null) {
      return { label, delta: "Sin dato", detail: prev.reason ?? undefined }
    }
    const pct = lineOf(prev, "profit")?.pct_of_sales_bp
    return {
      label,
      delta: formatCOP(prev.profit),
      detail:
        pct === null || pct === undefined
          ? prev.net_sales === 0
            ? "sin ventas en ese período"
            : undefined
          : `${formatPct(pct)} de la venta`,
    }
  })()

  const perdida = d?.profit !== null && d?.profit !== undefined && d.profit < 0

  return (
    <div className="space-y-4">
      <DateRangeFilter
        idPrefix="profit"
        from={from}
        to={to}
        onChange={(r) => {
          setFrom(r.from)
          setTo(r.to)
        }}
      />

      {query.isLoading ? (
        <p className="text-sm text-muted-foreground">Calculando la utilidad del período…</p>
      ) : query.isError ? (
        <EmptyState
          role="alert"
          title="No se pudo calcular la utilidad"
          description={errorMessage(query.error)}
          action={{ label: "Reintentar", onClick: () => void query.refetch() }}
        />
      ) : !d?.available ? (
        <EmptyState
          title="Utilidad no disponible"
          description={d?.reason ?? "Faltan datos del período para calcularla."}
        />
      ) : (
        <div className="space-y-4">
          <h3
            data-testid="profit-headline"
            data-tono={perdida ? "critico" : "normal"}
            className={cn("text-lg leading-snug font-semibold", perdida && "text-destructive")}
          >
            {perdida ? <span aria-hidden="true">▼ </span> : null}
            {profitHeadline(d)}
          </h3>
          {/* Patrón 4 · Banda de cifra: la utilidad es la resta de los
              renglones, no un número suelto. El libro la muestra hecha; el
              servidor sigue siendo el único que la calcula. La pérdida tiñe
              la cifra de rojo (sólo el rojo dice «falta plata»). */}
          <HeadlineFigure
            label="Utilidad del período"
            value={formatCOP(d.profit)}
            note={
              perdida
                ? "pérdida: lo vendido no alcanzó a cubrir lo que costó tener abierto"
                : "lo que queda después de todo lo que costó tener abierto"
            }
            className={cn(perdida && "border-destructive/30 [&_.text-4xl]:text-destructive")}
            ledger={{
              rows: [
                { label: "Ventas netas", value: value("net_sales") },
                { label: "Costo de lo vendido", value: value("cost"), kind: "subtract" },
                { label: "Nómina", value: value("payroll"), kind: "subtract" },
                { label: "Obligaciones", value: value("obligations"), kind: "subtract" },
                { label: "Gastos", value: value("expenses"), kind: "subtract" },
              ],
              total: { label: "Utilidad", value: formatCOP(d.profit) },
            }}
            comparison={comparison}
          />

          <DenseTable
            caption="Estado de resultados: cada renglón con su % de la venta y el período anterior al lado."
            columns={columns}
            rows={filas}
            rowKey={(f) => f.key}
            rowStatus={(f) => (f.key === "profit" && perdida ? "critical" : "none")}
            note={
              <>
                Los costos fijos (nómina + obligaciones + gastos: {formatCOP(d.fixed_costs ?? null)}) son los mismos del
                punto de equilibrio. El período anterior tiene la misma cantidad de días y la misma cuenta.
                {d.costed_pct !== null && d.costed_pct !== undefined
                  ? ` El costo de lo vendido sale de las fichas técnicas, que cubren el ${formatPct(d.costed_pct * 100, 0)} de la venta.`
                  : ""}
              </>
            }
          />
          <FilterLink to="/admin/gastos?tab=equilibrio" screen="Obligaciones y gastos" tab="Punto de equilibrio" />
        </div>
      )}
    </div>
  )
}

export default ProfitTab
