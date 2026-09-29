import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  Calculator,
  CalendarDays,
  Check,
  CreditCard,
  Download,
  Landmark,
  Pencil,
  Printer,
  Receipt,
  Target,
  TrendingDown,
  TrendingUp,
  Wallet,
  X,
  type LucideIcon,
} from "lucide-react"
import { useState } from "react"

import {
  accountantReportCsvUrl,
  getAccountantReport,
  putSalesGoal,
  type AccountantDeltaOut,
  type AccountantGoalOut,
  type AccountantMethodGroup,
  type AccountantReportOut,
} from "@/api/reports"
import { useSession } from "@/app/session"
import { useStoreSelection } from "@/app/storeContext"
import { Cargando } from "@/components/Cargando"
import { EmptyState } from "@/components/EmptyState"
import { GroupLabel, PageHeader } from "@/components/admin"
import { ChartFrame, ColumnChart, TrendLine } from "@/components/charts"
import { MoneyInput } from "@/components/MoneyInput"
import { StatTile } from "@/components/StatTile"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { formatBusinessDate, formatBusinessDateShort } from "@/lib/businessDate"
import { errorMessage } from "@/lib/errors"
import { formatPct } from "@/lib/format"
import { formatCOP } from "@/lib/money"
import { cn } from "@/lib/utils"

import { todayInBogota } from "./lib"
import { Definiciones, Plegable, type Definicion } from "./Plegable"

/**
 * «Informe del contador», igual que café-sistema (decisión del dueño
 * 2026-09: «dejar el informe contador igual que café sistema», con meta
 * mensual y sin nómina). Por día operativo: efectivo, tarjeta,
 * transferencia, otros, total, acumulado, facturas y ticket promedio; encima
 * de café, lo fiscal que el contador de un restaurante necesita (base,
 * impuesto, notas crédito, propinas aparte).
 *
 * **Una sola matemática.** Cada cifra, promedio, participación, delta y el
 * avance de la meta llegan hechos de `GET /admin/accountant-report`
 * (`app/reports/accountant.py`); acá sólo se escriben. El «Excel» lo arma el
 * servidor (`format=csv`: `;`, UTF-8 con BOM y fila TOTAL) y el «PDF» es la
 * impresión del navegador sobre esta misma vista, sin el armazón.
 */

type PeriodKind = "month" | "bimester"
type Sede = number | "all"

const MONTH_LABEL: Record<number, string> = {
  1: "Enero", 2: "Febrero", 3: "Marzo", 4: "Abril", 5: "Mayo", 6: "Junio",
  7: "Julio", 8: "Agosto", 9: "Septiembre", 10: "Octubre", 11: "Noviembre", 12: "Diciembre",
}

const BIMESTER_LABEL: Record<number, string> = {
  1: "Enero – Febrero", 2: "Marzo – Abril", 3: "Mayo – Junio",
  4: "Julio – Agosto", 5: "Septiembre – Octubre", 6: "Noviembre – Diciembre",
}

const METHOD_ICON: Record<AccountantMethodGroup, LucideIcon> = {
  cash: Wallet,
  card: CreditCard,
  transfer: Landmark,
  other: Receipt,
}

const METHOD_INK: Record<AccountantMethodGroup, string> = {
  cash: "bg-[var(--data-1)]",
  card: "bg-[var(--data-2)]",
  transfer: "bg-[var(--data-3)]",
  other: "bg-[var(--data-muted)]",
}

/** «03/03», como café. */
function diaCorto(iso: string): string {
  const [, m, d] = iso.split("-")
  return `${d}/${m}`
}

/** Ancho de una barra a partir de puntos básicos que YA mandó el servidor (cambio de unidad, no una cuenta). */
function anchoBp(bp: number | null): string {
  return `${(bp ?? 0) / 100}%`
}

/**
 * El «▲ 12 %» / «▼ 8 %» contra el período anterior, tal como lo manda el
 * servidor. `null` (el anterior fue 0 o no existe) no se dibuja: no hay un
 * «+100 %» inventado.
 */
