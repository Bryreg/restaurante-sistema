import { useQuery } from "@tanstack/react-query"
import { useState } from "react"

import { listIngredients } from "@/api/inventory"
import { getIngredientSupplierPrices, type SupplierPriceRowOut } from "@/api/purchases"
import { EmptyState } from "@/components/EmptyState"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { errorMessage } from "@/lib/errors"
import { formatCantidad, formatFechaCorta } from "@/lib/format"
import { formatCOPDecimal } from "@/lib/money"

import { formatDeriva } from "./reliability"

/** El historial de un proveedor: sus últimas compras, la más nueva arriba. */
function HistorialProveedor({ row, purchaseUnit }: { row: SupplierPriceRowOut; purchaseUnit: string }): React.JSX.Element {
  return (
    <section className="rounded-md border" aria-label={`Compras a ${row.supplier_name}`}>
      <header className="flex items-baseline justify-between gap-3 border-b px-3 py-2">
        <h3 className="text-sm font-semibold">
          {row.supplier_name}
          {row.supplier_active ? null : <span className="ml-2 text-xs font-normal text-muted-foreground">inactivo</span>}
        </h3>
      </header>
      <table className="w-full text-sm">
        <thead className="text-xs text-muted-foreground">
          <tr>
            <th className="px-3 py-1.5 text-left font-medium">Fecha</th>
            <th className="px-3 py-1.5 text-right font-medium">Precio por {purchaseUnit}</th>
            <th className="px-3 py-1.5 text-right font-medium">Cantidad</th>
            <th className="px-3 py-1.5 text-right font-medium">Cambio</th>
          </tr>
        </thead>
        <tbody>
          {row.purchases.map((p) => (
            <tr key={p.reception_id} className="border-t">
              <td className="px-3 py-1.5">{formatFechaCorta(p.business_date)}</td>
              <td className="px-3 py-1.5 text-right tabular-nums">{formatCOPDecimal(p.purchase_unit_price)}</td>
              <td className="px-3 py-1.5 text-right tabular-nums">{formatCantidad(p.qty_received, "")}</td>
              <td
                className="px-3 py-1.5 text-right tabular-nums"
                title={p.change_bp === null ? "Primera compra a este proveedor: no hay contra qué comparar" : undefined}
              >
                {formatDeriva(p.change_bp)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  )
}

/**
 * Compras › Precios (tanda 5, i1): las últimas compras de un insumo por
 * proveedor, con el cambio contra la compra anterior al mismo proveedor. El
 * cambio, el umbral del aviso y todo lo demás llegan del servidor; acá sólo
 * se escriben.
 */
export function SupplierPricesTab({ storeId }: { storeId: number }): React.JSX.Element {
  const [ingredientId, setIngredientId] = useState<number | null>(null)
  const ingredientsQuery = useQuery({
    queryKey: ["inventory", "ingredients", storeId, false],
    queryFn: () => listIngredients(storeId, { activeOnly: true }),
  })
  const pricesQuery = useQuery({
    queryKey: ["purchases", "supplier-prices", storeId, ingredientId],
    queryFn: () => getIngredientSupplierPrices(storeId, ingredientId as number),
    enabled: ingredientId !== null,
  })
  const ingredients = ingredientsQuery.data ?? []
  const data = pricesQuery.data

  return (
    <div className="space-y-4">
      <div className="max-w-sm space-y-1">
        <Label htmlFor="precios-insumo">Insumo</Label>
        <Select
          value={ingredientId === null ? "" : String(ingredientId)}
          onValueChange={(value) => setIngredientId(value ? Number(value) : null)}
        >
          <SelectTrigger id="precios-insumo" aria-label="Insumo" className="h-9">
            <SelectValue placeholder="Elegí un insumo" />
          </SelectTrigger>
          <SelectContent>
            {ingredients.map((i) => (
              <SelectItem key={i.id} value={String(i.id)}>
                {i.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {ingredientId === null ? (
        <p className="text-sm text-muted-foreground">Elegí un insumo para ver a cuánto se lo ha comprado cada proveedor.</p>
      ) : pricesQuery.isLoading ? (
        <p className="text-sm text-muted-foreground">Buscando las compras…</p>
      ) : pricesQuery.isError || !data ? (
        <EmptyState reason="error" title="No se pudieron leer los precios" description={errorMessage(pricesQuery.error)} />
      ) : data.suppliers.length === 0 ? (
        <EmptyState
          reason="dependency"
          title="Todavía no hay compras de este insumo"
          description="El historial sale de las recepciones confirmadas: cuando entre la primera, aparece acá."
        />
      ) : (
        <>
          <p className="text-xs text-muted-foreground">
            Avisa cuando un proveedor sube el precio más de {data.alert_threshold_pct} % contra la compra anterior (el umbral se
            cambia en Notificaciones › Reglas).
          </p>
          <div className="grid gap-3 lg:grid-cols-2">
            {data.suppliers.map((row) => (
              <HistorialProveedor key={row.supplier_id} row={row} purchaseUnit={data.purchase_unit} />
            ))}
          </div>
        </>
      )}
    </div>
  )
}

export default SupplierPricesTab
