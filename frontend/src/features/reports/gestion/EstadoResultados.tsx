import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useId, useState } from "react"

import {
  getMonthlyPnl,
  putPnlBudget,
  type PnlBudgetLine,
  type PnlCellOut,
  type PnlOut,
  type PnlRowOut,
} from "@/api/expenses"
import { Cargando } from "@/components/Cargando"
import { CsvExportButton } from "@/components/CsvExportButton"
import { MoneyInput } from "@/components/MoneyInput"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { csvUrl } from "@/api/client"
import { errorMessage } from "@/lib/errors"
import { formatCOP } from "@/lib/money"
import { cn } from "@/lib/utils"

import { formatPctConSigno } from "../lib"

/**
 * Estado de resultados de 12 meses (h7): ventas, costo de lo vendido, nómina,
 * obligaciones, gastos y utilidad por mes —cada mes con la misma cuenta de
 * Gastos → Utilidad—, y un presupuesto opcional por renglón con su
 * desviación. La desviación y de qué lado quedó (`outside`) las decide el
 * servidor; acá sólo se pintan.
 */

const RENGLONES_PRESUPUESTO: { value: PnlBudgetLine; label: string }[] = [
  { value: "net_sales", label: "Ventas netas" },
  { value: "cost", label: "Costo de lo vendido" },
  { value: "payroll", label: "Nómina" },
  { value: "obligations", label: "Obligaciones" },
  { value: "expenses", label: "Gastos" },
]

function Celda({ cell, fuerte }: { cell: PnlCellOut; fuerte?: boolean }): React.JSX.Element {
  return (
    <div className="flex flex-col items-end">
      <span className={cn("tabular-nums", fuerte && "font-bold", fuerte && cell.amount !== null && cell.amount < 0 && "text-destructive")}>
        {cell.amount === null ? <span className="sin-dato sin-dato--calmo">sin dato</span> : formatCOP(cell.amount)}
      </span>
      {cell.budget !== null ? (
        <span
          className={cn("text-[11px] tabular-nums", cell.outside ? "font-semibold text-warning" : "text-muted-foreground")}
          title={`Presupuesto ${formatCOP(cell.budget)}`}
        >
          pres. {formatCOP(cell.budget)}
          {cell.variance !== null ? (
            <>
              {" · "}
              {cell.outside ? "▼ " : ""}
              {cell.variance_bp !== null ? formatPctConSigno(cell.variance_bp, 0) : formatCOP(cell.variance)}
            </>
          ) : null}
        </span>
      ) : null}
    </div>
  )
}

