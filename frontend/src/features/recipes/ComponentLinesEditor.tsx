/**
 * Editor de líneas insumo/preparación compartido por la ficha técnica de un
 * plato y la receta propia de una preparación (spec §4.2/§4.3: "insumos y/u
 * otras preparaciones, cantidad y unidad por línea"). Cada línea es
 * exactamente un insumo O una preparación — nunca los dos, nunca ninguno —
 * tal como exige `ComponentLineIn` en el borde.
 *
 * Las cantidades viajan siempre como texto (nunca se parsean a número acá:
 * "el frontend no deriva cantidades", AGENTS.md); la única ayuda que este
 * componente se permite es acotar el selector de unidad a las compatibles
 * con la unidad base del componente elegido, para evitar un
 * `400 UNIT_MISMATCH` evitable — nunca calcula el costo ni convierte nada.
 */

import { Trash2 } from "lucide-react"
import { useId } from "react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"

import type { BaseUnit, ComponentLineIn, ComponentLineOut, LineUnit } from "@/api/recipes"

export type LineKind = "ingredient" | "preparation"

export interface LineDraft {
  key: string
  /**
   * Autoritativo sobre qué selector "Tipo" muestra elegido — NO se deriva
   * de `ingredientId`/`preparationId` en el render (bug real que atrapó el
   * test de este archivo: cambiar el selector de "Tipo" a "Preparación"
   * antes de elegir una preparación puntual dejaba los dos ids en `null`, y
   * derivar el tipo de "cuál id no es null" volvía a mostrar "Insumo").
   */
  kind: LineKind
  ingredientId: number | null
  preparationId: number | null
  qty: string
  unit: LineUnit
}

let nextKey = 0
export function emptyLine(): LineDraft {
  nextKey += 1
  return { key: `new-${nextKey}`, kind: "ingredient", ingredientId: null, preparationId: null, qty: "", unit: "g" }
}

export function componentLinesToDrafts(lines: ComponentLineOut[]): LineDraft[] {
  return lines.map((line) => {
    nextKey += 1
    return {
      key: `existing-${nextKey}`,
      kind: line.preparation_id !== null ? "preparation" : "ingredient",
      ingredientId: line.ingredient_id,
      preparationId: line.preparation_id,
      qty: line.qty,
      unit: (line.unit as LineUnit) ?? "g",
    }
  })
}

export function isLineComplete(line: LineDraft): boolean {
  const hasComponent = line.kind === "ingredient" ? line.ingredientId !== null : line.preparationId !== null
  return hasComponent && line.qty.trim() !== ""
}

export function draftsToComponentLines(lines: LineDraft[]): ComponentLineIn[] {
  return lines.filter(isLineComplete).map((line) => ({
    ingredient_id: line.kind === "ingredient" ? (line.ingredientId ?? undefined) : undefined,
    preparation_id: line.kind === "preparation" ? (line.preparationId ?? undefined) : undefined,
    qty: line.qty.trim(),
    unit: line.unit,
  }))
}

const COMPATIBLE_UNITS: Record<BaseUnit, LineUnit[]> = {
  g: ["g", "kg"],
  ml: ["ml", "l"],
  unit: ["unit"],
}
const ALL_UNITS: LineUnit[] = ["g", "kg", "ml", "l", "unit"]
const UNIT_LABEL: Record<LineUnit, string> = { g: "g", kg: "kg", ml: "ml", l: "l", unit: "unidad" }

export interface LineIngredientOption {
  id: number
  name: string
  base_unit: BaseUnit
}
export interface LinePreparationOption {
  id: number
  name: string
  standard_yield_unit: string
}

export interface ComponentLinesEditorProps {
  idPrefix: string
  lines: LineDraft[]
  onChange: (lines: LineDraft[]) => void
  ingredients: LineIngredientOption[]
  preparations: LinePreparationOption[]
  /** La preparación que se está editando no puede referenciarse a sí misma
   * como componente de su propia receta (el ciclo de un solo salto; el
   * backend igual corre el DFS completo y corta con `400 PREP_CYCLE`). */
  excludePreparationId?: number
  disabled?: boolean
  emptyHint?: string
}

function baseUnitOf(
  line: LineDraft,
  ingredients: LineIngredientOption[],
  preparations: LinePreparationOption[]
): BaseUnit | null {
  if (line.kind === "ingredient") {
    if (line.ingredientId === null) return null
    return ingredients.find((i) => i.id === line.ingredientId)?.base_unit ?? null
  }
  if (line.preparationId === null) return null
  const unit = preparations.find((p) => p.id === line.preparationId)?.standard_yield_unit
  return unit === "g" || unit === "ml" || unit === "unit" ? unit : null
}

