import { useState } from "react"

import type { BaseUnit, IngredientIn, IngredientOut, IngredientUpdateIn } from "@/api/inventory"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { DialogClose, DialogFooter } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"

export interface IngredientFormValues {
  name: string
  category: string
  baseUnit: BaseUnit
  purchaseUnit: string
  purchaseFactor: string
  yieldPct: string
  officialCost: string
  estimatedCost: string
  minStock: string
  leadTimeDays: string
  perishable: boolean
  keyItem: boolean
  consumptionUntracked: boolean
  substituteIngredientId: number | null
  active: boolean
}

function toFormValues(ingredient?: IngredientOut): IngredientFormValues {
  return {
    name: ingredient?.name ?? "",
    category: ingredient?.category ?? "",
    baseUnit: ingredient?.base_unit ?? "g",
    purchaseUnit: ingredient?.purchase_unit ?? "",
    purchaseFactor: ingredient ? String(ingredient.purchase_factor) : "1",
    yieldPct: ingredient ? String(ingredient.yield_pct) : "100",
    officialCost: ingredient?.official_cost ?? "",
    estimatedCost: ingredient?.estimated_cost ?? "",
    minStock: ingredient?.min_stock ?? "",
    leadTimeDays: ingredient?.lead_time_days !== null && ingredient?.lead_time_days !== undefined ? String(ingredient.lead_time_days) : "",
    perishable: ingredient?.perishable ?? false,
    keyItem: ingredient?.key_item ?? false,
    consumptionUntracked: ingredient?.consumption_untracked ?? false,
    substituteIngredientId: ingredient?.substitute_ingredient_id ?? null,
    active: ingredient?.active ?? true,
  }
}

/** `min_stock` obligatorio y `> 0` (SPEC-NEGOCIO §4.1; en la referencia 55 de
 * 56 productos quedaron con el motor de alertas apagado). Validado acá
 * ADEMÁS del `400 MIN_STOCK_REQUIRED` del servidor — nunca en vez de él. */
export function minStockValid(raw: string): boolean {
  const trimmed = raw.trim()
  if (trimmed === "") return false
  const value = Number(trimmed)
  return !Number.isNaN(value) && value > 0
}

export function formValuesToIngredientIn(values: IngredientFormValues): IngredientIn {
  return {
    name: values.name.trim(),
    category: values.category.trim() === "" ? null : values.category.trim(),
    base_unit: values.baseUnit,
    purchase_unit: values.purchaseUnit.trim(),
    purchase_factor: Number(values.purchaseFactor),
    yield_pct: Number(values.yieldPct),
    official_cost: values.officialCost.trim() === "" ? null : values.officialCost.trim(),
    estimated_cost: values.estimatedCost.trim() === "" ? null : values.estimatedCost.trim(),
    min_stock: values.minStock.trim(),
    lead_time_days: values.leadTimeDays.trim() === "" ? null : Number(values.leadTimeDays),
    perishable: values.perishable,
    key_item: values.keyItem,
    consumption_untracked: values.consumptionUntracked,
    substitute_ingredient_id: values.substituteIngredientId,
    active: values.active,
  }
}

export function formValuesToIngredientUpdateIn(values: IngredientFormValues): IngredientUpdateIn {
  return {
    name: values.name.trim(),
    category: values.category.trim() === "" ? null : values.category.trim(),
    base_unit: values.baseUnit,
    purchase_unit: values.purchaseUnit.trim(),
    purchase_factor: Number(values.purchaseFactor),
    yield_pct: Number(values.yieldPct),
    official_cost: values.officialCost.trim() === "" ? null : values.officialCost.trim(),
    clear_official_cost: values.officialCost.trim() === "",
    estimated_cost: values.estimatedCost.trim() === "" ? null : values.estimatedCost.trim(),
    clear_estimated_cost: values.estimatedCost.trim() === "",
    min_stock: values.minStock.trim(),
    lead_time_days: values.leadTimeDays.trim() === "" ? null : Number(values.leadTimeDays),
    perishable: values.perishable,
    key_item: values.keyItem,
    consumption_untracked: values.consumptionUntracked,
    substitute_ingredient_id: values.substituteIngredientId,
    clear_substitute: values.substituteIngredientId === null,
    active: values.active,
  }
}

