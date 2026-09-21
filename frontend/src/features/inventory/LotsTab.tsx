import { useQuery } from "@tanstack/react-query"
import { useState } from "react"
import { Link } from "react-router-dom"

import { getLots, type IngredientOut, type LotOut, type LotStatus } from "@/api/inventory"
import {
  DenseTable,
  DenseTableBar,
  TimeAgo,
  type DenseColumn,
  type LegendEntry,
  type RowStatus,
} from "@/components/admin"
import { CostValue } from "@/components/CostValue"
import { EmptyState } from "@/components/EmptyState"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { errorMessage } from "@/lib/errors"
import { cn } from "@/lib/utils"

import { LOT_STATUS_LABEL } from "./lib"

const UNIT_LABEL: Record<string, string> = { g: "g", ml: "ml", unit: "unidad" }

const LEGEND: readonly LegendEntry[] = [
  {
    term: "Por vencer",
    meaning: "todavía sirve. Es aviso de FEFO: sale antes que los demás, no es una pérdida.",
  },
  {
    term: "Vencido",
    meaning: (
      <>
        ya no debería usarse, pero <b>sigue contando en el stock</b>: el sistema no da de baja solo. Darlo de
        baja es un acto de alguien, con su PIN, registrando la merma.
      </>
    ),
  },
  {
    term: "Agotado",
    meaning: "se consumió entero. Queda a la vista porque su costo ya entró en platos vendidos.",
  },
]

/**
 * Admin → Inventario → Lotes (SPEC-NEGOCIO §5.7 / §9.3): FEFO declarado (el
 * más próximo a vencer primero, y a igualdad el recibido primero — la
 * salida ya la decide `app.inventory.hooks` en el servidor; acá sólo se
 * lista, nunca se recalcula un estado a partir de fechas).
 *
 * **Un lote vencido NO se da de baja solo, y esta pantalla NO ofrece darlo
 * de baja**: el único camino correctivo es el enlace a registrar la merma
 * `expired` que ya existe (`/pos/merma`, dispositivo — la baja de un lote es
 * un acto de alguien, con PIN, nunca automático). No hay ningún botón
 * "Dar de baja" ni "Marcar vencido" en este archivo — esa ausencia es la
 * regla, no un detalle de interacción (SPEC-NEGOCIO §5.5/§5.7).
 */