function FormularioPresupuesto({
  storeId,
  data,
  onGuardado,
}: {
  storeId: number
  data: PnlOut
  onGuardado: () => void
}): React.JSX.Element {
  const idMes = useId()
  const idRenglon = useId()
  const ultimo = data.months[data.months.length - 1]!
  const [mes, setMes] = useState(`${ultimo.year}-${ultimo.month}`)
  const [renglon, setRenglon] = useState<PnlBudgetLine>("net_sales")
  const [monto, setMonto] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const guardar = useMutation({
    mutationFn: (amount: number | null) => {
      const [y, m] = mes.split("-").map(Number)
      return putPnlBudget(storeId, { year: y!, month: m!, line: renglon, amount })
    },
    onSuccess: () => {
      setError(null)
      onGuardado()
    },
    onError: (e) => setError(errorMessage(e)),
  })
  const etiquetaMes = (v: string): string => data.months.find((m) => `${m.year}-${m.month}` === v)?.label ?? v
  return (
    <div className="flex flex-wrap items-end gap-3 rounded-lg border bg-muted/40 p-3">
      <div className="flex flex-col gap-1">
        <Label htmlFor={idMes} className="text-xs">
          Mes
        </Label>
        <Select value={mes} onValueChange={(v) => setMes(v ?? mes)}>
          <SelectTrigger id={idMes} className="h-9 w-32">
            <SelectValue>{(v: string) => etiquetaMes(v)}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {data.months.map((m) => (
              <SelectItem key={`${m.year}-${m.month}`} value={`${m.year}-${m.month}`}>
                {m.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor={idRenglon} className="text-xs">
          Renglón
        </Label>
        <Select value={renglon} onValueChange={(v) => setRenglon((v ?? renglon) as PnlBudgetLine)}>
          <SelectTrigger id={idRenglon} className="h-9 w-48">
            <SelectValue>{(v: string) => RENGLONES_PRESUPUESTO.find((r) => r.value === v)?.label ?? v}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {RENGLONES_PRESUPUESTO.map((r) => (
              <SelectItem key={r.value} value={r.value}>
                {r.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <MoneyInput aria-label="Presupuesto" value={monto} onChange={setMonto} className="h-9 w-40 text-right" />
      <Button type="button" size="sm" disabled={guardar.isPending || monto === null} onClick={() => guardar.mutate(monto)}>
        Guardar presupuesto
      </Button>
      <Button type="button" size="sm" variant="ghost" disabled={guardar.isPending} onClick={() => guardar.mutate(null)}>
        Quitar
      </Button>
      {error ? (
        <p role="alert" className="w-full text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  )
}

export function EstadoResultados({ storeId, year, month }: { storeId: number; year: number; month: number }): React.JSX.Element {
  const id = useId()
  const queryClient = useQueryClient()
  const [editando, setEditando] = useState(false)
  const queryKey = ["expenses", "pnl", storeId, year, month]
  const query = useQuery({ queryKey, queryFn: () => getMonthlyPnl({ storeId, year, month }) })
  const data = query.data
  return (
    <section aria-labelledby={id} className="flex min-w-0 flex-col gap-2.5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <h2 id={id} className="text-lg leading-snug font-bold">
          Estado de resultados
        </h2>
        <span className="text-[13px] text-muted-foreground">Los últimos 12 meses, contra el presupuesto</span>
        <div className="ml-auto flex items-center gap-2">
          <Button type="button" size="sm" variant="outline" onClick={() => setEditando((v) => !v)}>
            {editando ? "Cerrar presupuesto" : "Presupuesto"}
          </Button>
          <CsvExportButton href={csvUrl("/admin/profit/monthly", { store_id: storeId, year, month })} />
        </div>
      </div>
      {query.isLoading ? (
        <Cargando texto="Armando el estado de resultados…" />
      ) : query.isError ? (
        <p role="alert" className="text-sm text-destructive">
          {errorMessage(query.error)}
        </p>
      ) : data ? (
        <>
          {editando ? (
            <FormularioPresupuesto
              storeId={storeId}
              data={data}
              onGuardado={() => void queryClient.invalidateQueries({ queryKey })}
            />
          ) : null}
          <div className="overflow-x-auto rounded-lg border bg-card">
            <table className="w-full min-w-[960px] text-sm">
              <caption className="sr-only">Estado de resultados por mes, con presupuesto y desviación</caption>
              <thead>
                <tr className="border-b text-xs text-muted-foreground">
                  <th scope="col" className="px-3 py-2 text-left font-semibold">
                    Renglón
                  </th>
                  {data.months.map((m) => (
                    <th key={`${m.year}-${m.month}`} scope="col" className="px-2 py-2 text-right font-semibold whitespace-nowrap">
                      {m.label}
                      {m.in_progress ? <span className="block font-normal">en curso</span> : null}
                    </th>
                  ))}
                  <th scope="col" className="px-3 py-2 text-right font-semibold">
                    12 meses
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((row: PnlRowOut) => (
                  <tr key={row.key} className={cn("border-b last:border-b-0", row.key === "profit" && "bg-muted/40")}>
                    <th scope="row" className="px-3 py-2 text-left font-medium whitespace-nowrap">
                      {row.label}
                    </th>
                    {row.cells.map((cell, i) => (
                      <td key={i} className="px-2 py-2 text-right align-top">
                        <Celda cell={cell} fuerte={row.key === "profit"} />
                      </td>
                    ))}
                    <td className="px-3 py-2 text-right align-top">
                      <Celda cell={row.total} fuerte />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <NotaCostoReal data={data} />
        </>
      ) : null}
    </section>
  )
}

/** La utilidad usa el costo teórico; si algún mes tiene costo real, se dice al lado. */
function NotaCostoReal({ data }: { data: PnlOut }): React.JSX.Element {
  const conReal = data.months.filter((m) => m.cost_real !== null)
  return (
    <p className="text-xs text-muted-foreground">
      La utilidad de cada mes usa el costo teórico de lo vendido (el de las fichas), igual que Gastos → Utilidad.{" "}
      {conReal.length === 0
        ? "Ningún mes tiene conteos de inventario que lo cubran entero, así que todavía no hay costo real para comparar."
        : conReal
            .map(
              (m) =>
                `${m.label}: costo real ${formatCOP(m.cost_real)}${
                  m.profit_with_real_cost !== null ? `, utilidad con costo real ${formatCOP(m.profit_with_real_cost)}` : ""
                }`,
            )
            .join(" · ")}
      {" "}Un mes sin dato dice por qué en Gastos → Utilidad.
    </p>
  )
}