/**
 * Alta y edición de un insumo (SPEC-NEGOCIO §4.1 / §9.3). `min_stock` nunca
 * queda en cero mudo: el campo es obligatorio y se valida antes de habilitar
 * el submit, y el error del servidor (`400 MIN_STOCK_REQUIRED`) se muestra
 * tal cual si igual llega. El sustituto usa un solo camino de consumo con
 * cascada (venta, cortesía, `staff_meal` y producción reproducen el mismo
 * camino en el backend — acá sólo se elige, no se calcula nada).
 */
export function IngredientForm({
  ingredient,
  otherIngredients,
  onSubmit,
  submitting,
  submitLabel,
  serverError,
}: {
  ingredient?: IngredientOut
  otherIngredients: { id: number; name: string }[]
  onSubmit: (values: IngredientFormValues) => void
  submitting: boolean
  submitLabel: string
  serverError?: string | null
}): React.JSX.Element {
  const [values, setValues] = useState<IngredientFormValues>(() => toFormValues(ingredient))
  const minStockOk = minStockValid(values.minStock)
  const canSubmit =
    values.name.trim() !== "" &&
    values.purchaseUnit.trim() !== "" &&
    Number(values.purchaseFactor) > 0 &&
    minStockOk

  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault()
        if (!canSubmit) return
        onSubmit(values)
      }}
    >
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <Label htmlFor="ing-name">Nombre</Label>
          <Input
            id="ing-name"
            required
            value={values.name}
            onChange={(event) => setValues((v) => ({ ...v, name: event.target.value }))}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="ing-category">Categoría</Label>
          <Input
            id="ing-category"
            value={values.category}
            onChange={(event) => setValues((v) => ({ ...v, category: event.target.value }))}
          />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div className="space-y-1">
          <Label htmlFor="ing-base-unit">Unidad de uso</Label>
          <Select value={values.baseUnit} onValueChange={(value) => setValues((v) => ({ ...v, baseUnit: value as BaseUnit }))}>
            <SelectTrigger id="ing-base-unit" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="g">g</SelectItem>
              <SelectItem value="ml">ml</SelectItem>
              <SelectItem value="unit">unidad</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="ing-purchase-unit">Unidad de compra</Label>
          <Input
            id="ing-purchase-unit"
            required
            placeholder="bulto, caneca…"
            value={values.purchaseUnit}
            onChange={(event) => setValues((v) => ({ ...v, purchaseUnit: event.target.value }))}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="ing-purchase-factor">Factor de compra</Label>
          <Input
            id="ing-purchase-factor"
            type="number"
            min={1}
            required
            value={values.purchaseFactor}
            onChange={(event) => setValues((v) => ({ ...v, purchaseFactor: event.target.value }))}
          />
          <p className="text-xs text-muted-foreground">Cuántas unidades de uso trae una unidad de compra.</p>
        </div>
        <div className="space-y-1">
          <Label htmlFor="ing-yield">Rendimiento (%)</Label>
          <Input
            id="ing-yield"
            type="number"
            min={1}
            max={100}
            value={values.yieldPct}
            onChange={(event) => setValues((v) => ({ ...v, yieldPct: event.target.value }))}
          />
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        La pechuga con hueso rinde 85 % limpia: la ficha técnica expresa la cantidad LIMPIA y el consumo teórico
        descuenta cantidad ÷ rendimiento. Con 100 % (el default) el consumo es igual a la cantidad de la receta.
      </p>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div className="space-y-1">
          <Label htmlFor="ing-official-cost">Costo oficial (opcional)</Label>
          <Input
            id="ing-official-cost"
            inputMode="decimal"
            placeholder="Lo fija el dueño"
            value={values.officialCost}
            onChange={(event) => setValues((v) => ({ ...v, officialCost: event.target.value }))}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="ing-estimated-cost">Costo estimado (opcional)</Label>
          <Input
            id="ing-estimated-cost"
            inputMode="decimal"
            placeholder="Si no hay oficial"
            value={values.estimatedCost}
            onChange={(event) => setValues((v) => ({ ...v, estimatedCost: event.target.value }))}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="ing-lead-time">Lead time proveedor (días, opcional)</Label>
          <Input
            id="ing-lead-time"
            type="number"
            min={0}
            value={values.leadTimeDays}
            onChange={(event) => setValues((v) => ({ ...v, leadTimeDays: event.target.value }))}
          />
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        El oficial manda sobre el estimado; sin ninguno de los dos el costo queda «sin costo» con su origen visible
        — nunca en $0.
      </p>

      <div className="space-y-1">
        <Label htmlFor="ing-min-stock">Umbral de stock mínimo</Label>
        <Input
          id="ing-min-stock"
          inputMode="decimal"
          required
          aria-invalid={values.minStock.trim() !== "" && !minStockOk}
          aria-describedby="ing-min-stock-hint"
          value={values.minStock}
          onChange={(event) => setValues((v) => ({ ...v, minStock: event.target.value }))}
        />
        <p
          id="ing-min-stock-hint"
          className={values.minStock.trim() !== "" && !minStockOk ? "text-xs text-destructive" : "text-xs text-muted-foreground"}
        >
          {values.minStock.trim() !== "" && !minStockOk
            ? "Tiene que ser mayor que cero — sin esto el motor de alertas de este insumo queda apagado."
            : `Obligatorio y mayor que cero, en ${values.baseUnit}. Dispara la alerta de "bajo mínimo".`}
        </p>
      </div>

      {otherIngredients.length > 0 ? (
        <div className="space-y-1">
          <Label htmlFor="ing-substitute">Sustituto (opcional)</Label>
          <Select
            value={values.substituteIngredientId === null ? "none" : String(values.substituteIngredientId)}
            onValueChange={(value) => setValues((v) => ({ ...v, substituteIngredientId: value === "none" ? null : Number(value) }))}
          >
            <SelectTrigger id="ing-substitute" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">Sin sustituto</SelectItem>
              {otherIngredients.map((option) => (
                <SelectItem key={option.id} value={String(option.id)}>
                  {option.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            Un solo camino de consumo con cascada: venta, cortesía, consumo de personal y producción lo usan igual.
          </p>
        </div>
      ) : null}

      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <Checkbox
            id="ing-perishable"
            checked={values.perishable}
            onCheckedChange={(checked) => setValues((v) => ({ ...v, perishable: checked === true }))}
          />
          <Label htmlFor="ing-perishable">Perecedero</Label>
        </div>
        <div className="flex items-center gap-2">
          <Checkbox
            id="ing-key-item"
            checked={values.keyItem}
            onCheckedChange={(checked) => setValues((v) => ({ ...v, keyItem: checked === true }))}
          />
          <Label htmlFor="ing-key-item">Crítico (entra al conteo rápido)</Label>
        </div>
        <div className="flex items-start gap-2">
          <Checkbox
            id="ing-untracked"
            className="mt-0.5"
            checked={values.consumptionUntracked}
            onCheckedChange={(checked) => setValues((v) => ({ ...v, consumptionUntracked: checked === true }))}
          />
          <div>
            <Label htmlFor="ing-untracked">Consumo no predecible</Label>
            <p className="text-xs text-muted-foreground">
              Servilletas, sal de mesa, aceite de fritura, aseo: sin receta propia, se mide entre dos conteos.
            </p>
          </div>
        </div>
        {ingredient ? (
          <div className="flex items-center gap-2">
            <Checkbox
              id="ing-active"
              checked={values.active}
              onCheckedChange={(checked) => setValues((v) => ({ ...v, active: checked === true }))}
            />
            <Label htmlFor="ing-active">Activo</Label>
          </div>
        ) : null}
      </div>

      {serverError ? (
        <p role="alert" className="text-sm font-medium text-destructive">
          {serverError}
        </p>
      ) : null}

      <DialogFooter>
        <DialogClose render={<Button type="button" variant="outline" />}>Cancelar</DialogClose>
        <Button type="submit" disabled={submitting || !canSubmit}>
          {submitLabel}
        </Button>
      </DialogFooter>
    </form>
  )
}

export default IngredientForm