function Delta({ delta, contra }: { delta: AccountantDeltaOut; contra: string }): React.JSX.Element | null {
  if (delta.pct === null) return null
  const sube = delta.pct >= 0
  return (
    <span
      className={cn("text-xs font-bold", sube ? "text-success" : "text-destructive")}
      title={`Contra ${contra}: ${delta.previous === null ? "sin dato" : formatCOP(delta.previous)}`}
    >
      {sube ? "▲" : "▼"} {formatPct(Math.abs(delta.pct) * 100, 0)}
    </span>
  )
}

function Kpi({
  label,
  value,
  sub,
  icon: Icon,
  delta,
  contra,
}: {
  label: string
  value: string
  sub?: string
  icon: LucideIcon
  delta?: AccountantDeltaOut
  contra?: string
}): React.JSX.Element {
  return (
    <div className="rounded-lg border bg-card p-4 print:break-inside-avoid">
      <div className="mb-1.5 flex items-center gap-2">
        <Icon className="size-3.5 text-muted-foreground" aria-hidden="true" />
        <p className="text-[11px] font-bold tracking-wide text-muted-foreground uppercase">{label}</p>
      </div>
      <div className="flex flex-wrap items-baseline gap-2">
        <p className="text-xl leading-none font-bold tabular-nums">{value}</p>
        {delta && contra ? <Delta delta={delta} contra={contra} /> : null}
      </div>
      {sub ? <p className="mt-1 text-xs text-muted-foreground">{sub}</p> : null}
    </div>
  )
}

// ---------------------------------------------------------------------------
// La meta del mes: editable en el lugar, optimista y con vuelta atrás.
// ---------------------------------------------------------------------------

function MetaDelMes({
  goal,
  total,
  periodoTexto,
  guardando,
  error,
  onGuardar,
}: {
  goal: AccountantGoalOut
  total: number
  periodoTexto: string
  guardando: boolean
  error: string | null
  onGuardar: (amount: number | null) => void
}): React.JSX.Element {
  const [editando, setEditando] = useState(false)
  const [monto, setMonto] = useState<number | null>(goal.amount)
  const sinMeta = goal.amount === null
  const mostrarCampo = goal.editable && (editando || sinMeta)

  const guardar = () => {
    onGuardar(monto && monto > 0 ? monto : null)
    setEditando(false)
  }

  return (
    <div className="col-span-2 rounded-lg border bg-card p-4 lg:col-span-5 print:break-inside-avoid">
      <div className="mb-1.5 flex items-center gap-2">
        <Target className="size-3.5 text-muted-foreground" aria-hidden="true" />
        <p className="text-[11px] font-bold tracking-wide text-muted-foreground uppercase">Meta del mes</p>
        {goal.source === "inherited" && goal.inherited_from ? (
          <span className="text-xs text-muted-foreground">(la de {goal.inherited_from}, sin cambios este mes)</span>
        ) : null}
        {goal.source === "sum" ? (
          <span className="text-xs text-muted-foreground">(suma de las metas de cada sede)</span>
        ) : null}
        {!sinMeta && goal.editable && !editando ? (
          <Button
            variant="ghost"
            size="icon-sm"
            className="ml-auto print:hidden"
            aria-label="Editar meta"
            title="Editar meta"
            disabled={guardando}
            onClick={() => {
              setMonto(goal.amount)
              setEditando(true)
            }}
          >
            <Pencil className="size-3.5" aria-hidden="true" />
          </Button>
        ) : null}
      </div>

      {mostrarCampo ? (
        <div className="flex flex-wrap items-center gap-2 print:hidden">
          {sinMeta && !editando ? (
            <p className="text-sm text-muted-foreground">Sin meta: definila acá.</p>
          ) : null}
          <MoneyInput
            aria-label="Meta del mes"
            value={monto}
            onChange={setMonto}
            disabled={guardando}
            className="w-40 text-right font-semibold tabular-nums"
          />
          <Button onClick={guardar} disabled={guardando}>
            <Check className="size-3.5" aria-hidden="true" />
            Guardar meta
          </Button>
          {editando ? (
            <Button variant="ghost" size="icon-sm" aria-label="Cancelar" disabled={guardando} onClick={() => setEditando(false)}>
              <X className="size-3.5" aria-hidden="true" />
            </Button>
          ) : null}
        </div>
      ) : sinMeta ? (
        <p className="text-sm text-muted-foreground">
          {goal.editable ? "Sin meta para este mes." : "Alguna sede no tiene meta este mes: elegí una sede para ver o poner la suya."}
        </p>
      ) : (
        <>
          <div className="flex flex-wrap items-baseline gap-3">
            <p className="text-xl leading-none font-bold tabular-nums">{formatCOP(goal.amount)}</p>
            <span className="text-xs font-bold text-muted-foreground">
              {goal.progress_bp === null ? "calculando…" : formatPct(goal.progress_bp, 0)}
            </span>
          </div>
          <div
            className="mt-2 h-3 overflow-hidden rounded-full bg-muted"
            role="progressbar"
            aria-label="Avance de la meta"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={goal.bar_bp === null ? undefined : goal.bar_bp / 100}
          >
            <div className="h-full bg-[var(--data-1)]" style={{ width: anchoBp(goal.bar_bp) }} />
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            {formatCOP(total)} de {formatCOP(goal.amount)} en {periodoTexto}
            {goal.met === null ? "" : goal.met ? " · meta cumplida" : ` · faltan ${formatCOP(goal.remaining)}`}
          </p>
        </>
      )}
      {error ? (
        <p role="alert" className="mt-1 text-xs text-destructive print:hidden">
          {error}
        </p>
      ) : null}
    </div>
  )
}

