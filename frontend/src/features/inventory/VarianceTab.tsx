import { useQuery } from "@tanstack/react-query"
import { useState } from "react"

import { getVariance, listCounts, varianceCsvUrl, type VarianceLevel } from "@/api/inventory"
import { COST_SOURCE_LABEL } from "@/components/CostValue"
import { CsvExportButton } from "@/components/CsvExportButton"
import { EmptyState } from "@/components/EmptyState"
import { Badge } from "@/components/ui/badge"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { formatCOP } from "@/lib/money"
import { errorMessage } from "@/lib/errors"

import { formatBasisPoints } from "./lib"

const UNIT_LABEL: Record<string, string> = { g: "g", ml: "ml", unit: "unidad" }

const LEVEL_LABEL: Record<VarianceLevel, string> = { green: "Verde", yellow: "Revisar", red: "Rojo" }
const LEVEL_BADGE_VARIANT: Record<VarianceLevel, "secondary" | "outline" | "destructive"> = {
  green: "secondary",
  yellow: "outline",
  red: "destructive",
}

/**
 * Admin → Inventario → Varianza (SPEC-NEGOCIO §5.4 / §9.3): uso real contra
 * uso teórico, en cantidad y en pesos con el origen del costo. El semáforo
 * (`row.level`) es SIEMPRE el que manda el servidor contra los umbrales de
 * la sede — este archivo nunca compara `variance_pct_bp` contra un número
 * propio; cambiar el umbral en Configuración cambia el color acá sin tocar
 * una línea de este componente.
 */
export function VarianceTab({ storeId }: { storeId: number }): React.JSX.Element {
  const [countId, setCountId] = useState<number | null>(null)

  const countsQuery = useQuery({
    queryKey: ["inventory", "variance", "applied-counts", storeId],
    queryFn: () => listCounts({ storeId }),
  })
  const appliedCounts = (countsQuery.data ?? []).filter((c) => c.status === "applied")

  const varianceQuery = useQuery({
    queryKey: ["inventory", "variance", storeId, countId],
    queryFn: () => getVariance({ storeId, countId: countId as number }),
    enabled: countId !== null,
  })

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1">
          <Label htmlFor="variance-count">Conteo aplicado</Label>
          <Select value={countId === null ? undefined : String(countId)} onValueChange={(v) => setCountId(Number(v))}>
            <SelectTrigger id="variance-count" className="h-10 w-64">
              <SelectValue placeholder="Elegí un conteo aplicado" />
            </SelectTrigger>
            <SelectContent>
              {appliedCounts.map((count) => (
                <SelectItem key={count.id} value={String(count.id)}>
                  #{count.id} — {count.scope === "full" ? "Completo" : "Críticos"} — {count.business_date}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {appliedCounts.length === 0 && !countsQuery.isLoading ? (
            <p className="text-xs text-muted-foreground">Todavía no hay ningún conteo aplicado en esta sede.</p>
          ) : null}
        </div>
        {countId !== null ? <CsvExportButton href={varianceCsvUrl({ storeId, countId })} /> : null}
      </div>

      {countId === null ? (
        <EmptyState title="Elegí un conteo aplicado" description="La varianza compara un conteo aplicado contra el anterior aplicado." />
      ) : varianceQuery.isLoading ? (
        <p className="text-sm text-muted-foreground">Calculando varianza…</p>
      ) : varianceQuery.isError ? (
        <EmptyState
          role="alert"
          title="No se pudo calcular la varianza"
          description={errorMessage(varianceQuery.error)}
          action={{ label: "Reintentar", onClick: () => void varianceQuery.refetch() }}
        />
      ) : !varianceQuery.data?.available ? (
        <EmptyState
          title="Sin varianza para este conteo"
          description={varianceQuery.data?.reason ?? "Hace falta un conteo aplicado anterior contra el cual comparar."}
        />
      ) : varianceQuery.data.rows.length === 0 ? (
        <EmptyState title="Sin insumos en común entre los dos conteos" description="Ningún insumo se contó en ambos conteos." />
      ) : (
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Insumo</TableHead>
                <TableHead>Inicial</TableHead>
                <TableHead>Entradas</TableHead>
                <TableHead>Final</TableHead>
                <TableHead>Uso real</TableHead>
                <TableHead>Uso teórico</TableHead>
                <TableHead>Varianza (cantidad)</TableHead>
                <TableHead>Varianza (pesos)</TableHead>
                <TableHead>%</TableHead>
                <TableHead>Semáforo</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {varianceQuery.data.rows.map((row) => (
                <TableRow key={row.ingredient_id}>
                  <TableCell className="font-medium">{row.ingredient_name}</TableCell>
                  <TableCell className="tabular-nums">
                    {row.opening_qty} {UNIT_LABEL[row.base_unit] ?? row.base_unit}
                  </TableCell>
                  <TableCell className="tabular-nums">
                    {row.inflow_qty} {UNIT_LABEL[row.base_unit] ?? row.base_unit}
                  </TableCell>
                  <TableCell className="tabular-nums">
                    {row.closing_qty} {UNIT_LABEL[row.base_unit] ?? row.base_unit}
                  </TableCell>
                  <TableCell className="tabular-nums">
                    {row.real_usage_qty} {UNIT_LABEL[row.base_unit] ?? row.base_unit}
                  </TableCell>
                  <TableCell className="tabular-nums">
                    {row.theoretical_usage_qty} {UNIT_LABEL[row.base_unit] ?? row.base_unit}
                  </TableCell>
                  <TableCell className="tabular-nums">
                    {row.variance_qty} {UNIT_LABEL[row.base_unit] ?? row.base_unit}
                  </TableCell>
                  <TableCell>
                    {row.variance_value === null ? (
                      <>
                        <span className="text-muted-foreground">Sin costo</span>{" "}
                        <Badge variant="outline">origen: ninguno</Badge>
                      </>
                    ) : (
                      <>
                        <span className="tabular-nums">{formatCOP(row.variance_value)}</span>{" "}
                        <Badge variant="secondary">{COST_SOURCE_LABEL[row.cost_source]}</Badge>
                      </>
                    )}
                  </TableCell>
                  <TableCell className="tabular-nums">{formatBasisPoints(row.variance_pct_bp)}</TableCell>
                  <TableCell>
                    <Badge variant={LEVEL_BADGE_VARIANT[row.level]}>{LEVEL_LABEL[row.level]}</Badge>
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

export default VarianceTab
