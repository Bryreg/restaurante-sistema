import { useQuery } from "@tanstack/react-query"
import { useState } from "react"
import { Link } from "react-router-dom"

import { getControlHealth, getFoodCost, type FoodCostOut } from "@/api/inventory"
import { Cargando } from "@/components/Cargando"
import { GroupLabel, HeadlineFigure, NoticeRail, type Notice } from "@/components/admin"
import { DateRangeFilter } from "@/components/DateRangeFilter"
import { ChartFrame, Medidor, type Muestra } from "@/components/charts"
import { EmptyState } from "@/components/EmptyState"
import { SinDato } from "@/components/SinDato"
import { StatTile } from "@/components/StatTile"
import { formatPct } from "@/lib/format"
import { formatCOP } from "@/lib/money"
import { errorMessage } from "@/lib/errors"

import { daysAgoLocal, formatPuntos, textoVentana, todayLocal } from "./lib"
import { foodCostTitular } from "./titulares"

/**
 * Admin → Inventario → Salud del control (SPEC-NEGOCIO §5.4/§10/§9.3): los
 * cuatro indicadores que dicen cuándo los números del restaurante ya no
 * valen, más el food cost real — que se apaga solo pasados 14 días sin
 * conteo completo. Cada `null` se dice con su motivo; nunca un `0` ni un
 * `—` mudo (AGENTS.md).
 *
 * Los dos bloques llevan **rótulo de grupo** (patrón 3) porque son de
 * naturaleza distinta: arriba, **si los números se pueden creer**; abajo,
 * **el número**. Y el food cost es la **cifra rectora** de la pestaña
 * (patrón 4): no un número suelto, sino una resta con su libro a la vista.
 */
/** La base de la cifra: las comandas cobradas en la ventana entre conteos. */
function muestraDe(fc: FoodCostOut): Muestra | undefined {
  if (fc.orders_in_window === null) return undefined
  return {
    n: fc.orders_in_window,
    unidad: fc.orders_in_window === 1 ? "comanda" : "comandas",
    ventana: textoVentana(fc.window_hours, fc.window_days, fc.window_from, fc.window_to),
  }
}

/** El teórico como tarjeta: con su motivo cuando no hay. */
function TeoricoTile({ fc }: { fc: FoodCostOut }): React.JSX.Element {
  return (
    <StatTile
      label="Food cost teórico"
      {...(fc.theoretical_pct_bp === null
        ? {
            value: null,
            nullNote: fc.theoretical_reason ?? "El servidor no mandó el teórico de esta ventana.",
          }
        : {
            value: formatPct(fc.theoretical_pct_bp),
            hint:
              fc.costed_pct_bp === null
                ? "Lo que las fichas dicen que debió costar lo vendido."
                : `Lo que las fichas dicen que debió costar lo vendido; ${formatPct(fc.costed_pct_bp)} de la venta tiene ficha con costo.`,
          })}
    />
  )
}

/**
 * Food cost real publicado: la conclusión contra el teórico arriba (analista
 * #1: «Real X % vs teórico Y %: se pierden Z puntos»), la barra del real con
 * la marca del teórico, el
 * enlace a la varianza que explica la brecha y, abajo, la resta que deriva
 * el real (patrón 4). Todo porcentaje y la brecha vienen del servidor.
 */
