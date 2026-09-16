import { useQuery } from "@tanstack/react-query"
import { useState } from "react"

import { getIngredientMovements, ingredientMovementsCsvUrl, type IngredientOut, type MovementCause } from "@/api/inventory"
import { CostValue } from "@/components/CostValue"
import { CsvExportButton } from "@/components/CsvExportButton"
import { DateRangeFilter } from "@/components/DateRangeFilter"
import { EmptyState } from "@/components/EmptyState"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { errorMessage } from "@/lib/errors"
import { formatInstant } from "@/lib/businessDate"

import { CAUSE_LABEL, daysAgoLocal, todayLocal } from "./lib"

const UNIT_LABEL: Record<string, string> = { g: "g", ml: "ml", unit: "unidad" }

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
    return <EmptyState title="Todavía no hay insumos" description="Creá insumos en la pestaña «Insumos» primero." />
  }

  const rows = query.data ?? []

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1">
          <Label htmlFor="mov-ingredient">Insumo</Label>
          <Select value={ingredientId === null ? undefined : String(ingredientId)} onValueChange={(v) => setIngredientId(Number(v))}>
            <SelectTrigger id="mov-ingredient" className="h-10 w-56">
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
        <DateRangeFilter idPrefix="mov" from={from} to={to} onChange={(r) => { setFrom(r.from); setTo(r.to) }} />
        <div className="space-y-1">
          <Label htmlFor="mov-cause">Causa</Label>
          <Select value={cause} onValueChange={(v) => setCause(v as MovementCause | "all")}>
            <SelectTrigger id="mov-cause" className="h-10 w-48">
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
            href={ingredientMovementsCsvUrl({ ingredientId, from, to, cause: cause === "all" ? undefined : cause })}
          />
        ) : null}
      </div>

      {query.isLoading ? (
        <p className="text-sm text-muted-foreground">Cargando movimientos…</p>
      ) : query.isError ? (
        <EmptyState
          role="alert"
          title="No se pudieron cargar los movimientos"
          description={errorMessage(query.error)}
          action={{ label: "Reintentar", onClick: () => void query.refetch() }}
        />
      ) : rows.length === 0 ? (
        <EmptyState title="Sin movimientos en este período" description="Probá otro rango de fechas o causa." />
      ) : (
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Fecha</TableHead>
                <TableHead>Causa</TableHead>
                <TableHead>Cantidad</TableHead>
                <TableHead>Costo</TableHead>
                <TableHead>Persona</TableHead>
                <TableHead>Nota</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((movement) => (
                <TableRow key={movement.id}>
                  <TableCell className="whitespace-nowrap">{formatInstant(movement.at)}</TableCell>
                  <TableCell>{CAUSE_LABEL[movement.cause] ?? movement.cause}</TableCell>
                  <TableCell className="tabular-nums">
                    {movement.qty_base} {selected ? UNIT_LABEL[selected.base_unit] ?? selected.base_unit : ""}
                  </TableCell>
                  <TableCell>
                    <CostValue cost={movement.cost} costSource={movement.cost_source} />
                  </TableCell>
                  <TableCell>{movement.employee_name}</TableCell>
                  <TableCell className="max-w-xs truncate">{movement.note ?? "—"}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  )
}

export default MovementsPanel