export function LotsTab({
  storeId,
  ingredients,
}: {
  storeId: number
  ingredients: IngredientOut[]
}): React.JSX.Element {
  const [ingredientId, setIngredientId] = useState<number | "all">("all")
  const [status, setStatus] = useState<LotStatus | "all">("all")
  const [expiringWithinDays, setExpiringWithinDays] = useState("")

  const query = useQuery({
    queryKey: ["inventory", "lots", storeId, ingredientId, status, expiringWithinDays],
    queryFn: () =>
      getLots({
        storeId,
        ingredientId: ingredientId === "all" ? undefined : ingredientId,
        status: status === "all" ? undefined : status,
        expiringWithinDays: expiringWithinDays.trim() === "" ? undefined : Number(expiringWithinDays),
      }),
  })

  const rows = query.data ?? []
  // `LotOut` no trae `base_unit` (gap declarado en §8 del entregable): se
  // resuelve cruzando contra `ingredients` (ya cargado por
  // `InventoryAdminPage`, este territorio) — nunca se adivina ni se omite.
  const unitByIngredient = new Map(ingredients.map((i) => [i.id, i.base_unit]))
  const expired = rows.filter((r) => r.status === "expired").length

  function statusOf(lot: LotOut): RowStatus {
    if (lot.status === "expired") return "critical"
    if (lot.status === "expiring") return "warning"
    return "none"
  }

  const columns: readonly DenseColumn<LotOut>[] = [
    {
      key: "ingredient",
      header: "Insumo",
      kind: "name",
      cell: (l) => l.ingredient_name,
    },
    { key: "lot", header: "Lote", kind: "id", cell: (l) => l.lot_code ?? "—" },
    {
      key: "received",
      header: "Recibido",
      kind: "secondary",
      cell: (l) => <TimeAgo iso={l.received_at} />,
    },
    {
      key: "expires",
      header: "Vence",
      cell: (l) => l.expires_at ?? "No vence",
    },
    {
      key: "qty",
      header: "Restante",
      kind: "number",
      cell: (l) => {
        const unit = unitByIngredient.get(l.ingredient_id)
        return `${l.qty_remaining} ${unit ? (UNIT_LABEL[unit] ?? unit) : ""}`.trim()
      },
    },
    {
      key: "cost",
      header: "Costo",
      kind: "number",
      cell: (l) => <CostValue cost={l.unit_cost} costSource={l.cost_source} />,
    },
    {
      key: "status",
      header: "Estado",
      cell: (l) => (
        <span className="inline-flex items-center gap-1.5">
          <span
            className={cn(
              "size-1.5 shrink-0 rounded-full",
              l.status === "expired"
                ? "bg-destructive"
                : l.status === "expiring"
                  ? "bg-warning"
                  : l.status === "active"
                    ? "bg-success"
                    : "bg-muted-foreground",
            )}
            aria-hidden="true"
          />
          {LOT_STATUS_LABEL[l.status]}
        </span>
      ),
    },
    {
      key: "action",
      header: "",
      kind: "actions",
      // El cruce admin → POS: un lote vencido se corrige registrando la
      // merma en el dispositivo, con PIN. Es el único camino correctivo, y
      // de los más fáciles de perder en un rediseño.
      cell: (l) =>
        l.status === "expired" ? (
          <Link to="/pos/merma" className="text-xs font-bold text-primary underline underline-offset-2">
            Registrar merma (vencido)
          </Link>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    },
  ]

  if (query.isError) {
    return (
      <EmptyState
        role="alert"
        title="No se pudieron cargar los lotes"
        description={errorMessage(query.error)}
        action={{ label: "Reintentar", onClick: () => void query.refetch() }}
      />
    )
  }

  // Los filtros son **armazón**, no datos: cargando se conservan (patrón
  // 13, «cargando conserva el armazón y esqueletea sólo los datos»). Si
  // desaparecieran mientras llega la respuesta, lo que la persona acaba de
  // elegir parpadearía en cada consulta.
  const filters = (
    <>
      <div className="flex items-center gap-2">
        <Label htmlFor="lots-ingredient">Insumo</Label>
        <Select
          value={ingredientId === "all" ? "all" : String(ingredientId)}
          onValueChange={(v) => setIngredientId(v === "all" ? "all" : Number(v))}
        >
          <SelectTrigger id="lots-ingredient" className="h-8 w-44">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Todos los insumos</SelectItem>
            {ingredients.map((ingredient) => (
              <SelectItem key={ingredient.id} value={String(ingredient.id)}>
                {ingredient.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="flex items-center gap-2">
        <Label htmlFor="lots-status">Estado</Label>
        <Select value={status} onValueChange={(v) => setStatus(v as LotStatus | "all")}>
          <SelectTrigger id="lots-status" className="h-8 w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Todos los estados</SelectItem>
            {Object.entries(LOT_STATUS_LABEL).map(([value, label]) => (
              <SelectItem key={value} value={value}>
                {label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="flex items-center gap-2">
        <Label htmlFor="lots-expiring-days">Días para vencer (máximo)</Label>
        <Input
          id="lots-expiring-days"
          type="number"
          min={0}
          className="h-8 w-24"
          value={expiringWithinDays}
          onChange={(event) => setExpiringWithinDays(event.target.value)}
        />
      </div>
    </>
  )

  return (
    <DenseTable
      caption="Lotes por insumo"
      columns={columns}
      rows={rows}
      rowKey={(l) => String(l.id)}
      rowStatus={statusOf}
      rowInactive={(l) => l.status === "depleted"}
      legend={LEGEND}
      bar={
        <DenseTableBar
          shown={rows.length}
          total={rows.length}
          noun="lotes"
          hidden={
            query.isLoading ? "contando…" : expired > 0 ? `${expired} vencidos, todavía en stock` : undefined
          }
        >
          {filters}
        </DenseTableBar>
      }
      note={
        <>
          {/* GAP declarado (§8 del entregable): `GET /admin/lots` no declara
              `format=csv` en el backend — no hay `CsvExportButton` acá a
              propósito, para no ofrecer una descarga que en realidad no
              funciona. La ausencia se dice en voz alta en vez de quedar como
              un olvido. */}
          El orden de salida es <b>FEFO</b> y lo decide el servidor: primero el que vence antes, y a igualdad
          el que llegó antes. <b>Esta pantalla no da de baja ningún lote</b> — un vencido se corrige
          registrando la merma, con PIN. Sin exportación: el servidor todavía no la ofrece para lotes.
        </>
      }
      empty={
        query.isLoading ? undefined : (
          <EmptyState
            title="Sin lotes para estos filtros"
            description="Los lotes los crea una recepción de compra con número de lote y vencimiento. Probá sacando algún filtro, o revisá Compras."
          />
        )
      }
    />
  )
}

export default LotsTab