function FoodCostDisponible({ fc }: { fc: FoodCostOut }): React.JSX.Element {
  const titular = foodCostTitular(fc) ?? "Food cost real"
  return (
    <div className="space-y-4">
      <div className="rounded-lg border bg-card p-4">
        <ChartFrame
          titular={titular}
          detalle="Food cost real contra teórico en la misma ventana entre conteos, en % de las ventas netas."
          muestra={muestraDe(fc)}
          tabla={{
            columnas: [
              { key: "concepto", header: "Concepto" },
              { key: "valor", header: "% de las ventas netas", align: "right" },
            ],
            filas: [
              { concepto: "Food cost real", valor: formatPct(fc.pct_bp) },
              {
                concepto: "Food cost teórico",
                valor:
                  fc.theoretical_pct_bp === null ? (
                    <SinDato motivo={fc.theoretical_reason} />
                  ) : (
                    formatPct(fc.theoretical_pct_bp)
                  ),
              },
              {
                concepto: "Brecha (real − teórico)",
                valor: fc.gap_bp === null ? <SinDato motivo={fc.theoretical_reason} /> : formatPuntos(fc.gap_bp),
              },
            ],
          }}
        >
          {fc.theoretical_pct_bp === null ? (
            <SinDato motivo={fc.theoretical_reason} forma="bloque">
              Sin teórico con qué comparar
            </SinDato>
          ) : (
            // La barra es el real; la marca, el teórico. Si el real pasa la marca, lo que sobra
            // de la barra es lo que se pierde (escalar a píxeles, no calcular).
            <Medidor
              valor={fc.pct_bp as number}
              meta={fc.theoretical_pct_bp}
              formato={(v) => formatPct(v)}
              etiquetaValor="Real"
              etiquetaMeta="Teórico"
              resumen={`${titular}.`}
            />
          )}
        </ChartFrame>
        {fc.gap_bp !== null && fc.gap_bp > 0 ? (
          <p className="mt-3 text-sm">
            <Link
              to="/admin/inventario?tab=varianza"
              className="font-medium text-primary underline-offset-4 hover:underline"
            >
              Ver qué insumos explican la brecha
            </Link>
            <span className="text-muted-foreground"> — Inventario › Varianza</span>
          </p>
        ) : null}
      </div>

      <HeadlineFigure
        label="Food cost real del período"
        value={formatPct(fc.pct_bp)}
        note={`entre los conteos #${fc.opening_count_id} y #${fc.closing_count_id}`}
        ledger={{
          rows: [
            {
              label: "Inventario inicial",
              value: formatCOP(fc.opening_value),
            },
            {
              label: "Compras del período",
              value: formatCOP(fc.purchases_value),
            },
            {
              label: "Inventario final",
              value: formatCOP(fc.closing_value),
              kind: "subtract",
            },
            {
              label: "÷ Ventas netas",
              value: formatCOP(fc.net_sales),
            },
          ],
          total: {
            label: "Food cost real",
            value: formatPct(fc.pct_bp),
          },
        }}
      />
    </div>
  )
}

/**
 * Hay dos conteos pero el servidor NO publica el real (ventana de menos de
 * 24 h, sin ventas, compras en $ 0 habiendo recepciones, o un costo
 * negativo): se dice el motivo del servidor —nunca un % negativo ni un 0—
 * y el teórico, que sí se sabe, queda al lado.
 */
function FoodCostRechazado({ fc }: { fc: FoodCostOut }): React.JSX.Element {
  const muestra = muestraDe(fc)
  return (
    <div className="space-y-3">
      <p className="text-base leading-snug font-semibold">
        Food cost real sin publicar entre los conteos #{fc.opening_count_id} y #{fc.closing_count_id}
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <StatTile
          label="Food cost real del período"
          value={null}
          nullNote={fc.reason ?? "El servidor no mandó el motivo."}
          link={{ to: "/admin/inventario?tab=conteos", screen: "Inventario", tab: "Conteos" }}
        />
        <TeoricoTile fc={fc} />
      </div>
      {muestra ? (
        <p className="text-xs text-muted-foreground">
          Ventana: {muestra.ventana ?? "—"} · {muestra.n} {muestra.unidad}
        </p>
      ) : null}
    </div>
  )
}

