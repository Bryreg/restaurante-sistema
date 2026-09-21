import { useQuery } from "@tanstack/react-query"
import { useState } from "react"

import { getControlHealth, getFoodCost } from "@/api/inventory"
import { GroupLabel, HeadlineFigure, NoticeRail, type Notice } from "@/components/admin"
import { DateRangeFilter } from "@/components/DateRangeFilter"
import { EmptyState } from "@/components/EmptyState"
import { StatTile } from "@/components/StatTile"
import { formatCOP } from "@/lib/money"
import { errorMessage } from "@/lib/errors"

import { daysAgoLocal, formatBasisPoints, todayLocal } from "./lib"

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
    return <p className="text-sm text-muted-foreground">Cargando salud del control…</p>
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
                    value: formatBasisPoints(health.reception_invoice_ratio_bp),
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
                    value: formatBasisPoints(health.batch_preps_produced_ratio_bp),
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
        ) : !foodCostQuery.data?.available ? (
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
        ) : (
          // Patrón 4: la cifra rectora NO es un número suelto, es una resta
          // con su libro. Los cuatro componentes dejan de ser cuatro
          // tarjetas sueltas y pasan a ser los renglones que la derivan.
          <HeadlineFigure
            label="Food cost real del período"
            value={formatBasisPoints(foodCostQuery.data.pct_bp)}
            note={`entre los conteos #${foodCostQuery.data.opening_count_id} y #${foodCostQuery.data.closing_count_id}`}
            ledger={{
              rows: [
                {
                  label: "Inventario inicial",
                  value: formatCOP(foodCostQuery.data.opening_value),
                },
                {
                  label: "Compras del período",
                  value: formatCOP(foodCostQuery.data.purchases_value),
                },
                {
                  label: "Inventario final",
                  value: formatCOP(foodCostQuery.data.closing_value),
                  kind: "subtract",
                },
                {
                  label: "÷ Ventas netas",
                  value: formatCOP(foodCostQuery.data.net_sales),
                },
              ],
              total: {
                label: "Food cost real",
                value: formatBasisPoints(foodCostQuery.data.pct_bp),
              },
            }}
          />
        )}
      </GroupLabel>
    </div>
  )
}

export default ControlHealthTab
