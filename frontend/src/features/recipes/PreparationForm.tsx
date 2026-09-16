import { useState } from "react"

import type {
  BaseUnit,
  PreparationAdminOut,
  PreparationIn,
  PreparationUpdateIn,
  PrepMode,
} from "@/api/recipes"
import { Button } from "@/components/ui/button"
import { DialogClose, DialogFooter } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"

import {
  ComponentLinesEditor,
  componentLinesToDrafts,
  draftsToComponentLines,
  emptyLine,
  type LineDraft,
  type LineIngredientOption,
  type LinePreparationOption,
} from "./ComponentLinesEditor"

export interface PreparationFormValues {
  name: string
  mode: PrepMode
  standardYieldQty: string
  standardYieldUnit: BaseUnit
  processLossPct: number
  shelfLifeDays: number | null
  lines: LineDraft[]
}

function toFormValues(preparation?: PreparationAdminOut): PreparationFormValues {
  return {
    name: preparation?.name ?? "",
    mode: preparation?.mode ?? "exploded",
    standardYieldQty: preparation?.standard_yield_qty ?? "1",
    standardYieldUnit: (preparation?.standard_yield_unit as BaseUnit) ?? "g",
    processLossPct: preparation?.process_loss_pct ?? 0,
    shelfLifeDays: preparation?.shelf_life_days ?? null,
    lines: preparation ? componentLinesToDrafts(preparation.lines) : [emptyLine()],
  }
}

export function formValuesToPreparationIn(values: PreparationFormValues): PreparationIn {
  return {
    name: values.name,
    mode: values.mode,
    standard_yield_qty: values.standardYieldQty,
    standard_yield_unit: values.standardYieldUnit,
    process_loss_pct: values.processLossPct,
    shelf_life_days: values.shelfLifeDays,
    lines: draftsToComponentLines(values.lines),
  }
}

export function formValuesToPreparationUpdateIn(values: PreparationFormValues): PreparationUpdateIn {
  return {
    name: values.name,
    standard_yield_qty: values.standardYieldQty,
    standard_yield_unit: values.standardYieldUnit,
    process_loss_pct: values.processLossPct,
    shelf_life_days: values.shelfLifeDays,
    lines: draftsToComponentLines(values.lines),
  }
}

/**
 * Alta y edición de una preparación (spec §4.2 / §9.3). El modo NO se edita
 * acá: sólo se elige al crear — cambiarlo después es una acción aparte de
 * administrador con PIN (`PrepModeSwitchDialog`), porque salir de `batch`
 * cierra lotes abiertos y eso necesita su propia confirmación explícita.
 */
export function PreparationForm({
  preparation,
  ingredients,
  preparations,
  onSubmit,
  submitting,
  submitLabel,
}: {
  preparation?: PreparationAdminOut
  ingredients: LineIngredientOption[]
  preparations: LinePreparationOption[]
  onSubmit: (values: PreparationFormValues) => void
  submitting: boolean
  submitLabel: string
}): React.JSX.Element {
  const [values, setValues] = useState<PreparationFormValues>(() => toFormValues(preparation))
  const isEdit = preparation !== undefined
  const hasCompleteLine = values.lines.some(
    (line) => (line.ingredientId !== null || line.preparationId !== null) && line.qty.trim() !== ""
  )

  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault()
        onSubmit(values)
      }}
    >
      <div className="space-y-1">
        <Label htmlFor="prep-name">Nombre</Label>
        <Input
          id="prep-name"
          required
          value={values.name}
          onChange={(event) => setValues((v) => ({ ...v, name: event.target.value }))}
        />
      </div>

      {isEdit ? (
        <p className="text-sm text-muted-foreground">
          Modo actual: <strong>{preparation.mode === "batch" ? "Por lote" : "Explotada"}</strong>. Para cambiarlo
          usá «Cambiar modo» en la lista — necesita PIN de administrador.
        </p>
      ) : (
        <div className="space-y-1">
          <Label htmlFor="prep-mode">Modo</Label>
          <Select value={values.mode} onValueChange={(value) => setValues((v) => ({ ...v, mode: value as PrepMode }))}>
            <SelectTrigger id="prep-mode" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="exploded">Explotada (default): sin stock, descuenta al enviar el plato</SelectItem>
              <SelectItem value="batch">Por lote: hay que producirla, crea stock con vencimiento</SelectItem>
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            Explotada es el default: si nadie registra la producción de una preparación en modo lote, la preparación
            queda en stock negativo y sus insumos se ven sobrevalorados. Usá «por lote» sólo para las caras,
            perecederas o vendidas por porción.
          </p>
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div className="space-y-1">
          <Label htmlFor="prep-yield-qty">Rendimiento estándar</Label>
          <Input
            id="prep-yield-qty"
            inputMode="decimal"
            required
            value={values.standardYieldQty}
            onChange={(event) => setValues((v) => ({ ...v, standardYieldQty: event.target.value }))}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="prep-yield-unit">Unidad</Label>
          <Select
            value={values.standardYieldUnit}
            onValueChange={(value) => setValues((v) => ({ ...v, standardYieldUnit: value as BaseUnit }))}
          >
            <SelectTrigger id="prep-yield-unit" className="w-full">
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
          <Label htmlFor="prep-loss">Merma de proceso (%)</Label>
          <Input
            id="prep-loss"
            type="number"
            min={0}
            max={100}
            value={values.processLossPct}
            onChange={(event) => setValues((v) => ({ ...v, processLossPct: Number(event.target.value) }))}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="prep-shelf-life">Vida útil (días)</Label>
          <Input
            id="prep-shelf-life"
            type="number"
            min={0}
            placeholder="Sin vencer"
            value={values.shelfLifeDays ?? ""}
            onChange={(event) =>
              setValues((v) => ({
                ...v,
                shelfLifeDays: event.target.value === "" ? null : Number(event.target.value),
              }))
            }
          />
        </div>
      </div>

      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">Receta propia (insumos y/u otras preparaciones)</legend>
        <ComponentLinesEditor
          idPrefix="prep"
          lines={values.lines}
          onChange={(lines) => setValues((v) => ({ ...v, lines }))}
          ingredients={ingredients}
          preparations={preparations}
          excludePreparationId={preparation?.id}
        />
      </fieldset>

      <DialogFooter>
        <DialogClose render={<Button type="button" variant="outline" />}>Cancelar</DialogClose>
        <Button type="submit" disabled={submitting || values.name.trim() === "" || !hasCompleteLine}>
          {submitLabel}
        </Button>
      </DialogFooter>
    </form>
  )
}