export function ControlHealthTab({ storeId }: { storeId: number }): React.JSX.Element {
  const [from, setFrom] = useState(daysAgoLocal(90))
  const [to, setTo] = useState(todayLocal())

  const healthQuery = useQuery({
    queryKey: ["inventory", "control-health", storeId],
    queryFn: () => getControlHealth(storeId),
  })

  const foodCostQuery = useQuery({
    queryKey: ["inventory", "food-cost", storeId, from, to],
    queryFn: () => getFoodCost({ storeId, from, to }),
  })

  if (healthQuery.isLoading) {
    return <Cargando texto="Cargando salud del control…" />
  }
  if (healthQuery.isError) {
    return (
      <EmptyState
        role="alert"
        title="No se pudo cargar la salud del control"
        description={errorMessage(healthQuery.error)}
        action={{
          label: "Reintentar",
          onClick: () => void healthQuery.refetch(),
        }}
      />
    )
  }
  const health = healthQuery.data
  const days = health?.days_since_full_count

  // Patrón 7: el aviso va en una columna de gravedad con recuento, y el
  // crítico va desplegado —cifra adelante, consecuencia en el cuerpo—.
  const notices: Notice[] = health?.inventory_unreliable
    ? [
        {
          id: "inventory-unreliable",
          severity: "critical",
          title: "Inventario no confiable",
          // La consecuencia es obligatoria en un crítico: un aviso que sólo
          // grita no deja decidir nada (patrón 7).
          consequence:
            "Más de 14 días sin un conteo completo aplicado. No bloquea la venta, pero el food cost real no se publica y la varianza de cada plato deja de querer decir nada.",
          link: {
            to: "/admin/inventario?tab=conteos",
            screen: "Inventario",
            tab: "Conteos",
          },
        },
      ]
    : []

  return (
    <div className="space-y-6">
      <GroupLabel
        label="Si los números se pueden creer"
        says="cuatro señales de que el control está vivo — o de que hace rato que no"
      >
        <div className="grid gap-3 lg:grid-cols-[1fr_auto]">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <StatTile
              label="Días desde el último conteo completo"
              {...(days === null || days === undefined
                ? {
                    value: null,
                    // `—` no es `0`: «nunca hubo conteo» NO es «hace cero
                    // días». La frase se conserva palabra por palabra.
                    nullNote: "Nunca hubo un conteo completo aplicado",
                  }
                : { value: String(days) })}
              tone={health?.inventory_unreliable ? "critical" : "default"}
              link={
                health?.inventory_unreliable
                  ? {
                      to: "/admin/inventario?tab=conteos",
                      screen: "Inventario",
                      tab: "Conteos",
                    }
                  : undefined
              }
            />
            <StatTile
              label="Recepciones con factura"
              {...(health?.reception_invoice_ratio_bp === null ||
              health?.reception_invoice_ratio_bp === undefined
                ? {
                    value: null,
                    nullNote:
                      health?.reception_invoice_ratio_reason ??
                      "Todavía no hay recepciones en la semana con qué calcularlo.",
                  }
                : {
                    value: formatPct(health.reception_invoice_ratio_bp),
                  })}
            />
            <StatTile
              label="Preparaciones por lote producidas esta semana"
              {...(health?.batch_preps_produced_ratio_bp === null ||
              health?.batch_preps_produced_ratio_bp === undefined
                ? {
                    value: null,
                    nullNote:
                      health?.batch_preps_produced_reason ??
                      "Todavía no hay preparaciones por lote con qué calcularlo.",
                  }
                : {
                    value: formatPct(health.batch_preps_produced_ratio_bp),
                  })}
            />
            <StatTile
              label="Mermas registradas esta semana"
              {...(health === undefined
                ? {
                    value: null,
                    nullNote: "No se pudo leer el conteo de mermas de la semana.",
                  }
                : { value: String(health.waste_entries_this_week) })}
            />
          </div>
          {notices.length > 0 ? <NoticeRail notices={notices} className="lg:w-80" /> : null}
        </div>
      </GroupLabel>

      <GroupLabel label="Food cost real" says="el número, cuando hay dos conteos completos que lo sostengan">
        <div className="mb-3">
          <DateRangeFilter
            idPrefix="food-cost"
            from={from}
            to={to}
            onChange={(r) => {
              setFrom(r.from)
              setTo(r.to)
            }}
          />
        </div>

        {foodCostQuery.isLoading ? (
          <p className="text-sm text-muted-foreground">Calculando…</p>
        ) : foodCostQuery.isError ? (
          <EmptyState
            role="alert"
            title="No se pudo calcular el food cost real"
            description={errorMessage(foodCostQuery.error)}
            action={{
              label: "Reintentar",
              onClick: () => void foodCostQuery.refetch(),
            }}
          />
        ) : foodCostQuery.data && foodCostQuery.data.pct_bp !== null ? (
          <FoodCostDisponible fc={foodCostQuery.data} />
        ) : foodCostQuery.data && foodCostQuery.data.opening_count_id !== null ? (
          <FoodCostRechazado fc={foodCostQuery.data} />
        ) : (
          <EmptyState
            title="Food cost real no disponible"
            description={
              foodCostQuery.data?.reason ??
              "Hacen falta dos conteos completos aplicados y consecutivos en el período."
            }
            action={{
              label: "Ir a Conteos",
              to: "/admin/inventario?tab=conteos",
            }}
          />
        )}
      </GroupLabel>
    </div>
  )
}

export default ControlHealthTab
