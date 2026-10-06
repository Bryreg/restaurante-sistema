import { useQuery } from "@tanstack/react-query"

import { getMiseEnPlace, getMiseEnPlaceDevice, type MiseOut, type MiseRowOut } from "@/api/recipes"
import { Burbuja, EstadoPastilla, Pozo } from "@/components/admin"
import { Cargando } from "@/components/Cargando"
import { formatBusinessDate } from "@/lib/businessDate"
import { errorMessage } from "@/lib/errors"

const UNIDAD: Record<string, string> = { g: "g", ml: "ml", unit: "und" }

function Fila({ r }: { r: MiseRowOut }): React.JSX.Element {
  const u = UNIDAD[r.unit] ?? r.unit
  return (
    <Pozo className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
      <b className="min-w-40 text-sm">{r.name}</b>
      <span className="text-[13px] text-muted-foreground">
        Hay <b className="text-foreground tabular-nums">{r.stock} {u}</b>
        {r.par !== null ? (
          <>
            {" "}
            · par <b className="text-foreground tabular-nums">{r.par} {u}</b>
          </>
        ) : null}
        {r.avg_daily_use !== null ? ` · se usan ${r.avg_daily_use} ${u} al día` : " · sin uso en 14 días"}
        {r.days_of_cover !== null ? ` · alcanza ${r.days_of_cover} días` : ""}
      </span>
      <span className="ml-auto">
        {r.status === "producir" ? (
          <EstadoPastilla tono="warning">
            Producir {r.to_produce} {u} · {r.batches} {r.batches === 1 ? "tanda" : "tandas"} de {r.batch_yield} {u}
          </EstadoPastilla>
        ) : r.status === "al_dia" ? (
          <EstadoPastilla tono="success">Al par</EstadoPastilla>
        ) : (
          <EstadoPastilla tono="neutral">
            Sin par{r.suggested_par !== null ? ` · sugerido ${r.suggested_par} ${u}` : ""}
          </EstadoPastilla>
        )}
      </span>
    </Pozo>
  )
}

function Lista({ data }: { data: MiseOut }): React.JSX.Element {
  if (data.rows.length === 0) {
    return <p className="text-sm text-muted-foreground">No hay preparaciones en modo lote: no hay nada que producir por adelantado.</p>
  }
  return (
    <div className="flex flex-col gap-2">
      {data.rows.map((r) => (
        <Fila key={r.preparation_id} r={r} />
      ))}
      <p className="text-xs text-muted-foreground">
        El uso es el promedio diario del {formatBusinessDate(data.window_from)} al {formatBusinessDate(data.window_to)}. El
        par sugerido es un día de uso más 20 %.
      </p>
    </div>
  )
}

/**
 * **Mise en place de hoy**: cada preparación en modo lote contra su nivel par
 * —cuánto hay, cuánto se usa al día, cuánto producir y en cuántas tandas—.
 * La cuenta es del servidor (`app.recipes.mise`); acá sólo se muestra.
 */
export function MiseEnPlace({ storeId }: { storeId: number }): React.JSX.Element {
  const q = useQuery({ queryKey: ["recipes", "mise", storeId], queryFn: () => getMiseEnPlace(storeId) })
  return (
    <Burbuja
      titulo="Mise en place de hoy"
      estado={
        q.data
          ? q.data.to_produce_count > 0
            ? { tono: "warning", texto: `${q.data.to_produce_count} por producir` }
            : { tono: "success", texto: "Todo al par" }
          : undefined
      }
    >
      {q.isLoading ? (
        <Cargando texto="Armando la lista…" />
      ) : q.isError || !q.data ? (
        <p role="alert" className="text-sm text-destructive">
          {errorMessage(q.error)}
        </p>
      ) : (
        <Lista data={q.data} />
      )}
    </Burbuja>
  )
}

/** La misma lista en la tablet de cocina (sin costos). */
export function MiseEnPlaceDispositivo(): React.JSX.Element | null {
  const q = useQuery({ queryKey: ["device", "mise"], queryFn: getMiseEnPlaceDevice, refetchInterval: 60_000 })
  if (!q.data) return null
  const porProducir = q.data.rows.filter((r) => r.status === "producir")
  if (porProducir.length === 0) return null
  return (
    <section aria-label="Hoy toca producir" className="space-y-2">
      <h2 className="text-base font-semibold">Hoy toca producir</h2>
      {porProducir.map((r) => (
        <Fila key={r.preparation_id} r={r} />
      ))}
    </section>
  )
}
