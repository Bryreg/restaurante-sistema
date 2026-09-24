import { useQuery } from "@tanstack/react-query"
import { useState } from "react"

import {
  getIngredientMovements,
  ingredientMovementsCsvUrl,
  type StockMovementOut,
  type IngredientOut,
  type MovementCause,
} from "@/api/inventory"
import {
  DenseTable,
  DenseTableBar,
  TimeAgo,
  type DenseColumn,
  type LegendEntry,
  type RowStatus,
} from "@/components/admin"
import { CostValue } from "@/components/CostValue"
import { CsvExportButton } from "@/components/CsvExportButton"
import { DateRangeFilter } from "@/components/DateRangeFilter"
import { DependencyEmptyState } from "@/components/admin"
import { EmptyState } from "@/components/EmptyState"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { errorMessage } from "@/lib/errors"
import { formatCantidad } from "@/lib/format"
import { cn } from "@/lib/utils"

import { CAUSE_LABEL, daysAgoLocal, todayLocal } from "./lib"

const UNIT_LABEL: Record<string, string> = { g: "g", ml: "ml", unit: "unidad" }

const LEGEND: readonly LegendEntry[] = [
  {
    term: "Cantidad con signo",
    meaning: (
      <>
        negativa <b>sale</b>, positiva <b>entra</b>. El saldo del stock es la suma de esta columna, no un
        número guardado aparte.
      </>
    ),
  },
  {
    term: "Ajuste manual",
    meaning: (
      <>
        la única causa que escribe una persona y no el sistema. Lleva motivo obligatorio y el nombre de quien
        lo autorizó.
      </>
    ),
  },
  {
    term: "Sin costo",
    meaning: (
      <>
        no es <b>$ 0</b> — el movimiento no tiene costo conocido, y por eso no entra en ninguna suma de costo.
      </>
    ),
  },
]

/**
 * Libro de movimientos de UN insumo (SPEC-NEGOCIO §5.1): `GET
 * /admin/ingredients/{id}/movements` es por insumo, no hay un endpoint
 * global — por eso esta pantalla obliga a elegir uno primero. La causa es
 * un enum cerrado (`CAUSE_LABEL`): el filtro es una lista desplegable, nunca
 * un campo de texto libre (AGENTS.md § "la causa no se infiere de un
 * texto").
 */
