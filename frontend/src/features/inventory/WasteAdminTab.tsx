import { useQuery } from "@tanstack/react-query"
import { useState } from "react"

import { listEmployees } from "@/api/employees"
import {
  getWasteList,
  wasteCsvUrl,
  type IngredientOut,
  type WasteAdminOut,
  type WasteType,
} from "@/api/inventory"
import { listPreparations } from "@/api/recipes"
import { DenseTable, DenseTableBar, TimeAgo, type DenseColumn, type LegendEntry } from "@/components/admin"
import { CostValue } from "@/components/CostValue"
import { CsvExportButton } from "@/components/CsvExportButton"
import { DateRangeFilter } from "@/components/DateRangeFilter"
import { EmptyState } from "@/components/EmptyState"
import { StatTile } from "@/components/StatTile"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { errorMessage } from "@/lib/errors"
import { formatPct } from "@/lib/format"

import { daysAgoLocal, todayLocal, WASTE_TYPE_LABEL } from "./lib"

const LEGEND: readonly LegendEntry[] = [
  {
    term: "Sin costo",
    meaning: (
      <>
        no es <b>$ 0</b> — lo que se perdió no tiene costo conocido. La merma pasó igual; lo que no se sabe es
        cuánto costó.
      </>
    ),
  },
  {
    term: "Sin identificar",
    meaning: "el tipo tipado para cuando nadie supo qué pasó. Es una causa, no un hueco.",
  },
  {
    term: "Foto",
    meaning: "queda como estaba el día que se registró. Apagar la foto obligatoria no borra las ya tomadas.",
  },
]

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
 *
 * **Deuda cerrada en 2b** (`outputs-2a/ENTREGA.md §5`, O-6): `ratio` dejó de
 * ser una fracción 0..1 y pasó a ser un entero en puntos básicos reales
 * (`app.inventory.schemas.WasteKpiOut.ratio: int | None`, 100 = 1 %). Se
 * formatea con `formatPct` (`@/lib/format`, «4,4 %» en es-CO), nunca con
 * `Math.round(kpi.ratio * 100)` — esa cuenta, correcta para la fracción de
 * 2a, con la escala nueva da cien veces más (250 bp × 100 = "25000 %").
 */
export function WasteAdminTab({
  storeId,
  ingredients,
}: {
  storeId: number
  ingredients: IngredientOut[]
}): React.JSX.Element {
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

  const columns: readonly DenseColumn<WasteAdminOut>[] = [
    {
      key: "at",
      header: "Fecha",
      kind: "secondary",
      cell: (w) => <TimeAgo iso={w.at} />,
    },
    {
      key: "type",
      header: "Tipo",
      cell: (w) => WASTE_TYPE_LABEL[w.type] ?? w.type,
    },
    {
      key: "what",
      header: "Insumo / preparación",
      kind: "name",
      cell: (w) =>
        w.ingredient_id !== null
          ? (ingredientName.get(w.ingredient_id) ?? `Insumo #${w.ingredient_id}`)
          : (preparationName.get(w.preparation_id as number) ?? `Preparación #${w.preparation_id}`),
    },
    // Cantidad y nota, detrás de «Más columnas» (regla 3): la primera
    // lectura es qué se perdió, cuánto costó y quién responde.
    { key: "qty", header: "Cantidad", kind: "number", secondary: true, cell: (w) => w.qty },
    {
      key: "cost",
      header: "Costo",
      kind: "number",
      cell: (w) => <CostValue cost={w.cost} costSource={w.cost_source} />,
    },
    { key: "who", header: "Responsable", cell: (w) => w.employee_name },
    {
      key: "note",
      header: "Nota",
      kind: "secondary",
      secondary: true,
      widthPx: 200,
      cell: (w) => <span className="block truncate">{w.note ?? "—"}</span>,
      cellTitle: (w) => w.note ?? undefined,
    },
    {
      key: "photo",
      header: "Foto",
      kind: "actions",
      cell: (w) =>
        w.photo ? (
          <a
            href={w.photo}
            target="_blank"
            rel="noreferrer"
            className="text-xs font-bold text-primary underline underline-offset-2"
          >
            Ver
          </a>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    },
  ]

  if (query.isError) {
    return (
      <EmptyState
        role="alert"
        title="No se pudieron cargar las mermas"
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
      <DateRangeFilter
        idPrefix="waste"
        from={from}
        to={to}
        onChange={(r) => {
          setFrom(r.from)
          setTo(r.to)
        }}
      />
      <div className="flex items-center gap-2">
        <Label htmlFor="waste-type">Tipo</Label>
        <Select value={type} onValueChange={(v) => setType(v as WasteType | "all")}>
          <SelectTrigger id="waste-type" className="h-8 w-40">
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
      <div className="flex items-center gap-2">
        <Label htmlFor="waste-employee">Responsable</Label>
        <Select
          value={employeeId === "all" ? "all" : String(employeeId)}
          onValueChange={(v) => setEmployeeId(v === "all" ? "all" : Number(v))}
        >
          <SelectTrigger id="waste-employee" className="h-8 w-40">
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
        href={wasteCsvUrl({
          storeId,
          from,
          to,
          type: type === "all" ? undefined : type,
          employeeId: employeeId === "all" ? undefined : employeeId,
        })}
      />
    </>
  )

  return (
    <div className="space-y-3">
      <div className="max-w-sm">
        {/* `null` NO es `0` (patrón 5): sin compras con qué comparar, la
            tarjeta se dibuja apagada y dice POR QUÉ no se sabe — nunca «0 %»,
            que se leería como «no se pierde nada». */}
        <StatTile
          label="Mermas ÷ compras (semanal)"
          {...(kpi === undefined || kpi.ratio === null
            ? {
                value: null,
                // Las palabras «sin datos» son la red de `src/audit/
                // inventory.test.ts`: un `0 %` acá se leería como «no se
                // pierde nada», que es lo contrario del dato. La tarjeta ya
                // dibuja «Sin datos» rayado; esto es el motivo.
                nullNote:
                  "No es 0 %: queda sin datos hasta que haya compras en la semana con qué compararlo, porque no hay divisor.",
              }
            : {
                value: formatPct(kpi.ratio),
                hint: "Referencia del sector: 4–10 %.",
              })}
        />
      </div>

      <DenseTable
        caption="Mermas del período"
        columns={columns}
        rows={items}
        rowKey={(w) => String(w.id)}
        legend={LEGEND}
        bar={
          <DenseTableBar
            shown={items.length}
            total={items.length}
            noun="mermas en el período"
            hidden={
              query.isLoading ? "contando…" : type === "all" ? undefined : `sólo «${WASTE_TYPE_LABEL[type]}»`
            }
          >
            {filters}
          </DenseTableBar>
        }
        empty={
          query.isLoading ? undefined : (
            <EmptyState
              title="Sin mermas en este período"
              description="Probá otro rango de fechas, tipo o responsable. Las mermas se registran desde el dispositivo del salón, con PIN."
            />
          )
        }
      />
    </div>
  )
}

export default WasteAdminTab
