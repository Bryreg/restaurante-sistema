import { useQuery } from "@tanstack/react-query"
import { AlertTriangle, TrendingDown } from "lucide-react"
import { useState } from "react"

import { getInventoryStock, inventoryStockCsvUrl, type StockRowOut } from "@/api/inventory"
import { CostValue } from "@/components/CostValue"
import { CsvExportButton } from "@/components/CsvExportButton"
import { EmptyState } from "@/components/EmptyState"
import { Badge } from "@/components/ui/badge"
import { Checkbox } from "@/components/ui/checkbox"
import { Label } from "@/components/ui/label"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { errorMessage } from "@/lib/errors"
import { formatInstant } from "@/lib/businessDate"
import { cn } from "@/lib/utils"

const UNIT_LABEL: Record<string, string> = { g: "g", ml: "ml", unit: "unidad" }

/**
 * "Negativo" y "bajo mínimo" son DOS alertas distintas, nunca la misma
 * (SPEC-NEGOCIO §5.2: "negativo no es agotado" — en la referencia un helado
 * estuvo tres meses en −400 g sin que nadie lo viera porque las dos cosas se
 * confundieron). Se distinguen por variante de `Badge`, ícono y texto —
 * nunca por un color suelto: no hay token `--warning` en este proyecto
 * todavía (gap declarado desde 1a, `docs/ESTADO.md`), así que "negativo" usa
 * el único tono fuerte que sí existe (`destructive`, rojo) y "bajo mínimo"
 * queda en `outline` (neutro) con su propio ícono y texto — el mismo patrón
 * de `StatTile`/`AttentionCard`, donde "warning" nunca es un color propio,
 * sino texto + ícono sobre un contenedor neutro. Una fila puede llevar las
 * dos si aplica (`negative` implica `below_min` porque `min_stock` siempre
 * es `> 0`), así que el badge de "bajo mínimo" no se repite cuando ya está
 * el de "negativo" — mostrar los dos sería ruido, no una alerta nueva.
 */
function StatusBadges({ row }: { row: StockRowOut }): React.JSX.Element {
  if (row.negative) {
    return (
      <div className="flex flex-col gap-1">
        <Badge variant="destructive" className="w-fit gap-1">
          <AlertTriangle className="size-3" aria-hidden="true" />
          Negativo
        </Badge>
        <span className="text-xs text-muted-foreground">
          Deuda de registro{row.negative_since ? ` desde ${formatInstant(row.negative_since)}` : ""} — no bloquea la
          venta.
        </span>
      </div>
    )
  }
  if (row.below_min) {
    return (
      <div className="flex flex-col gap-1">
        <Badge variant="outline" className="w-fit gap-1">
          <TrendingDown className="size-3" aria-hidden="true" />
          Bajo mínimo
        </Badge>
        <span className="text-xs text-muted-foreground">Por debajo del umbral configurado — reponé pronto.</span>
      </div>
    )
  }
  return <Badge variant="secondary">Al día</Badge>
}

/**
 * Admin → Inventario → Stock (SPEC-NEGOCIO §5.2 / §9.3): saldo teórico por
 * insumo, filtros por críticos/bajo mínimo/negativos — la MISMA combinación
 * AND que aplica el servidor (`backend/app/inventory/service.py
 * stock_rows`), nunca una intersección calculada acá. El costo siempre con
 * su origen; ningún saldo se deriva en el cliente.
 */
export function StockTab({
  storeId,
  initialCriticalOnly = false,
  initialBelowMin = false,
  initialNegative = false,
}: {
  storeId: number
  initialCriticalOnly?: boolean
  initialBelowMin?: boolean
  initialNegative?: boolean
}): React.JSX.Element {
  const [criticalOnly, setCriticalOnly] = useState(initialCriticalOnly)
  const [belowMin, setBelowMin] = useState(initialBelowMin)
  const [negative, setNegative] = useState(initialNegative)

  const query = useQuery({
    queryKey: ["inventory", "stock", storeId, criticalOnly, belowMin, negative],
    queryFn: () => getInventoryStock({ storeId, criticalOnly, belowMin, negative }),
  })

  const rows = query.data ?? []

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-4">
          <div className="flex items-center gap-2">
            <Checkbox id="stock-critical" checked={criticalOnly} onCheckedChange={(v) => setCriticalOnly(v === true)} />
            <Label htmlFor="stock-critical">Sólo críticos</Label>
          </div>
          <div className="flex items-center gap-2">
            <Checkbox id="stock-below-min" checked={belowMin} onCheckedChange={(v) => setBelowMin(v === true)} />
            <Label htmlFor="stock-below-min">Bajo mínimo</Label>
          </div>
          <div className="flex items-center gap-2">
            <Checkbox id="stock-negative" checked={negative} onCheckedChange={(v) => setNegative(v === true)} />
            <Label htmlFor="stock-negative">Negativos</Label>
          </div>
        </div>
        <CsvExportButton href={inventoryStockCsvUrl({ storeId, criticalOnly, belowMin, negative })} />
      </div>

      {query.isLoading ? (
        <p className="text-sm text-muted-foreground">Cargando stock…</p>
      ) : query.isError ? (
        <EmptyState
          role="alert"
          title="No se pudo cargar el stock"
          description={errorMessage(query.error)}
          action={{ label: "Reintentar", onClick: () => void query.refetch() }}
        />
      ) : rows.length === 0 ? (
        <EmptyState title="Sin insumos para estos filtros" description="Probá sacando algún filtro." />
      ) : (
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Insumo</TableHead>
                <TableHead>Stock teórico</TableHead>
                <TableHead>Mínimo</TableHead>
                <TableHead>Estado</TableHead>
                <TableHead>Costo</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.ingredient_id} className={cn(row.negative && "bg-destructive/5")}>
                  <TableCell className="font-medium">
                    {row.name}
                    {row.key_item ? (
                      <Badge variant="secondary" className="ml-2">
                        Crítico
                      </Badge>
                    ) : null}
                  </TableCell>
                  <TableCell className="tabular-nums">
                    {row.qty_base} {UNIT_LABEL[row.base_unit] ?? row.base_unit}
                  </TableCell>
                  <TableCell className="tabular-nums">
                    {row.min_stock} {UNIT_LABEL[row.base_unit] ?? row.base_unit}
                  </TableCell>
                  <TableCell>
                    <StatusBadges row={row} />
                  </TableCell>
                  <TableCell>
                    <CostValue cost={row.cost} costSource={row.cost_source} />
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

export default StockTab