export function MovementsPanel({ ingredients }: { ingredients: IngredientOut[] }): React.JSX.Element {
  const [ingredientId, setIngredientId] = useState<number | null>(ingredients[0]?.id ?? null)
  const [from, setFrom] = useState(daysAgoLocal(30))
  const [to, setTo] = useState(todayLocal())
  const [cause, setCause] = useState<MovementCause | "all">("all")

  const selected = ingredients.find((i) => i.id === ingredientId) ?? null

  const query = useQuery({
    queryKey: ["inventory", "movements", ingredientId, from, to, cause],
    queryFn: () =>
      getIngredientMovements({
        ingredientId: ingredientId as number,
        from,
        to,
        cause: cause === "all" ? undefined : cause,
      }),
    enabled: ingredientId !== null,
  })

  if (ingredients.length === 0) {
    // Patrón 13, motivo «dependencia»: lleva a la pantalla que crea lo que
    // falta, en vez de decir «no hay datos» y callarse.
    return (
      <DependencyEmptyState
        title="Todavía no hay insumos"
        description="El libro de movimientos es siempre el de UN insumo. Primero tiene que existir alguno."
        create={{
          label: "Crear el primer insumo",
          to: "/admin/inventario?tab=insumos",
        }}
      />
    )
  }

  const rows = query.data ?? []
  const unit = selected ? (UNIT_LABEL[selected.base_unit] ?? selected.base_unit) : ""

  // Un ajuste manual es el único movimiento que escribió una persona: la
  // franja lo deja ver sin leer la columna de causa.
  function statusOf(movement: StockMovementOut): RowStatus {
    return movement.cause === "manual_adjustment" ? "warning" : "none"
  }

  const columns: readonly DenseColumn<StockMovementOut>[] = [
    {
      key: "at",
      header: "Fecha",
      kind: "secondary",
      cell: (m) => <TimeAgo iso={m.at} />,
    },
    {
      key: "cause",
      header: "Causa",
      cell: (m) => CAUSE_LABEL[m.cause] ?? m.cause,
    },
    {
      key: "qty",
      header: "Cantidad",
      kind: "number",
      cell: (m) => (
        <span className={cn(Number(m.qty_base) < 0 && "text-destructive")}>
          {formatCantidad(m.qty_base, unit)}
        </span>
      ),
    },
    {
      key: "cost",
      header: "Costo",
      kind: "number",
      cell: (m) => <CostValue cost={m.cost} costSource={m.cost_source} />,
    },
    { key: "who", header: "Persona", cell: (m) => m.employee_name },
    {
      key: "note",
      header: "Nota",
      kind: "secondary",
      // Detrás de «Más columnas» (regla 3); el texto entero sigue en el `title`.
      secondary: true,
      // La nota puede ser larga: se recorta con elipsis y el texto entero va
      // al `title`. Nunca parte la palabra ni hace crecer la fila.
      widthPx: 220,
      cell: (m) => <span className="block truncate">{m.note ?? "—"}</span>,
      cellTitle: (m) => m.note ?? undefined,
    },
  ]

  if (query.isError) {
    return (
      <EmptyState
        role="alert"
        title="No se pudieron cargar los movimientos"
        description={errorMessage(query.error)}
        action={{ label: "Reintentar", onClick: () => void query.refetch() }}
      />
    )
  }

  // Los filtros son **armazón**, no datos: cargando se conservan (patrón
  // 13). Si desaparecieran mientras llega la respuesta, el insumo y el
  // rango que la persona acaba de elegir parpadearían en cada consulta.
  const filters = (
    <>
      <div className="flex items-center gap-2">
        <Label htmlFor="mov-ingredient">Insumo</Label>
        <Select
          value={ingredientId === null ? undefined : String(ingredientId)}
          onValueChange={(v) => setIngredientId(Number(v))}
        >
          <SelectTrigger id="mov-ingredient" className="h-8 w-48">
            <SelectValue placeholder="Elegí un insumo" />
          </SelectTrigger>
          <SelectContent>
            {ingredients.map((ingredient) => (
              <SelectItem key={ingredient.id} value={String(ingredient.id)}>
                {ingredient.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <DateRangeFilter
        idPrefix="mov"
        from={from}
        to={to}
        onChange={(r) => {
          setFrom(r.from)
          setTo(r.to)
        }}
      />
      <div className="flex items-center gap-2">
        <Label htmlFor="mov-cause">Causa</Label>
        <Select value={cause} onValueChange={(v) => setCause(v as MovementCause | "all")}>
          <SelectTrigger id="mov-cause" className="h-8 w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Todas</SelectItem>
            {Object.entries(CAUSE_LABEL).map(([value, label]) => (
              <SelectItem key={value} value={value}>
                {label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {ingredientId !== null ? (
        <CsvExportButton
          href={ingredientMovementsCsvUrl({
            ingredientId,
            from,
            to,
            cause: cause === "all" ? undefined : cause,
          })}
        />
      ) : null}
    </>
  )

  return (
    <DenseTable
      caption={`Movimientos de ${selected?.name ?? "el insumo"}`}
      columns={columns}
      rows={rows}
      rowKey={(m) => String(m.id)}
      rowStatus={statusOf}
      legend={LEGEND}
      bar={
        <DenseTableBar
          shown={rows.length}
          total={rows.length}
          noun="movimientos en el período"
          hidden={
            query.isLoading ? "contando…" : cause === "all" ? undefined : `sólo «${CAUSE_LABEL[cause]}»`
          }
        >
          {filters}
        </DenseTableBar>
      }
      empty={
        query.isLoading ? undefined : (
          <EmptyState
            title="Sin movimientos en este período"
            description="Probá otro rango de fechas, otra causa, u otro insumo."
          />
        )
      }
    />
  )
}

export default MovementsPanel
