import { useMutation, useQuery } from "@tanstack/react-query"
import { useEffect, useState } from "react"

import {
  getProductRecipe,
  listIngredientOptions,
  listPreparations,
  putModifierOptionRecipeEffect,
  type ComponentLineOut,
  type RecipeEffectLineIn,
  type RecipeEffectType,
} from "@/api/recipes"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { errorMessage } from "@/lib/errors"

const EFFECT_LABEL: Record<RecipeEffectType, string> = {
  add: "Agrega insumos o preparaciones",
  remove: "Quita insumos o preparaciones de la ficha base",
  replace: "Reemplaza una línea de la ficha base por otra",
}

type LineUnit = "g" | "kg" | "ml" | "l" | "unit"

interface EffectLineDraft {
  key: string
  ingredientId: number | null
  preparationId: number | null
  qty: string
  unit: LineUnit
  /** Sólo para `effect === "replace"`: qué línea de la ficha base reemplaza. */
  replacesKey: string | null
}

let nextKey = 0
function emptyEffectLine(): EffectLineDraft {
  nextKey += 1
  return { key: `effect-${nextKey}`, ingredientId: null, preparationId: null, qty: "", unit: "g", replacesKey: null }
}

function baseLineKey(line: ComponentLineOut): string {
  return line.ingredient_id !== null ? `ingredient:${line.ingredient_id}` : `preparation:${line.preparation_id}`
}

function baseLineLabel(line: ComponentLineOut): string {
  return line.ingredient_name ?? line.preparation_name ?? "Componente sin nombre"
}

/**
 * `recipe_effect` de una opción de modificador (SPEC-NEGOCIO §4.3): quedó
 * `null` durante todo 1b, esto lo edita. **Gap declarado**: el backend sólo
 * expone `PUT /admin/modifier-options/{id}/recipe-effect` — no hay `GET`
 * (ni viene embebido en `GET /admin/modifier-groups`) — así que este diálogo
 * es de ESCRITURA: siempre abre en blanco, nunca puede mostrar qué efecto
 * quedó guardado antes de esta sesión. Ver el entregable, sección «gaps».
 */