export function ComponentLinesEditor({
  idPrefix,
  lines,
  onChange,
  ingredients,
  preparations,
  excludePreparationId,
  disabled = false,
  emptyHint = "Todavía no hay líneas. Sin ninguna línea el plato no descuenta nada al venderse.",
}: ComponentLinesEditorProps): React.JSX.Element {
  const baseId = useId()
  const availablePreparations = preparations.filter((p) => p.id !== excludePreparationId)

  function updateLine(key: string, patch: Partial<LineDraft>) {
    onChange(lines.map((line) => (line.key === key ? { ...line, ...patch } : line)))
  }

  function removeLine(key: string) {
    onChange(lines.filter((line) => line.key !== key))
  }

  return (
    <div className="space-y-3" data-testid={`${idPrefix}-lines`}>
      {lines.length === 0 ? <p className="text-sm text-muted-foreground">{emptyHint}</p> : null}
      {lines.map((line, index) => {
        const kind = line.kind
        const compatible = (() => {
          const base = baseUnitOf(line, ingredients, preparations)
          return base ? COMPATIBLE_UNITS[base] : ALL_UNITS
        })()
        const rowId = `${baseId}-${idPrefix}-${index}`
        return (
          <div key={line.key} className="grid grid-cols-1 gap-2 rounded-md border p-2 sm:grid-cols-12 sm:items-end">
            <div className="space-y-1 sm:col-span-3">
              <Label htmlFor={`${rowId}-kind`}>Tipo</Label>
              <Select
                value={kind}
                onValueChange={(value) => {
                  if (value !== "ingredient" && value !== "preparation") return
                  updateLine(line.key, {
                    kind: value,
                    ingredientId: value === "ingredient" ? line.ingredientId : null,
                    preparationId: value === "preparation" ? line.preparationId : null,
                  })
                }}
                disabled={disabled}
              >
                <SelectTrigger id={`${rowId}-kind`} className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="ingredient">Insumo</SelectItem>
                  <SelectItem value="preparation">Preparación</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1 sm:col-span-4">
              <Label htmlFor={`${rowId}-component`}>{kind === "ingredient" ? "Insumo" : "Preparación"}</Label>
              {kind === "ingredient" ? (
                <Select
                  value={line.ingredientId !== null ? String(line.ingredientId) : undefined}
                  onValueChange={(value) => updateLine(line.key, { ingredientId: Number(value) })}
                  disabled={disabled}
                >
                  <SelectTrigger id={`${rowId}-component`} className="w-full">
                    <SelectValue placeholder="Elegí un insumo" />
                  </SelectTrigger>
                  <SelectContent>
                    {ingredients.length === 0 ? (
                      <p className="px-2 py-1.5 text-xs text-muted-foreground">No hay insumos activos.</p>
                    ) : (
                      ingredients.map((ingredient) => (
                        <SelectItem key={ingredient.id} value={String(ingredient.id)}>
                          {ingredient.name} ({ingredient.base_unit})
                        </SelectItem>
                      ))
                    )}
                  </SelectContent>
                </Select>
              ) : (
                <Select
                  value={line.preparationId !== null ? String(line.preparationId) : undefined}
                  onValueChange={(value) => updateLine(line.key, { preparationId: Number(value) })}
                  disabled={disabled}
                >
                  <SelectTrigger id={`${rowId}-component`} className="w-full">
                    <SelectValue placeholder="Elegí una preparación" />
                  </SelectTrigger>
                  <SelectContent>
                    {availablePreparations.length === 0 ? (
                      <p className="px-2 py-1.5 text-xs text-muted-foreground">No hay otras preparaciones.</p>
                    ) : (
                      availablePreparations.map((prep) => (
                        <SelectItem key={prep.id} value={String(prep.id)}>
                          {prep.name}
                        </SelectItem>
                      ))
                    )}
                  </SelectContent>
                </Select>
              )}
            </div>

            <div className="space-y-1 sm:col-span-2">
              <Label htmlFor={`${rowId}-qty`}>Cantidad</Label>
              <Input
                id={`${rowId}-qty`}
                inputMode="decimal"
                placeholder="0"
                value={line.qty}
                onChange={(event) => updateLine(line.key, { qty: event.target.value })}
                disabled={disabled}
              />
            </div>

            <div className="space-y-1 sm:col-span-2">
              <Label htmlFor={`${rowId}-unit`}>Unidad</Label>
              <Select
                value={line.unit}
                onValueChange={(value) => updateLine(line.key, { unit: value as LineUnit })}
                disabled={disabled}
              >
                <SelectTrigger id={`${rowId}-unit`} className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {compatible.map((unit) => (
                    <SelectItem key={unit} value={unit}>
                      {UNIT_LABEL[unit]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="sm:col-span-1">
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label="Quitar línea"
                disabled={disabled}
                onClick={() => removeLine(line.key)}
              >
                <Trash2 className="size-4" aria-hidden="true" />
              </Button>
            </div>
          </div>
        )
      })}
      <Button type="button" variant="outline" size="sm" disabled={disabled} onClick={() => onChange([...lines, emptyLine()])}>
        Agregar línea
      </Button>
    </div>
  )
}
