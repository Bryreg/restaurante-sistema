/**
 * Captura de líneas de una recepción (SPEC-NEGOCIO §5.6 / `spec.md §
 * Receptions`): insumo, cantidad recibida y facturada, precio unitario de
 * compra, base/tarifa/valor de IVA, lote y vencimiento. Cada línea es un
 * borrador de texto — las cantidades y el precio NUNCA se parsean a número
 * acá ("el frontend no deriva cantidades ni costos", AGENTS.md): viajan tal
 * cual el usuario las tecleó hasta `ReceptionLineIn`, y es el backend quien
 * decide si son válidas, si el precio dispara una guarda, y cuál es el
 * costo final con IVA. Mismo patrón de `key` estable que
 * `src/features/recipes/ComponentLinesEditor.tsx` (territorio ajeno, no se
 * importa — se replica el patrón, no el archivo).
 */

import { Trash2 } from "lucide-react"
import { useId } from "react"

import type { IngredientOut } from "@/api/inventory"
import type { ReceptionLineIn } from "@/api/purchases"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { MoneyInput } from "@/components/MoneyInput"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"

export interface ReceptionLineDraft {
  key: string
  ingredientId: number | null
  qtyReceived: string
  qtyInvoiced: string
  purchaseUnitPrice: string
  taxBase: number | null
  taxRate: string
  taxAmount: number | null
  lotCode: string
  expiresAt: string
}

let nextKey = 0
export function emptyReceptionLine(): ReceptionLineDraft {
  nextKey += 1
  return {
    key: `line-${nextKey}`,
    ingredientId: null,
    qtyReceived: "",
    qtyInvoiced: "",
    purchaseUnitPrice: "",
    taxBase: 0,
    taxRate: "0",
    taxAmount: 0,
    lotCode: "",
    expiresAt: "",
  }
}

export function isReceptionLineComplete(line: ReceptionLineDraft): boolean {
  return (
    line.ingredientId !== null &&
    line.qtyReceived.trim() !== "" &&
    line.qtyInvoiced.trim() !== "" &&
    line.purchaseUnitPrice.trim() !== "" &&
    line.taxBase !== null &&
    line.taxRate.trim() !== "" &&
    line.taxAmount !== null
  )
}

export function draftsToReceptionLines(lines: ReceptionLineDraft[]): ReceptionLineIn[] {
  return lines.filter(isReceptionLineComplete).map((line) => ({
    ingredient_id: line.ingredientId as number,
    qty_received: line.qtyReceived.trim(),
    qty_invoiced: line.qtyInvoiced.trim(),
    purchase_unit_price: line.purchaseUnitPrice.trim(),
    tax_base: line.taxBase as number,
    tax_rate: Number(line.taxRate),
    tax_amount: line.taxAmount as number,
    lot_code: line.lotCode.trim() === "" ? null : line.lotCode.trim(),
    expires_at: line.expiresAt.trim() === "" ? null : line.expiresAt.trim(),
  }))
}

const UNIT_LABEL: Record<string, string> = { g: "g", ml: "ml", unit: "unidad" }

export interface ReceptionLinesEditorProps {
  lines: ReceptionLineDraft[]
  onChange: (lines: ReceptionLineDraft[]) => void
  ingredients: IngredientOut[]
  disabled?: boolean
  /** Índice (0-based) de la línea que el servidor señaló en una guarda de
   * tecleo (`lines[N]` del mensaje de `409`), para resaltarla — sólo
   * estética, nunca decide nada de negocio. */
  highlightIndex?: number | null
}

