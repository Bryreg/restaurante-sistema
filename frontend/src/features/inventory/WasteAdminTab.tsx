import { useQuery } from "@tanstack/react-query"
import { useState } from "react"

import { listEmployees } from "@/api/employees"
import { getWasteList, wasteCsvUrl, type IngredientOut, type WasteType } from "@/api/inventory"
import { listPreparations } from "@/api/recipes"
import { CostValue } from "@/components/CostValue"
import { CsvExportButton } from "@/components/CsvExportButton"
import { DateRangeFilter } from "@/components/DateRangeFilter"
import { EmptyState } from "@/components/EmptyState"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { errorMessage } from "@/lib/errors"
import { formatInstant } from "@/lib/businessDate"

import { daysAgoLocal, todayLocal, WASTE_TYPE_LABEL } from "./lib"

/**
 * Admin → Inventario → Movimientos y mermas → Mermas (SPEC-NEGOCIO §5.5):
 * listado por tipo/responsable/fecha con el costo con su origen — nunca en
 * la ruta de dispositivo, que es la que registra sin verlo (AGENTS.md). El
 * KPI semanal merma ÷ compras dice "sin datos" hasta 2b (no hay compras
 * todavía): el `ratio` que manda el servidor es `null` y este componente
 * NUNCA lo reemplaza por `0`, sólo pinta el `label` tal cual llega.
 *
 * GAP declarado en el entregable: `WasteAdminOut` (`GET /admin/waste`) sólo
 * trae `ingredient_id`/`preparation_id`, sin nombre — acá se resuelve
 * cruzando contra `ingredients` (ya cargado por `InventoryAdminPage`, este
 * territorio) y `listPreparations` (`api/recipes.ts`, sólo lectura,
 * territorio de `frontend-recetas`); si `catalog.preps` está apagada o la
 * preparación no está en esa lista, se muestra el id crudo en vez de
 * inventar un nombre.
 */
export function WasteAdminTab({ storeId, ingredients }: { storeId: number; ingredients: IngredientOut[] }): React.JSX.Element {
  const [from, setFrom] = useState(daysAgoLocal(30))
  const [to, setTo] = useState(todayLocal())
  const [type, setType] = useState<WasteType | "all">("all")
  const [employeeId, setEmployeeId] = useState<number | "all">("all")

  const employeesQuery = useQuery({
    queryKey: ["inventory", "waste-employees", storeId],
    queryFn: () => listEmployees({ storeId }),
  })

  const preparationsQuery = useQuery({
    queryKey: ["inventory", "waste-preparations", storeId],
    queryFn: () => listPreparations(storeId),
  })

  const ingredientName = new Map(ingredients.map((i) => [i.id, i.name]))
  const preparationName = new Map((preparationsQuery.data ?? []).map((p) => [p.id, p.name]))

  const query = useQuery({
    queryKey: ["inventory", "waste", storeId, from, to, type, employeeId],
    queryFn: () =>
      getWasteList({
        storeId,
        from,
        to,
        type: type === "all" ? undefined : type,
        employeeId: employeeId === "all" ? undefined : employeeId,
      }),
  })

  const employees = employeesQuery.data ?? []
  const items = query.data?.items ?? []
  const kpi = query.data?.weekly_kpi

  return (
    <div className="space-y-4">
      <div className="rounded-lg border p-4">
        <p className="text-sm text-muted-foreground">Mermas ÷ compras (semanal)</p>
        <p className="mt-1 text-2xl font-semibold tabular-nums">
          {kpi === undefined ? "—" : kpi.ratio === null ? "Sin datos" : `${Math.round(kpi.ratio * 100)}%`}
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          {kpi?.ratio === null || kpi === undefined
            ? "Se calcula cuando el módulo de compras (2b) tenga datos — no es 0 %, es que todavía no hay con qué compararlo."
            : "Referencia del sector: 4–10 %."}
        </p>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <DateRangeFilter idPrefix="waste" from={from} to={to} onChange={(r) => { setFrom(r.from); setTo(r.to) }} />
        <div className="space-y-1">
          <Label htmlFor="waste-type">Tipo</Label>
          <Select value={type} onValueChange={(v) => setType(v as WasteType | "all")}>
            <SelectTrigger id="waste-type" className="h-10 w-48">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Todos</SelectItem>
              {Object.entries(WASTE_TYPE_LABEL).map(([value, label]) => (
                <SelectItem key={value} value={value}>
                  {label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="waste-employee">Responsable</Label>
          <Select value={employeeId === "all" ? "all" : String(employeeId)} onValueChange={(v) => setEmployeeId(v === "all" ? "all" : Number(v))}>
            <SelectTrigger id="waste-employee" className="h-10 w-48">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Todos</SelectItem>
              {employees.map((employee) => (
                <SelectItem key={employee.id} value={String(employee.id)}>
                  {employee.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <CsvExportButton
          href={wasteCsvUrl({ storeId, from, to, type: type === "all" ? undefined : type, employeeId: employeeId === "all" ? undefined : employeeId })}
        />
      </div>

      {query.isLoading ? (
        <p className="text-sm text-muted-foreground">Cargando mermas…</p>
      ) : query.isError ? (
        <EmptyState
          role="alert"
          title="No se pudieron cargar las mermas"
          description={errorMessage(query.error)}
          action={{ label: "Reintentar", onClick: () => void query.refetch() }}
        />
      ) : items.length === 0 ? (
        <EmptyState title="Sin mermas en este período" description="Probá otro rango de fechas, tipo o responsable." />
      ) : (
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Fecha</TableHead>
                <TableHead>Tipo</TableHead>
                <TableHead>Insumo / preparación</TableHead>
                <TableHead>Cantidad</TableHead>
                <TableHead>Costo</TableHead>
                <TableHead>Responsable</TableHead>
                <TableHead>Nota</TableHead>
                <TableHead>Foto</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((waste) => (
                <TableRow key={waste.id}>
                  <TableCell className="whitespace-nowrap">{formatInstant(waste.at)}</TableCell>
                  <TableCell>{WASTE_TYPE_LABEL[waste.type] ?? waste.type}</TableCell>
                  <TableCell>
                    {waste.ingredient_id !== null
                      ? ingredientName.get(waste.ingredient_id) ?? `Insumo #${waste.ingredient_id}`
                      : preparationName.get(waste.preparation_id as number) ?? `Preparación #${waste.preparation_id}`}
                  </TableCell>
                  <TableCell className="tabular-nums">{waste.qty}</TableCell>
                  <TableCell>
                    <CostValue cost={waste.cost} costSource={waste.cost_source} />
                  </TableCell>
                  <TableCell>{waste.employee_name}</TableCell>
                  <TableCell className="max-w-xs truncate">{waste.note ?? "—"}</TableCell>
                  <TableCell>
                    {waste.photo ? (
                      <a href={waste.photo} target="_blank" rel="noreferrer" className="text-primary underline">
                        Ver
                      </a>
                    ) : (
                      "—"
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  )
}

export default WasteAdminTab
