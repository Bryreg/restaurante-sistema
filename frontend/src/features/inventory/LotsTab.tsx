import { useQuery } from "@tanstack/react-query"
import { AlertTriangle } from "lucide-react"
import { useState } from "react"
import { Link } from "react-router-dom"

import { getLots, type IngredientOut, type LotStatus } from "@/api/inventory"
import { CostValue } from "@/components/CostValue"
import { EmptyState } from "@/components/EmptyState"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { formatInstant } from "@/lib/businessDate"
import { errorMessage } from "@/lib/errors"
import { cn } from "@/lib/utils"

import { LOT_STATUS_LABEL } from "./lib"

const UNIT_LABEL: Record<string, string> = { g: "g", ml: "ml", unit: "unidad" }

const STATUS_BADGE_VARIANT: Record<LotStatus, "secondary" | "outline" | "destructive"> = {
  active: "secondary",
  expiring: "outline",
  expired: "destructive",
  depleted: "outline",
}

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
export function LotsTab({ storeId, ingredients }: { storeId: number; ingredients: IngredientOut[] }): React.JSX.Element {
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

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1">
          <Label htmlFor="lots-ingredient">Insumo</Label>
          <Select
            value={ingredientId === "all" ? "all" : String(ingredientId)}
            onValueChange={(v) => setIngredientId(v === "all" ? "all" : Number(v))}
          >
            <SelectTrigger id="lots-ingredient" className="h-10 w-56">
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
        <div className="space-y-1">
          <Label htmlFor="lots-status">Estado</Label>
          <Select value={status} onValueChange={(v) => setStatus(v as LotStatus | "all")}>
            <SelectTrigger id="lots-status" className="h-10 w-48">
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
        <div className="space-y-1">
          <Label htmlFor="lots-expiring-days">Días para vencer (máximo)</Label>
          <Input
            id="lots-expiring-days"
            type="number"
            min={0}
            className="h-10 w-40"
            value={expiringWithinDays}
            onChange={(event) => setExpiringWithinDays(event.target.value)}
          />
        </div>
      </div>

      {/* GAP declarado (§8 del entregable): `GET /admin/lots` no declara
          `format=csv` en el backend — no hay `CsvExportButton` acá a
          propósito, para no ofrecer una descarga que en realidad no
          funciona. */}

      {query.isLoading ? (
        <p className="text-sm text-muted-foreground">Cargando lotes…</p>
      ) : query.isError ? (
        <EmptyState
          role="alert"
          title="No se pudieron cargar los lotes"
          description={errorMessage(query.error)}
          action={{ label: "Reintentar", onClick: () => void query.refetch() }}
        />
      ) : rows.length === 0 ? (
        <EmptyState title="Sin lotes para estos filtros" description="Probá sacando algún filtro." />
      ) : (
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Insumo</TableHead>
                <TableHead>Lote</TableHead>
                <TableHead>Recibido</TableHead>
                <TableHead>Vence</TableHead>
                <TableHead>Cantidad restante</TableHead>
                <TableHead>Costo</TableHead>
                <TableHead>Estado</TableHead>
                <TableHead>Acción</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.id} className={cn(row.status === "expired" && "bg-destructive/5")}>
                  <TableCell className="font-medium">{row.ingredient_name}</TableCell>
                  <TableCell>{row.lot_code ?? "—"}</TableCell>
                  <TableCell className="whitespace-nowrap">{formatInstant(row.received_at)}</TableCell>
                  <TableCell className="whitespace-nowrap">{row.expires_at ?? "No vence"}</TableCell>
                  <TableCell className="tabular-nums">
                    {row.qty_remaining}{" "}
                    {(() => {
                      const unit = unitByIngredient.get(row.ingredient_id)
                      return unit ? (UNIT_LABEL[unit] ?? unit) : ""
                    })()}
                  </TableCell>
                  <TableCell>
                    <CostValue cost={row.unit_cost} costSource={row.cost_source} />
                  </TableCell>
                  <TableCell>
                    <Badge variant={STATUS_BADGE_VARIANT[row.status]} className="gap-1">
                      {row.status === "expired" ? <AlertTriangle className="size-3" aria-hidden="true" /> : null}
                      {LOT_STATUS_LABEL[row.status]}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    {row.status === "expired" ? (
                      <Link
                        to="/pos/merma"
                        className="text-sm font-medium text-primary underline underline-offset-2"
                      >
                        Registrar merma (vencido)
                      </Link>
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

export default LotsTab