// ---------------------------------------------------------------------------
// La tabla diaria, con su TOTAL.
// ---------------------------------------------------------------------------

function TablaDiaria({ data }: { data: AccountantReportOut }): React.JSX.Element {
  const s = data.summary
  const th = "px-3 py-2 text-right font-bold"
  const td = "px-3 py-2 text-right"
  return (
    <div className="overflow-hidden rounded-lg border bg-card">
      <div className="overflow-x-auto print:overflow-visible">
        <table className="w-full text-sm">
          <caption className="sr-only">
            Lo cobrado por día operativo y medio de pago, con lo fiscal del día y el total del período.
          </caption>
          <thead>
            <tr className="bg-muted text-[11px] tracking-wide text-muted-foreground uppercase">
              <th className="px-3 py-2 text-left font-bold" title="Día operativo del turno, no fecha de calendario">
                Día operativo
              </th>
              <th className={th}>Efectivo</th>
              <th className={th}>Tarjeta</th>
              <th className={cn(th, "hidden sm:table-cell print:table-cell")}>Transf.</th>
              <th className={cn(th, "hidden sm:table-cell print:table-cell")}>Otros</th>
              <th className={th}>Total</th>
              <th className={cn(th, "hidden md:table-cell print:table-cell")}>Acumulado</th>
              <th className={th}>Fact.</th>
              <th className={cn(th, "hidden md:table-cell print:table-cell")}>Ticket prom.</th>
              <th className={cn(th, "hidden lg:table-cell print:table-cell")}>Base</th>
              <th className={cn(th, "hidden lg:table-cell print:table-cell")}>Impuesto</th>
              <th className={cn(th, "hidden lg:table-cell print:table-cell")} title="Notas crédito y de ajuste del día: restan, no son venta">
                Notas créd.
              </th>
              <th className={cn(th, "hidden lg:table-cell print:table-cell")} title="No son venta (Ley 1935 de 2018): no suman al total">
                Propinas
              </th>
            </tr>
          </thead>
          <tbody className="divide-y tabular-nums">
            {data.days.map((d) => (
              <tr key={d.business_date} className="hover:bg-muted/50">
                <td className="px-3 py-2 font-medium" title={formatBusinessDate(d.business_date)}>
                  {diaCorto(d.business_date)}
                </td>
                <td className={td}>{formatCOP(d.cash)}</td>
                <td className={td}>{formatCOP(d.card)}</td>
                <td className={cn(td, "hidden text-muted-foreground sm:table-cell print:table-cell")}>{formatCOP(d.transfer)}</td>
                <td className={cn(td, "hidden text-muted-foreground sm:table-cell print:table-cell")}>{formatCOP(d.other)}</td>
                <td className={cn(td, "font-bold")}>{formatCOP(d.total)}</td>
                <td className={cn(td, "hidden text-muted-foreground md:table-cell print:table-cell")}>{formatCOP(d.cumulative)}</td>
                <td className={cn(td, "text-muted-foreground")}>{d.documents_count}</td>
                <td className={cn(td, "hidden text-muted-foreground md:table-cell print:table-cell")}>{formatCOP(d.avg_ticket)}</td>
                <td className={cn(td, "hidden text-muted-foreground lg:table-cell print:table-cell")}>{formatCOP(d.base)}</td>
                <td className={cn(td, "hidden text-muted-foreground lg:table-cell print:table-cell")}>{formatCOP(d.tax)}</td>
                <td className={cn(td, "hidden text-muted-foreground lg:table-cell print:table-cell")}>{formatCOP(d.credit_notes)}</td>
                <td className={cn(td, "hidden text-muted-foreground lg:table-cell print:table-cell")}>{formatCOP(d.tips)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t-2 bg-muted font-bold tabular-nums">
              <td className="px-3 py-2.5">TOTAL</td>
              <td className={td}>{formatCOP(s.cash)}</td>
              <td className={td}>{formatCOP(s.card)}</td>
              <td className={cn(td, "hidden sm:table-cell print:table-cell")}>{formatCOP(s.transfer)}</td>
              <td className={cn(td, "hidden sm:table-cell print:table-cell")}>{formatCOP(s.other)}</td>
              <td className={td}>{formatCOP(s.total)}</td>
              <td className={cn(td, "hidden md:table-cell print:table-cell")} />
              <td className={td}>{s.documents_count}</td>
              <td className={cn(td, "hidden md:table-cell print:table-cell")}>{formatCOP(s.avg_ticket)}</td>
              <td className={cn(td, "hidden lg:table-cell print:table-cell")}>{formatCOP(s.base)}</td>
              <td className={cn(td, "hidden lg:table-cell print:table-cell")}>{formatCOP(s.tax)}</td>
              <td className={cn(td, "hidden lg:table-cell print:table-cell")}>{formatCOP(s.credit_notes)}</td>
              <td className={cn(td, "hidden lg:table-cell print:table-cell")}>{formatCOP(s.tips)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  )
}

/**
 * El pie de las cifras fiscales, plegado (mapa de pantallas, regla 2).
 */
const CIFRAS_EXPLICADAS: readonly Definicion[] = [
  { term: "Día operativo ≠ día calendario", meaning: "el día corta a la hora que la sede definió, no a medianoche. Una venta de la 1 a. m. cae en el día anterior." },
  { term: "Total", meaning: "lo cobrado de la venta (efectivo + tarjeta + transferencia + otros), sin la propina." },
  { term: "Base de documentos", meaning: "lo vendido sin el impuesto." },
  { term: "Impuesto de documentos", meaning: "el impuesto al consumo discriminado: no es del restaurante." },
  { term: "Propinas del período", meaning: "ni venta ni impuesto: va aparte por ley (Ley 1935 de 2018)." },
  { term: "Base de notas", meaning: "lo devuelto sin el impuesto." },
  { term: "Impuesto de notas", meaning: "el impuesto que se devuelve con la nota." },
]

// ---------------------------------------------------------------------------
// La pantalla.
// ---------------------------------------------------------------------------

export function AccountantReportTab({
  storeId,
  conTitulo = false,
}: {
  storeId: number
  /** En su propia pantalla (`/admin/contador`) lleva el título como café; en la pestaña de Ventas, no. */
  conTitulo?: boolean
}): React.JSX.Element {
  const { stores } = useStoreSelection()
  const { hasFeature } = useSession()
  const queryClient = useQueryClient()
  const nowParts = todayInBogota().split("-")
  const anioActual = Number(nowParts[0])
  const [year, setYear] = useState(anioActual)
  const [periodKind, setPeriodKind] = useState<PeriodKind>("month")
  const [periodValue, setPeriodValue] = useState(Number(nowParts[1]))
  // La sede elegida en ESTA pantalla (las pastillas de café). `null` = la
  // activa de la lateral.
  const [sedeElegida, setSedeElegida] = useState<Sede | null>(null)
  const [errorMeta, setErrorMeta] = useState<string | null>(null)

  const conSelector = stores.length > 1 || hasFeature("multi_store")
  const sede: Sede = sedeElegida ?? storeId
  const params = {
    storeId: sede,
    year,
    month: periodKind === "month" ? periodValue : undefined,
    bimester: periodKind === "bimester" ? periodValue : undefined,
  }
  const queryKey = ["admin-accountant-report", sede, year, periodKind, periodValue] as const

  const query = useQuery({ queryKey, queryFn: () => getAccountantReport(params) })

  // Meta optimista (como café): se pinta ya y vuelve atrás si el PUT falla.
  // El avance NO se calcula acá: mientras el servidor contesta se lee
  // «calculando…», y la respuesta del PUT trae la barra hecha.
  const meta = useMutation({
    mutationFn: (amount: number | null) =>
      putSalesGoal({ store_id: sede as number, year, month: periodValue, amount }),
    onMutate: async (amount) => {
      setErrorMeta(null)
      await queryClient.cancelQueries({ queryKey })
      const antes = queryClient.getQueryData<AccountantReportOut>(queryKey)
      if (antes?.goal) {
        queryClient.setQueryData<AccountantReportOut>(queryKey, {
          ...antes,
          goal: {
            ...antes.goal,
            amount,
            source: amount === null ? null : "month",
            inherited_from: null,
            progress_bp: null,
            bar_bp: null,
            remaining: null,
            met: null,
          },
        })
      }
      return { antes }
    },
    onError: (err, _amount, ctx) => {
      if (ctx?.antes) queryClient.setQueryData(queryKey, ctx.antes)
      setErrorMeta(`No se guardó la meta: ${errorMessage(err)}`)
    },
    onSuccess: (goal) => {
      const actual = queryClient.getQueryData<AccountantReportOut>(queryKey)
      if (actual) queryClient.setQueryData<AccountantReportOut>(queryKey, { ...actual, goal })
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ["admin-accountant-report"] })
    },
  })

  const periodOptions = periodKind === "month" ? MONTH_LABEL : BIMESTER_LABEL
  const periodoTexto = `${periodOptions[periodValue] ?? ""} ${year}`
  const csvUrl = accountantReportCsvUrl(params)
  const data = query.data
  const tieneDatos = !!data && data.days.length > 0
  const nombreSede = sede === "all" ? "Todas las sedes" : (stores.find((s) => s.id === sede)?.name ?? "")
  const anios = Array.from({ length: 5 }, (_, i) => anioActual - i)

  const cabecera = (
    <div className="flex flex-wrap items-end gap-3 print:hidden">
      {conTitulo ? (
        <div className="flex items-center gap-2 self-center">
          <Calculator className="size-5 text-primary" aria-hidden="true" />
          <h1 className="text-lg font-bold">Informe del contador</h1>
        </div>
      ) : null}
      <div className="ml-auto flex flex-wrap items-end gap-2">
        <div className="space-y-1">
          <Label htmlFor="accountant-period-kind">Período</Label>
          <Select
            value={periodKind}
            onValueChange={(v) => {
              const kind = v as PeriodKind
              setPeriodKind(kind)
              setPeriodValue(kind === "month" ? Number(nowParts[1]) : Math.ceil(Number(nowParts[1]) / 2))
            }}
          >
            <SelectTrigger id="accountant-period-kind" className="h-10 w-32">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="month">Mensual</SelectItem>
              <SelectItem value="bimester">Bimestral</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="accountant-period-value">{periodKind === "month" ? "Mes" : "Bimestre"}</Label>
          <Select value={String(periodValue)} onValueChange={(v) => setPeriodValue(Number(v))}>
            <SelectTrigger id="accountant-period-value" className="h-10 w-44">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {Object.entries(periodOptions).map(([value, label]) => (
                <SelectItem key={value} value={value}>
                  {label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="accountant-year">Año</Label>
          <Select value={String(year)} onValueChange={(v) => setYear(Number(v))}>
            <SelectTrigger id="accountant-year" className="h-10 w-24">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {anios.map((y) => (
                <SelectItem key={y} value={String(y)}>
                  {y}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {/* «Excel»: el CSV lo arma el servidor (`;`, BOM, fila TOTAL) y el
            navegador lo baja con el nombre del `Content-Disposition`. */}
        <Button
          render={<a href={csvUrl} target="_blank" rel="noreferrer" title="Exportar CSV" />}
          variant="outline"
          className="h-10 gap-1.5"
        >
          <Download className="size-4" aria-hidden="true" />
          Excel
        </Button>
        <Button variant="outline" className="h-10 gap-1.5" disabled={!tieneDatos} onClick={() => window.print()}>
          <Printer className="size-4" aria-hidden="true" />
          PDF
        </Button>
      </div>
    </div>
  )

  return (
    <div className="space-y-4">
      {cabecera}

      {conSelector ? (
        <div role="group" aria-label="Sede del informe" className="flex flex-wrap items-center gap-2 print:hidden">
          {stores.length > 1 ? (
            <Button
              variant={sede === "all" ? "default" : "outline"}
              aria-pressed={sede === "all"}
              onClick={() => setSedeElegida("all")}
            >
              Todas
            </Button>
          ) : null}
          {stores.map((s) => (
            <Button
              key={s.id}
              variant={sede === s.id ? "default" : "outline"}
              aria-pressed={sede === s.id}
              onClick={() => setSedeElegida(s.id)}
            >
              {s.name}
            </Button>
          ))}
        </div>
      ) : null}

      {/* Lo que sale en el PDF arriba de todo. El eje importa para conciliar:
          el adquirente liquida el datáfono por fecha de calendario, y acá las
          ventas van al día operativo del turno. */}
      <div className="hidden print:block">
        <h1 className="text-lg font-bold">Informe del contador — {periodoTexto}</h1>
        <p className="text-[11px] text-muted-foreground">
          Agrupado por día operativo (el del turno y su cuadre), no por fecha de calendario. La columna Tarjeta
          puede no coincidir con la fecha de liquidación del datáfono. Las propinas no son venta y van aparte.
        </p>
        <p className="text-sm text-muted-foreground">{nombreSede}</p>
      </div>

      {query.isLoading ? (
        <Cargando texto="Calculando el consolidado del contador…" />
      ) : query.isError ? (
        <EmptyState
          reason="error"
          title="No se pudo cargar el informe"
          description={errorMessage(query.error)}
          action={{ label: "Reintentar", onClick: () => void query.refetch() }}
        />
      ) : data ? (
        <div className="space-y-4">
          {!tieneDatos ? (
            <>
              {data.goal ? (
                <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
                  <MetaDelMes
                    key={`${String(sede)}-${year}-${periodValue}-${data.goal.amount ?? "sin"}`}
                    goal={data.goal}
                    total={data.summary.total}
                    periodoTexto={periodoTexto}
                    guardando={meta.isPending}
                    error={errorMeta}
                    onGuardar={(amount) => meta.mutate(amount)}
                  />
                </div>
              ) : null}
              <EmptyState
                reason="filter"
                icon={CalendarDays}
                title="Sin documentos en este período"
                description={`No hay ventas en ${periodoTexto} para ${sede === "all" ? "ninguna sede" : "esta sede"}.`}
              />
            </>
          ) : (
            <Contenido
              data={data}
              sede={sede}
              year={year}
              periodValue={periodValue}
              periodoTexto={periodoTexto}
              guardandoMeta={meta.isPending}
              errorMeta={errorMeta}
              onGuardarMeta={(amount) => meta.mutate(amount)}
            />
          )}
        </div>
      ) : null}
    </div>
  )
}

function Contenido({
  data,
  sede,
  year,
  periodValue,
  periodoTexto,
  guardandoMeta,
  errorMeta,
  onGuardarMeta,
}: {
  data: AccountantReportOut
  sede: Sede
  year: number
  periodValue: number
  periodoTexto: string
  guardandoMeta: boolean
  errorMeta: string | null
  onGuardarMeta: (amount: number | null) => void
}): React.JSX.Element {
  const s = data.summary
  const cmp = data.comparison
  const contra = cmp.previous_label
  const share = (m: AccountantMethodGroup) => s.shares.find((x) => x.method === m)?.share_bp ?? null
  const esMes = data.period_kind === "month"
  const unidad = esMes ? "mes" : "bimestre"

  return (
    <>
      {/* Las cifras del período: la meta a todo lo ancho y cinco tarjetas. */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        {data.goal ? (
          <MetaDelMes
            key={`${String(sede)}-${year}-${periodValue}-${data.goal.amount ?? "sin"}`}
            goal={data.goal}
            total={s.total}
            periodoTexto={periodoTexto}
            guardando={guardandoMeta}
            error={errorMeta}
            onGuardar={onGuardarMeta}
          />
        ) : null}
        <Kpi
          label={`Total del ${unidad}`}
          value={formatCOP(s.total)}
          sub={`${s.days_with_sales} días con venta · vs ${contra}`}
          icon={Receipt}
          delta={cmp.total}
          contra={contra}
        />
        <Kpi
          label={`Venta diaria (${unidad})`}
          value={formatCOP(s.avg_daily_calendar)}
          sub={`${formatCOP(s.total)} ÷ ${s.days_in_period} días`}
          icon={TrendingUp}
          delta={cmp.avg_daily_calendar}
          contra={contra}
        />
        <Kpi
          label="Promedio por día con venta"
          value={formatCOP(s.avg_daily_with_sales)}
          sub={`${s.days_with_sales} días`}
          icon={TrendingUp}
          delta={cmp.avg_daily_with_sales}
          contra={contra}
        />
        <Kpi
          label="Ticket promedio"
          value={formatCOP(s.avg_ticket)}
          sub={`${s.documents_count} facturas`}
          icon={Receipt}
          delta={cmp.avg_ticket}
          contra={contra}
        />
        <Kpi
          label="Efectivo / Tarjeta"
          value={`${formatPct(share("cash"), 0)} / ${formatPct(share("card"), 0)}`}
          icon={Wallet}
        />
      </div>

      {/* Día mayor / menor + participación por medio. */}
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
        <div className="flex items-center gap-3 rounded-lg border bg-card p-4 print:break-inside-avoid">
          <TrendingUp className="size-5 shrink-0 text-success" aria-hidden="true" />
          <div>
            <p className="text-[11px] font-bold tracking-wide text-muted-foreground uppercase">Día de mayor venta</p>
            <p className="text-sm font-bold tabular-nums">
              {s.best_day ? `${diaCorto(s.best_day.business_date)} · ${formatCOP(s.best_day.total)}` : "—"}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-3 rounded-lg border bg-card p-4 print:break-inside-avoid">
          <TrendingDown className="size-5 shrink-0 text-destructive" aria-hidden="true" />
          <div>
            <p className="text-[11px] font-bold tracking-wide text-muted-foreground uppercase">Día de menor venta</p>
            <p className="text-sm font-bold tabular-nums">
              {s.worst_day ? `${diaCorto(s.worst_day.business_date)} · ${formatCOP(s.worst_day.total)}` : "—"}
            </p>
          </div>
        </div>
        <div className="rounded-lg border bg-card p-4 print:break-inside-avoid">
          <p className="mb-2 text-[11px] font-bold tracking-wide text-muted-foreground uppercase">Participación por medio</p>
          <ul className="space-y-1.5">
            {s.shares.map((m) => {
              const Icon = METHOD_ICON[m.method]
              return (
                <li key={m.method} className="flex items-center gap-2" title={`${m.label}: ${formatCOP(m.amount)}`}>
                  <Icon className="size-3 shrink-0 text-muted-foreground" aria-hidden="true" />
                  <span className="w-24 shrink-0 text-xs">{m.label}</span>
                  <div className="h-3 flex-1 overflow-hidden rounded-full bg-muted">
                    <div className={cn("h-full", METHOD_INK[m.method])} style={{ width: anchoBp(m.share_bp) }} />
                  </div>
                  <span className="w-12 text-right text-xs font-bold tabular-nums">{formatPct(m.share_bp, 0)}</span>
                </li>
              )
            })}
          </ul>
        </div>
      </div>

      {/* Tendencia diaria (columnas) + Evolución acumulada (línea). */}
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2 print:grid-cols-2">
        <ChartFrame
          titular={s.best_day ? `El día de mayor venta fue el ${diaCorto(s.best_day.business_date)}` : "Tendencia diaria"}
          detalle="Tendencia diaria: lo cobrado por día operativo, en pesos"
          muestra={{ n: s.days_with_sales, unidad: "días con venta", minimo: 1 }}
          tabla={{
            columnas: [
              { key: "dia", header: "Día operativo" },
              { key: "total", header: "Total", align: "right" },
            ],
            filas: data.days.map((d) => ({ dia: diaCorto(d.business_date), total: formatCOP(d.total) })),
          }}
        >
          <ColumnChart
            datos={data.days.map((d) => ({ key: d.business_date, etiqueta: diaCorto(d.business_date), valor: d.total }))}
            formato={formatCOP}
            referencia={
              s.avg_daily_with_sales === null
                ? undefined
                : { valor: s.avg_daily_with_sales, etiqueta: "Promedio por día con venta" }
            }
            resaltar={s.best_day?.business_date}
            alto={140}
          />
        </ChartFrame>
        <ChartFrame
          titular={`El ${unidad} acumula ${formatCOP(s.total)}`}
          detalle="Evolución acumulada: lo cobrado sumado día a día, en pesos"
          muestra={{ n: s.days_with_sales, unidad: "días con venta", minimo: 1 }}
          tabla={{
            columnas: [
              { key: "dia", header: "Día operativo" },
              { key: "acumulado", header: "Acumulado", align: "right" },
            ],
            filas: data.days.map((d) => ({ dia: formatBusinessDateShort(d.business_date), acumulado: formatCOP(d.cumulative) })),
          }}
        >
          <TrendLine
            puntos={data.days.map((d) => ({ key: d.business_date, etiqueta: diaCorto(d.business_date), valor: d.cumulative }))}
            formato={formatCOP}
            alto={140}
          />
        </ChartFrame>
      </div>

      <TablaDiaria data={data} />

      {/* Lo fiscal del período, que café no tenía y el contador sí necesita.
          § 3 · Lo emitido y lo devuelto no son el mismo tipo de número: una
          nota RESTA de lo que el documento sumó. */}
      <div className="grid gap-4 md:grid-cols-2 print:break-inside-avoid">
        <GroupLabel label="Lo emitido" says="documentos equivalentes POS del período">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <StatTile label="Base de documentos" value={formatCOP(data.documents_total_base)} />
            <StatTile label="Impuesto de documentos" value={formatCOP(data.documents_total_tax)} />
            <StatTile
              label="Propinas del período (informativo)"
              value={formatCOP(data.tips_total)}
              hint="Ni venta ni impuesto."
            />
          </div>
          {s.tax_by_rate.length > 0 ? (
            <p className="mt-2 text-xs text-muted-foreground">
              Por tarifa:{" "}
              {s.tax_by_rate
                // `rate` llega como por ciento entero (8, 19): ×100 lo pasa a
                // puntos básicos, la unidad de `formatPct`.
                .map((r) => `${formatPct(r.rate * 100, 0)} · base ${formatCOP(r.base)} · impuesto ${formatCOP(r.tax)}`)
                .join(" — ")}
            </p>
          ) : null}
        </GroupLabel>
        <GroupLabel label="Lo devuelto" says="notas crédito: restan de lo de arriba, no se suman">
          <div className="grid grid-cols-2 gap-3">
            <StatTile label="Base de notas" value={formatCOP(data.notes_total_base)} />
            <StatTile label="Impuesto de notas" value={formatCOP(data.notes_total_tax)} />
          </div>
        </GroupLabel>
      </div>
      <Plegable resumen="Cómo leer estas cifras" className="px-1 print:hidden">
        <Definiciones items={CIFRAS_EXPLICADAS} className="sm:grid-cols-2" />
      </Plegable>
    </>
  )
}

/**
 * `/admin/contador`: el informe del contador con su propia entrada en
 * Informes (antes era sólo una pestaña de Ventas, que sigue funcionando).
 */
export function AccountantReportPage(): React.JSX.Element {
  const { activeStoreId, loading } = useStoreSelection()
  if (loading) return <Cargando texto="Cargando sedes…" />
  if (activeStoreId === null) {
    return <p className="text-sm text-muted-foreground">Todavía no hay sedes creadas.</p>
  }
  return (
    <div className="space-y-4">
      <div className="print:hidden">
        <PageHeader
          name="Informe del contador"
          question="Cuánto se cobró cada día del mes, por medio de pago, con lo fiscal que el contador necesita y la meta del mes."
        />
      </div>
      <AccountantReportTab storeId={activeStoreId} />
    </div>
  )
}

export default AccountantReportTab