export function RecipeEffectDialog({
  optionId,
  optionName,
  productId,
  storeId,
}: {
  optionId: number
  optionName: string
  productId: number
  storeId: number
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [effect, setEffect] = useState<RecipeEffectType>("add")
  const [lines, setLines] = useState<EffectLineDraft[]>([emptyEffectLine()])
  const [savedNote, setSavedNote] = useState<string | null>(null)

  const recipeQuery = useQuery({
    queryKey: ["recipes", "product-recipe", productId],
    queryFn: () => getProductRecipe(productId),
    enabled: open,
  })
  const ingredientsQuery = useQuery({
    queryKey: ["recipes", "ingredient-options", storeId],
    queryFn: () => listIngredientOptions(storeId),
    enabled: open,
  })
  const preparationsQuery = useQuery({
    queryKey: ["recipes", "preparations", storeId, false],
    queryFn: () => listPreparations(storeId, { activeOnly: true }),
    enabled: open,
  })

  useEffect(() => {
    if (!open) {
      setEffect("add")
      setLines([emptyEffectLine()])
      setSavedNote(null)
    }
  }, [open])

  const mutation = useMutation({
    mutationFn: () => {
      const baseLines = recipeQuery.data?.lines ?? []
      const built: RecipeEffectLineIn[] = lines
        .filter((line) => (line.ingredientId !== null || line.preparationId !== null) && line.qty.trim() !== "")
        .map((line) => {
          const target = baseLines.find((b) => baseLineKey(b) === line.replacesKey)
          return {
            ingredient_id: line.ingredientId ?? undefined,
            preparation_id: line.preparationId ?? undefined,
            qty: line.qty.trim(),
            unit: line.unit,
            replaces_ingredient_id: effect === "replace" ? (target?.ingredient_id ?? undefined) : undefined,
            replaces_preparation_id: effect === "replace" ? (target?.preparation_id ?? undefined) : undefined,
          }
        })
      return putModifierOptionRecipeEffect(optionId, { effect, lines: built })
    },
    onSuccess: (out) => {
      setSavedNote(
        `Guardado: ${EFFECT_LABEL[out.effect]} (${out.lines.length} línea${out.lines.length === 1 ? "" : "s"}).`,
      )
    },
  })

  const ingredients = ingredientsQuery.data ?? []
  const preparations = preparationsQuery.data ?? []
  const baseLines = recipeQuery.data?.lines ?? []

  const hasCompleteLine = lines.some(
    (line) => (line.ingredientId !== null || line.preparationId !== null) && line.qty.trim() !== ""
  )
  const replaceMissingTarget = effect === "replace" && lines.some(
    (line) => (line.ingredientId !== null || line.preparationId !== null) && line.qty.trim() !== "" && line.replacesKey === null
  )

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button type="button" variant="outline" size="sm" />}>Efecto en receta</DialogTrigger>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Efecto en receta de «{optionName}»</DialogTitle>
          <DialogDescription>
            Qué le cambia esta opción de modificador al consumo teórico del plato cuando alguien la elige: sumar
            insumos, quitarlos, o reemplazar una línea de la ficha base por otra.
          </DialogDescription>
        </DialogHeader>

        {recipeQuery.data && recipeQuery.data.version === 0 ? (
          <p className="text-sm text-muted-foreground">
            Este plato todavía no tiene ficha técnica propia: un efecto «reemplaza» necesita una línea base sobre la
            que actuar. «Agrega» y «quita» igual se pueden guardar.
          </p>
        ) : null}

        <div className="space-y-1">
          <Label htmlFor={`effect-type-${optionId}`}>Tipo de efecto</Label>
          <Select value={effect} onValueChange={(value) => setEffect(value as RecipeEffectType)}>
            <SelectTrigger id={`effect-type-${optionId}`} className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="add">Agrega</SelectItem>
              <SelectItem value="remove">Quita</SelectItem>
              <SelectItem value="replace">Reemplaza</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-3">
          {lines.map((line, index) => {
            const kind = line.preparationId !== null ? "preparation" : "ingredient"
            return (
              <div key={line.key} className="grid grid-cols-2 gap-2 rounded-md border p-2 sm:grid-cols-6">
                <div className="space-y-1 sm:col-span-2">
                  <Label htmlFor={`effect-kind-${optionId}-${index}`}>Componente</Label>
                  <Select
                    value={kind === "ingredient" && line.ingredientId !== null ? `ingredient:${line.ingredientId}` : kind === "preparation" && line.preparationId !== null ? `preparation:${line.preparationId}` : undefined}
                    onValueChange={(value) => {
                      if (value === null) return
                      const [type, id] = value.split(":")
                      setLines((prev) =>
                        prev.map((l) =>
                          l.key === line.key
                            ? {
                                ...l,
                                ingredientId: type === "ingredient" ? Number(id) : null,
                                preparationId: type === "preparation" ? Number(id) : null,
                              }
                            : l,
                        ),
                      )
                    }}
                  >
                    <SelectTrigger id={`effect-kind-${optionId}-${index}`} className="w-full">
                      <SelectValue placeholder="Elegí insumo o preparación" />
                    </SelectTrigger>
                    <SelectContent>
                      {ingredients.map((ingredient) => (
                        <SelectItem key={`ingredient:${ingredient.id}`} value={`ingredient:${ingredient.id}`}>
                          {ingredient.name} (insumo)
                        </SelectItem>
                      ))}
                      {preparations.map((prep) => (
                        <SelectItem key={`preparation:${prep.id}`} value={`preparation:${prep.id}`}>
                          {prep.name} (preparación)
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1">
                  <Label htmlFor={`effect-qty-${optionId}-${index}`}>Cantidad</Label>
                  <Input
                    id={`effect-qty-${optionId}-${index}`}
                    inputMode="decimal"
                    value={line.qty}
                    onChange={(event) =>
                      setLines((prev) => prev.map((l) => (l.key === line.key ? { ...l, qty: event.target.value } : l)))
                    }
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor={`effect-unit-${optionId}-${index}`}>Unidad</Label>
                  <Select
                    value={line.unit}
                    onValueChange={(value) =>
                      setLines((prev) => prev.map((l) => (l.key === line.key ? { ...l, unit: value as LineUnit } : l)))
                    }
                  >
                    <SelectTrigger id={`effect-unit-${optionId}-${index}`} className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="g">g</SelectItem>
                      <SelectItem value="kg">kg</SelectItem>
                      <SelectItem value="ml">ml</SelectItem>
                      <SelectItem value="l">l</SelectItem>
                      <SelectItem value="unit">unidad</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                {effect === "replace" ? (
                  <div className="space-y-1 sm:col-span-6">
                    <Label htmlFor={`effect-replaces-${optionId}-${index}`}>Reemplaza, en la ficha base</Label>
                    <Select
                      value={line.replacesKey ?? undefined}
                      onValueChange={(value) =>
                        setLines((prev) => prev.map((l) => (l.key === line.key ? { ...l, replacesKey: value } : l)))
                      }
                    >
                      <SelectTrigger id={`effect-replaces-${optionId}-${index}`} className="w-full">
                        <SelectValue placeholder="Elegí qué línea de la ficha reemplaza" />
                      </SelectTrigger>
                      <SelectContent>
                        {baseLines.map((base) => (
                          <SelectItem key={baseLineKey(base)} value={baseLineKey(base)}>
                            {baseLineLabel(base)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                ) : null}
                <div className="sm:col-span-6">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => setLines((prev) => prev.filter((l) => l.key !== line.key))}
                  >
                    Quitar línea
                  </Button>
                </div>
              </div>
            )
          })}
          <Button type="button" variant="outline" size="sm" onClick={() => setLines((prev) => [...prev, emptyEffectLine()])}>
            Agregar línea
          </Button>
        </div>

        {savedNote ? <p className="text-sm text-muted-foreground">{savedNote}</p> : null}
        {mutation.isError && (
          <p role="alert" className="text-sm text-destructive">
            {errorMessage(mutation.error)}
          </p>
        )}

        <DialogFooter>
          <Button
            type="button"
            disabled={mutation.isPending || !hasCompleteLine || replaceMissingTarget}
            onClick={() => mutation.mutate()}
          >
            Guardar efecto
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