export function ReceptionLinesEditor({
  lines,
  onChange,
  ingredients,
  disabled = false,
  highlightIndex = null,
}: ReceptionLinesEditorProps): React.JSX.Element {
  const baseId = useId()

  function updateLine(key: string, patch: Partial<ReceptionLineDraft>) {
    onChange(lines.map((line) => (line.key === key ? { ...line, ...patch } : line)))
  }

  function removeLine(key: string) {
    onChange(lines.filter((line) => line.key !== key))
  }

  return (
    <div className="space-y-3" data-testid="reception-lines">
      {lines.length === 0 ? (
        <p className="text-sm text-muted-foreground">Todavía no hay líneas. Agregá al menos una para confirmar la recepción.</p>
      ) : null}
      {lines.map((line, index) => {
        const rowId = `${baseId}-line-${index}`
        const ingredient = ingredients.find((i) => i.id === line.ingredientId)
        const unitLabel = ingredient ? (UNIT_LABEL[ingredient.base_unit] ?? ingredient.base_unit) : ""
        return (
          <div
            key={line.key}
            data-testid={`reception-line-${index}`}
            className={`space-y-3 rounded-md border p-3 ${highlightIndex === index ? "border-destructive ring-1 ring-destructive" : ""}`}
          >
            <div className="flex items-center justify-between gap-2">
              <p className="text-sm font-medium">Línea {index + 1}</p>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={`Quitar línea ${index + 1}`}
                disabled={disabled}
                onClick={() => removeLine(line.key)}
              >
                <Trash2 className="size-4" aria-hidden="true" />
              </Button>
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <div className="space-y-1 sm:col-span-1">
                <Label htmlFor={`${rowId}-ingredient`}>Insumo</Label>
                <Select
                  value={line.ingredientId !== null ? String(line.ingredientId) : undefined}
                  onValueChange={(value) => updateLine(line.key, { ingredientId: Number(value) })}
                  disabled={disabled}
                >
                  <SelectTrigger id={`${rowId}-ingredient`} className="w-full">
                    <SelectValue placeholder="Elegí un insumo" />
                  </SelectTrigger>
                  <SelectContent>
                    {ingredients.map((ing) => (
                      <SelectItem key={ing.id} value={String(ing.id)}>
                        {ing.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label htmlFor={`${rowId}-qty-received`}>Cantidad recibida {unitLabel ? `(${unitLabel})` : ""}</Label>
                <Input
                  id={`${rowId}-qty-received`}
                  inputMode="decimal"
                  value={line.qtyReceived}
                  onChange={(event) => updateLine(line.key, { qtyReceived: event.target.value })}
                  disabled={disabled}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor={`${rowId}-qty-invoiced`}>Cantidad facturada {unitLabel ? `(${unitLabel})` : ""}</Label>
                <Input
                  id={`${rowId}-qty-invoiced`}
                  inputMode="decimal"
                  value={line.qtyInvoiced}
                  onChange={(event) => updateLine(line.key, { qtyInvoiced: event.target.value })}
                  disabled={disabled}
                />
                <p className="text-xs text-muted-foreground">Distinta de la recibida si vino de menos o de más.</p>
              </div>
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
              <div className="space-y-1">
                <Label htmlFor={`${rowId}-price`}>Precio por unidad de compra</Label>
                <Input
                  id={`${rowId}-price`}
                  inputMode="decimal"
                  placeholder="0"
                  value={line.purchaseUnitPrice}
                  onChange={(event) => updateLine(line.key, { purchaseUnitPrice: event.target.value })}
                  disabled={disabled}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor={`${rowId}-tax-base`}>Base gravable</Label>
                <MoneyInput
                  id={`${rowId}-tax-base`}
                  value={line.taxBase}
                  onChange={(value) => updateLine(line.key, { taxBase: value })}
                  disabled={disabled}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor={`${rowId}-tax-rate`}>Tarifa IVA/INC (%)</Label>
                <Input
                  id={`${rowId}-tax-rate`}
                  type="number"
                  min={0}
                  max={100}
                  value={line.taxRate}
                  onChange={(event) => updateLine(line.key, { taxRate: event.target.value })}
                  disabled={disabled}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor={`${rowId}-tax-amount`}>Valor del impuesto</Label>
                <MoneyInput
                  id={`${rowId}-tax-amount`}
                  value={line.taxAmount}
                  onChange={(value) => updateLine(line.key, { taxAmount: value })}
                  disabled={disabled}
                />
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              Los tres campos de impuesto se guardan tal como los trae la factura física; el servidor decide si suman
              al costo (bajo INC) o quedan aparte como descontable (bajo IVA) — esta pantalla no lo calcula.
            </p>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor={`${rowId}-lot`}>Lote (opcional)</Label>
                <Input
                  id={`${rowId}-lot`}
                  value={line.lotCode}
                  onChange={(event) => updateLine(line.key, { lotCode: event.target.value })}
                  disabled={disabled}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor={`${rowId}-expires`}>Vence (opcional)</Label>
                <Input
                  id={`${rowId}-expires`}
                  type="date"
                  value={line.expiresAt}
                  onChange={(event) => updateLine(line.key, { expiresAt: event.target.value })}
                  disabled={disabled}
                />
              </div>
            </div>
          </div>
        )
      })}
      <Button type="button" variant="outline" size="sm" disabled={disabled} onClick={() => onChange([...lines, emptyReceptionLine()])}>
        Agregar línea
      </Button>
    </div>
  )
}

export default ReceptionLinesEditor
