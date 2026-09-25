import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useRef, useState } from "react"
import { toast } from "sonner"

import { useStoreSelection } from "@/app/storeContext"
import { ApiError, newIdempotencyKey } from "@/api/client"
import { listEmployees } from "@/api/employees"
import {
  getIncomingTransfers,
  getWasteList,
  receiveTransfer,
  wasteCsvUrl,
  type IncomingTransferOut,
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
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { errorMessage } from "@/lib/errors"
import { formatInstant } from "@/lib/businessDate"
import { formatPct } from "@/lib/format"

import { cantidad, daysAgoLocal, EXPLAINED_WASTE_TYPES, todayLocal, WASTE_TYPE_LABEL } from "./lib"

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
  {
    term: "No es pérdida",
    meaning:
      "el consumo interno y el traslado a otra sede se registran acá pero no cuentan en mermas ÷ compras ni en la varianza: son salidas explicadas.",
  },
]

/**
 * Traslados que llegan a ESTA sede desde otra de la organización y nadie
 * recibió todavía. Recibir escribe la entrada en el inventario de acá al
 * mismo costo con que salió (lo hace el servidor); quien recibe elige en qué
 * insumo de esta sede entra — el servidor sugiere el de mismo nombre y unidad.
 * Sin traslados pendientes no dibuja nada.
 */
function IncomingTransfers({
  storeId,
  ingredients,
}: {
  storeId: number
  ingredients: IngredientOut[]
}): React.JSX.Element | null {
  const query = useQuery({
    queryKey: ["inventory", "incoming-transfers", storeId],
    queryFn: () => getIncomingTransfers(storeId),
  })
  if (query.isError) {
    return (
      <p role="alert" className="text-sm text-destructive">
        No se pudieron cargar los traslados por recibir: {errorMessage(query.error)}
      </p>
    )
  }
  const rows = query.data ?? []
  if (rows.length === 0) return null
  return (
    <section aria-labelledby="incoming-transfers" className="space-y-2 rounded-lg border p-3">
      <h3 id="incoming-transfers" className="font-semibold">
        Traslados por recibir ({rows.length})
      </h3>
      <ul className="space-y-3">
        {rows.map((row) => (
          <IncomingTransferRow key={row.id} storeId={storeId} row={row} ingredients={ingredients} />
        ))}
      </ul>
    </section>
  )
}

function IncomingTransferRow({
  storeId,
  row,
  ingredients,
}: {
  storeId: number
  row: IncomingTransferOut
  ingredients: IngredientOut[]
}): React.JSX.Element {
  const queryClient = useQueryClient()
  const candidates = ingredients.filter((i) => i.active && i.base_unit === row.base_unit)
  const [ingredientId, setIngredientId] = useState<number | null>(row.suggested_ingredient_id)
  const [error, setError] = useState<string | null>(null)
  const keyRef = useRef(newIdempotencyKey())
  const mutation = useMutation({
    mutationFn: () => receiveTransfer(storeId, row.id, ingredientId as number, keyRef.current),
    onSuccess: () => {
      toast.success("Traslado recibido: ya está en el inventario de esta sede.")
      keyRef.current = newIdempotencyKey()
      void queryClient.invalidateQueries({ queryKey: ["inventory"] })
    },
    onError: (err) => {
      if (!(err instanceof ApiError) || err.status !== 409) keyRef.current = newIdempotencyKey()
      setError(errorMessage(err))
    },
  })
  const selectId = `transfer-ingredient-${row.id}`
  return (
    <li className="space-y-2">
      <p className="text-sm">
        <span className="font-medium">{cantidad(row.qty, row.base_unit)}</span> de {row.ingredient_name}, desde{" "}
        {row.source_store_name}
        <span className="text-muted-foreground">
          {" "}
          · lo mandó {row.sent_by_employee_name} · {formatInstant(row.sent_at)}
        </span>
      </p>
      {row.note ? <p className="text-xs text-muted-foreground">Nota: {row.note}</p> : null}
      <div className="flex flex-wrap items-end gap-2">
        <div className="space-y-1">
          <Label htmlFor={selectId}>Entra como</Label>
          <Select
            value={ingredientId === null ? undefined : String(ingredientId)}
            onValueChange={(v) => setIngredientId(Number(v))}
          >
            <SelectTrigger id={selectId} className="h-8 w-56">
              <SelectValue placeholder="Elegí el insumo de esta sede" />
            </SelectTrigger>
            <SelectContent>
              {candidates.map((i) => (
                <SelectItem key={i.id} value={String(i.id)}>
                  {i.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <Button
          type="button"
          size="sm"
          disabled={ingredientId === null || mutation.isPending}
          onClick={() => mutation.mutate()}
        >
          Recibir traslado
        </Button>
      </div>
      {candidates.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          Esta sede no tiene un insumo activo en la misma unidad: crealo en Insumos y volvé acá.
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </li>
  )
}

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
  const { stores } = useStoreSelection()
  const storeName = new Map(stores.map((st) => [st.id, st.name]))

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
      cell: (w) =>
        EXPLAINED_WASTE_TYPES.includes(w.type) ? (
          <span>
            {WASTE_TYPE_LABEL[w.type]} <span className="text-xs text-muted-foreground">(no es pérdida)</span>
          </span>
        ) : (
          (WASTE_TYPE_LABEL[w.type] ?? w.type)
        ),
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
      // Consumo interno: quién se lo llevó. Traslado: a qué sede y si ya llegó.
      key: "detail",
      header: "Quién / destino",
      kind: "secondary",
      cell: (w) =>
        w.type === "internal_use"
          ? (w.consumer_name ?? "—")
          : w.type === "transfer_out" && w.destination_store_id !== null
            ? `${storeName.get(w.destination_store_id) ?? `Sede #${w.destination_store_id}`} · ${
                w.received_at ? `recibido por ${w.received_by_employee_name ?? "—"}` : "por recibir"
              }`
            : "—",
    },
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
      <IncomingTransfers storeId={storeId} ingredients={ingredients} />
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
