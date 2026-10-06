import { useQuery } from "@tanstack/react-query"
import { Target } from "lucide-react"

import { getTodayMonth, type GoalPaceOut, type TodayMonthOut } from "@/api/reports"
import { useSession } from "@/app/session"
import { Burbuja, Pozo } from "@/components/admin"
import { BulletReferencia } from "@/components/charts"
import { SinDato } from "@/components/SinDato"
import { formatPct } from "@/lib/format"
import { formatCOP } from "@/lib/money"
import { cn } from "@/lib/utils"

import { BannerConfiabilidad } from "../gestion/Confiabilidad"

/**
 * El mes en curso en Hoy (`GET /admin/reports/month`): el ritmo hacia la meta
 * del mes (h6), el costo primo del mes hasta hoy en una cifra (h3) y el aviso
 * «¿le puedo creer a estos números?» del mes (h10). Las tres cosas llegan
 * calculadas; acá se pintan. Sólo el administrador: hablan de costos.
 */
function useMesEnCurso(storeId: number | null): { data: TodayMonthOut | undefined } {
  const { me } = useSession()
  const query = useQuery({
    queryKey: ["admin-today-month", storeId],
    queryFn: () => getTodayMonth(storeId as number),
    enabled: storeId !== null && me?.kind === "admin",
    refetchInterval: 5 * 60_000,
  })
  return { data: query.data }
}

/** El aviso de confiabilidad del mes, arriba de Hoy. */
export function ConfiabilidadDelMes({ storeId }: { storeId: number | null }): React.JSX.Element | null {
  const { data } = useMesEnCurso(storeId)
  if (!data) return null
  return <BannerConfiabilidad data={data.reliability} periodo="del mes" />
}

function Ritmo({ pace }: { pace: GoalPaceOut }): React.JSX.Element {
  if (pace.goal === null) {
    return (
      <div className="space-y-1">
        <p className="text-[13px] text-muted-foreground">Cobrado en el mes</p>
        <p className="text-[22px] font-medium tabular-nums">{formatCOP(pace.month_to_date)}</p>
        <SinDato forma="bloque" motivo={pace.reason ?? "Este mes no tiene meta de ventas."} />
      </div>
    )
  }
  const atrasado = pace.gap_to_expected !== null && pace.gap_to_expected < 0
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-[13px] text-muted-foreground">
          Cobrado en el mes · día {pace.days_elapsed} de {pace.days_in_month}
        </p>
        <p className="text-xs text-muted-foreground tabular-nums">
          {formatPct(pace.progress_bp, 0)} de la meta de {formatCOP(pace.goal)}
        </p>
      </div>
      <p className="text-[28px] leading-tight font-medium tracking-[-0.02em] tabular-nums">{formatCOP(pace.month_to_date)}</p>
      <BulletReferencia
        etiqueta="Cobrado en el mes"
        valor={pace.month_to_date}
        referencia={pace.expected_to_date}
        malo="debajo"
        formato={formatCOP}
        nombreRaya="lo esperado a hoy"
        textoFuera="por debajo de lo esperado a hoy"
        fuera={atrasado}
        maximo={pace.goal}
        ancho="completo"
      />
      <dl className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <Pozo>
          <dt className="text-[13px] text-muted-foreground">Esperado a hoy</dt>
          <dd className="text-lg font-medium tabular-nums">{formatCOP(pace.expected_to_date)}</dd>
          <dd className={cn("text-xs", atrasado ? "font-semibold text-warning" : "text-muted-foreground")}>
            {pace.gap_to_expected === null
              ? null
              : pace.gap_to_expected < 0
                ? `▼ faltan ${formatCOP(-pace.gap_to_expected)} para ir al día`
                : `▲ ${formatCOP(pace.gap_to_expected)} por encima`}
          </dd>
        </Pozo>
        <Pozo>
          <dt className="text-[13px] text-muted-foreground">Proyección a fin de mes</dt>
          {pace.projected_month_end === null ? (
            <dd>
              <SinDato forma="bloque" motivo={pace.projection_reason ?? "Sin días cerrados todavía."} />
            </dd>
          ) : (
            <>
              <dd className="text-lg font-medium tabular-nums">{formatCOP(pace.projected_month_end)}</dd>
              <dd className={cn("text-xs", pace.on_track === false ? "font-semibold text-warning" : "text-muted-foreground")}>
                {pace.on_track === false ? "▼ " : pace.on_track ? "▲ " : ""}
                {formatPct(pace.projected_vs_goal_bp, 0)} de la meta, al ritmo de los días cerrados
              </dd>
            </>
          )}
        </Pozo>
      </dl>
    </div>
  )
}

/** La burbuja del mes: ritmo hacia la meta y costo primo del mes hasta hoy. */
export function MesEnCurso({ storeId }: { storeId: number | null }): React.JSX.Element | null {
  const { data } = useMesEnCurso(storeId)
  if (!data) return null
  const pace = data.goal_pace
  const prime = data.prime_cost
  return (
    <Burbuja
      icono={Target}
      titulo="El mes hasta hoy"
      aria-label="El mes hasta hoy"
      ir={{ to: "/admin/informes", label: "Ver Informes" }}
      estado={
        pace.on_track === null
          ? undefined
          : pace.on_track
            ? { tono: "success", texto: "Va a la meta" }
            : { tono: "warning", texto: "Debajo del ritmo" }
      }
    >
      <div className="grid gap-4 md:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <Ritmo pace={pace} />
        <Pozo className="self-start">
          <p className="text-[13px] text-muted-foreground">Costo primo del mes</p>
          {prime.prime_cost === null ? (
            <SinDato forma="bloque" motivo={prime.reason ?? "Falta un dato para calcularlo."} />
          ) : (
            <>
              <p className="text-[22px] leading-tight font-medium tabular-nums">
                {prime.prime_cost_pct_bp !== null ? formatPct(prime.prime_cost_pct_bp) : formatCOP(prime.prime_cost)}
              </p>
              <p className="text-xs text-muted-foreground">
                {formatCOP(prime.prime_cost)} = lo vendido {formatCOP(prime.cost_of_goods)} (
                {prime.cost_basis === "real" ? "costo real" : "costo teórico"}) + gente {formatCOP(prime.labor)}
              </p>
            </>
          )}
        </Pozo>
      </div>
    </Burbuja>
  )
}
