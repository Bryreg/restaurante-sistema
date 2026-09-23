/**
 * Admin → Analítica → Salud sostenida (D-1, spec.md § 1, `GET
 * /admin/control-health/sustained`): la brecha de food cost real está
 * sostenida en rojo cuando supera el umbral en al menos 2 de las últimas 3
 * ventanas. `sustained_red` es `null` (nunca `false` mudo, nunca "verde" por
 * default) con menos de 2 ventanas computables — ésa es la letra exacta de
 * D-1 y el error nº7 del proyecto si se pinta distinto.
 */
import { useQuery } from "@tanstack/react-query"

import { getControlHealthSustained, type SustainedHealthOut } from "@/api/analytics"
import { GroupLabel } from "@/components/admin"
import { ChartFrame, ThresholdDots, type ThresholdPunto } from "@/components/charts"
import { EmptyState } from "@/components/EmptyState"
import { StatTile } from "@/components/StatTile"
import { errorMessage } from "@/lib/errors"
import { formatPct } from "@/lib/format"

import { fechaCortaDeInstante, formatPuntos, textoVentana } from "@/features/inventory/lib"

import { sustainedTitular } from "./titulares"

/**
 * La brecha (real − teórico, del servidor) de cada ventana entre conteos
 * contra la regla del umbral rojo (analista #6, científico #15). Encima
 * del umbral, el punto va en rojo con ▲ (lo decide `ThresholdDots` contra
 * `red_threshold_bp`, que también manda el servidor). Una brecha negativa
 * (real bajo el teórico) queda abajo del cero.
 */
function BrechaPorVentana({ data }: { data: SustainedHealthOut }): React.JSX.Element | null {
  const ventanas = data.windows ?? []
  if (ventanas.length === 0 || data.red_threshold_bp === undefined) return null
  const puntos: ThresholdPunto[] = ventanas.map((w) => ({
    key: String(w.window_index),
    etiqueta: w.window_to ? fechaCortaDeInstante(w.window_to) : `#${w.window_index}`,
    valor: w.gap_bp ?? null,
  }))
  // Comandas de todas las ventanas: contar comandas es contar, no plata.
  const comandas = ventanas.reduce((n, w) => n + (w.orders_in_window ?? 0), 0)
  const titular = sustainedTitular(data)
  return (
    <div className="rounded-lg border bg-card p-4">
      <ChartFrame
        titular={titular}
        detalle={`Brecha de food cost (real − teórico) por ventana entre conteos completos, en puntos; la línea roja es el umbral (${formatPuntos(data.red_threshold_bp)}). Cada punto se rotula con el día del conteo que cierra la ventana.`}
        muestra={{ n: comandas, unidad: "comandas", ventana: `${ventanas.length} ${ventanas.length === 1 ? "ventana" : "ventanas"}` }}
        tabla={{
          columnas: [
            { key: "ventana", header: "Ventana" },
            { key: "real", header: "Real", align: "right" },
            { key: "teo", header: "Teórico", align: "right" },
            { key: "brecha", header: "Brecha", align: "right" },
            { key: "comandas", header: "Comandas", align: "right" },
            { key: "rojo", header: "¿Pasa el rojo?" },
          ],
          filas: ventanas.map((w) => ({
            ventana: textoVentana(w.window_hours, w.window_days, w.window_from, w.window_to) ?? `#${w.window_index}`,
            real: formatPct(w.real_pct_bp ?? null),
            teo: formatPct(w.theoretical_pct_bp ?? null),
            brecha: formatPuntos(w.gap_bp ?? null),
            comandas: w.orders_in_window ?? "—",
            rojo: w.exceeds_red === undefined ? "—" : w.exceeds_red ? "▲ Sí" : "Por debajo",
          })),
        }}
      >
        <ThresholdDots
          puntos={puntos}
          umbral={{ valor: data.red_threshold_bp, etiqueta: "Umbral rojo" }}
          formato={(v) => formatPuntos(v, { corto: true })}
          resumen={`${titular}.`}
        />
      </ChartFrame>
    </div>
  )
}

/** Por qué hay ventanas entre conteos que no entraron: las reglas del servidor, con sus números. */
function VentanasSaltadas({ data }: { data: SustainedHealthOut }): React.JSX.Element | null {
  const n = data.windows_skipped ?? 0
  if (n === 0) return null
  const dias = data.min_window_days
  const cobertura = data.min_costed_pct_bp
  return (
    <p className="text-sm text-muted-foreground" data-testid="ventanas-saltadas">
      {n === 1 ? "Una ventana entre conteos no cuenta" : `${n} ventanas entre conteos no cuentan`}: una ventana entra sólo si
      dura {dias === undefined ? "lo mínimo" : `${dias} ${dias === 1 ? "día completo" : "días completos"}`} o más, tiene
      ventas, tiene ficha con costo en {cobertura === undefined ? "casi todo" : `${formatPct(cobertura)} o más`} de lo vendido y
      su food cost real tiene sentido. Contar más seguido y completar las fichas hace que entren.
    </p>
  )
}

export function SustainedHealthTab({ storeId }: { storeId: number }): React.JSX.Element {
  const query = useQuery({
    queryKey: ["analytics", "control-health-sustained", storeId],
    queryFn: () => getControlHealthSustained(storeId),
  })

  if (query.isLoading) {
    return <p className="text-sm text-muted-foreground">Evaluando la salud del control…</p>
  }
  if (query.isError) {
    return (
      <EmptyState reason="error" title="No se pudo evaluar la salud sostenida" description={errorMessage(query.error)} action={{ label: "Reintentar", onClick: () => void query.refetch() }} />
    )
  }

  const data = query.data

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        «Sostenido» (D-1): la brecha de food cost real supera el umbral rojo en al menos 2 de las últimas 3 ventanas
        de conteo — nunca por un solo conteo malo.
      </p>
      {data ? <BrechaPorVentana data={data} /> : null}
      {/* Con `sustained_red: null` el motivo del servidor ya cuenta las ventanas que no entraron. */}
      {data && data.sustained_red !== null ? <VentanasSaltadas data={data} /> : null}
      {data?.sustained_red === null || data === undefined ? (
        <EmptyState
          reason="dependency"
          title="Sin historial suficiente"
          description={data?.reason ?? "Hacen falta al menos dos conteos completos aplicados para evaluar si está sostenido."}
        />
      ) : (
        <GroupLabel label="Sostenido" says="sobre varias ventanas de conteo, no sobre un conteo malo">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <StatTile
              label="Brecha sostenida en rojo"
              value={data.sustained_red ? "Sí" : "No"}
              tone={data.sustained_red ? "critical" : "default"}
              // § 5, regla dura: una tarjeta con tono lleva a algún lado —
              // si no, el color es decoración.
              link={{ to: "/admin/inventario?tab=salud", screen: "Inventario", tab: "Salud del control" }}
              hint={
                data.sustained_red
                  ? "La brecha superó el umbral en al menos 2 de las últimas 3 ventanas."
                  : "No superó el umbral en 2 de las últimas 3 ventanas."
              }
            />
            <StatTile
              label="Ventanas evaluadas"
              value={String(data.windows_evaluated)}
              hint="Cada ventana es el período entre dos conteos completos aplicados."
            />
          </div>
        </GroupLabel>
      )}
    </div>
  )
}

export default SustainedHealthTab
