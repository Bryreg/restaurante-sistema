import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useEffect, useState } from "react"

import { useSession } from "@/app/session"
import {
  getInventorySettings,
  listIngredients,
  putInventorySettings,
  updateIngredient,
  type IngredientOut,
} from "@/api/inventory"
import { EmptyState } from "@/components/EmptyState"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Skeleton } from "@/components/ui/skeleton"
import { errorMessage } from "@/lib/errors"

import { formatBasisPoints } from "@/features/inventory/lib"

/** Puntos básicos REALES (100 = 1 %, misma escala que `variance_pct_bp`) —
 * texto en porcentaje para el input, sólo para esta pantalla de edición. */
function bpToPercentText(bp: number): string {
  return formatBasisPoints(bp).replace(" %", "").replace(",", ".")
}

function percentTextToBp(text: string): number | null {
  const trimmed = text.trim().replace(",", ".")
  if (trimmed === "") return null
  const value = Number(trimmed)
  if (Number.isNaN(value) || value <= 0) return null
  return Math.round(value * 100)
}

const DEFAULT_YELLOW_BP = 200
const DEFAULT_RED_BP = 400

/**
 * Admin → Configuración → Inventario (pedido 2b, SPEC-NEGOCIO §9.3 —
 * "insumos críticos" está en la fila **Configuración** de esa tabla, no en
 * la de **Inventario**). Huérfano nombrado con dueño desde el arranque del
 * reparto (`features/fase-2-costo-inventario/spec.md`): dos campos que el
 * backend acepta desde 2b y hasta esta pantalla ninguna pintaba —
 * "escritos a medias" es exactamente el modo de falla que evita nombrar
 * dueño de entrada.
 *
 * - **Umbrales de varianza**: `GET/PUT /admin/stores/{id}/inventory-
 *   settings` (vive en `app.inventory` en el backend, se edita acá porque
 *   es configuración de sede). Se editan como PORCENTAJE con coma o punto
 *   — la conversión a puntos básicos es la ÚNICA cuenta que hace este
 *   archivo, y es de FORMATO de entrada, no de negocio: el servidor valida
 *   `red > yellow` igual (`400 VALIDATION_ERROR` si no), esto es sólo
 *   comodidad para no obligar a nadie a escribir "200" en vez de "2".
 * - **Insumos críticos** (`Ingredient.key_item`): los que entran al conteo
 *   rápido. Ya son editables insumo por insumo en Inventario → Insumos
 *   (`IngredientForm.tsx`, mismo backend); acá se ve la lista COMPLETA de
 *   una vez, que es lo que pide la fila "Configuración" de §9.3 — elegir
 *   los 5 a 15 críticos de punta a punta sin abrir un diálogo por insumo.
 */
export function InventorySection({ storeId }: { storeId: number | null }): React.JSX.Element {
  const { hasFeature } = useSession()
  const queryClient = useQueryClient()
  const varianceEnabled = hasFeature("inventory.variance")
  const perpetualEnabled = hasFeature("inventory.perpetual")

  const settingsQuery = useQuery({
    queryKey: ["settings", "inventory-settings", storeId],
    queryFn: () => getInventorySettings(storeId as number),
    enabled: storeId !== null && varianceEnabled,
  })
  const [yellowText, setYellowText] = useState("")
  const [redText, setRedText] = useState("")
  const [saveError, setSaveError] = useState<string | null>(null)

  useEffect(() => {
    if (settingsQuery.data) {
      setYellowText(bpToPercentText(settingsQuery.data.variance_yellow_threshold_bp))
      setRedText(bpToPercentText(settingsQuery.data.variance_red_threshold_bp))
    }
  }, [settingsQuery.data])

  const saveSettingsMutation = useMutation({
    mutationFn: (data: { variance_yellow_threshold_bp: number; variance_red_threshold_bp: number }) =>
      putInventorySettings(storeId as number, data),
    onSuccess: () => {
      setSaveError(null)
      void queryClient.invalidateQueries({ queryKey: ["settings", "inventory-settings", storeId] })
    },
    onError: (err) => setSaveError(errorMessage(err)),
  })

  const ingredientsQuery = useQuery({
    queryKey: ["settings", "key-items", storeId],
    queryFn: () => listIngredients(storeId as number, { activeOnly: true }),
    enabled: storeId !== null && perpetualEnabled,
  })

  const toggleKeyItemMutation = useMutation({
    mutationFn: (params: { ingredient: IngredientOut; keyItem: boolean }) =>
      updateIngredient(params.ingredient.id, { key_item: params.keyItem }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["settings", "key-items", storeId] }),
  })

  if (storeId === null) {
    return <EmptyState title="Elegí una sede" description="Creá una sede en la pestaña Sedes primero." />
  }

  const yellowBp = percentTextToBp(yellowText)
  const redBp = percentTextToBp(redText)
  const canSaveSettings = yellowBp !== null && redBp !== null && redBp > yellowBp

  function handleSubmitSettings(event: React.FormEvent): void {
    event.preventDefault()
    if (yellowBp === null || redBp === null) return
    if (redBp <= yellowBp) {
      setSaveError("El umbral rojo tiene que ser mayor que el amarillo.")
      return
    }
    saveSettingsMutation.mutate({ variance_yellow_threshold_bp: yellowBp, variance_red_threshold_bp: redBp })
  }

  const ingredients = ingredientsQuery.data ?? []
  const keyItems = ingredients.filter((i) => i.key_item)

  return (
    <div className="max-w-2xl space-y-8">
      <section className="space-y-3">
        <div>
          <h2 className="text-sm font-semibold">Umbrales de varianza</h2>
          <p className="text-sm text-muted-foreground">
            El semáforo de la pestaña Varianza usa estos umbrales — cambiarlos acá cambia el color ahí, no al revés.
          </p>
        </div>
        {!varianceEnabled ? (
          <EmptyState
            title="Varianza no está habilitada"
            description='Activá «Varianza de inventario y food cost real» en Admin → Funciones para configurar los umbrales.'
          />
        ) : settingsQuery.isLoading ? (
          <Skeleton className="h-32 w-full max-w-sm" />
        ) : settingsQuery.isError ? (
          <EmptyState
            role="alert"
            title="No se pudieron cargar los umbrales"
            description={errorMessage(settingsQuery.error)}
            action={{ label: "Reintentar", onClick: () => void settingsQuery.refetch() }}
          />
        ) : (
          <form className="max-w-sm space-y-4" onSubmit={handleSubmitSettings}>
            <div className="space-y-1.5">
              <Label htmlFor="inv-yellow-threshold">Umbral amarillo (revisar), en %</Label>
              <Input
                id="inv-yellow-threshold"
                inputMode="decimal"
                className="h-11"
                value={yellowText}
                aria-invalid={yellowText.trim() !== "" && yellowBp === null}
                onChange={(event) => setYellowText(event.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                Default de industria: {bpToPercentText(DEFAULT_YELLOW_BP)} %.
              </p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="inv-red-threshold">Umbral rojo (sostenido), en %</Label>
              <Input
                id="inv-red-threshold"
                inputMode="decimal"
                className="h-11"
                value={redText}
                aria-invalid={redText.trim() !== "" && (redBp === null || (yellowBp !== null && redBp <= yellowBp))}
                onChange={(event) => setRedText(event.target.value)}
              />
              <p className="text-xs text-muted-foreground">Default de industria: {bpToPercentText(DEFAULT_RED_BP)} %.</p>
            </div>
            {saveError ? (
              <p role="alert" className="text-sm font-medium text-destructive">
                {saveError}
              </p>
            ) : null}
            <Button type="submit" disabled={!canSaveSettings || saveSettingsMutation.isPending}>
              {saveSettingsMutation.isPending ? "Guardando…" : "Guardar umbrales"}
            </Button>
          </form>
        )}
      </section>

      <section className="space-y-3 border-t pt-6">
        <div>
          <h2 className="text-sm font-semibold">Insumos críticos</h2>
          <p className="text-sm text-muted-foreground">
            Los que entran al conteo rápido de "Críticos" (5 a 15, el 60–70 % de las compras). También se pueden
            marcar insumo por insumo en Inventario → Insumos.
          </p>
        </div>
        {!perpetualEnabled ? (
          <EmptyState
            title="Inventario no está habilitado"
            description='Activá «Movimientos de inventario y stock teórico» en Admin → Funciones.'
          />
        ) : ingredientsQuery.isLoading ? (
          <Skeleton className="h-48 w-full max-w-sm" />
        ) : ingredientsQuery.isError ? (
          <EmptyState
            role="alert"
            title="No se pudieron cargar los insumos"
            description={errorMessage(ingredientsQuery.error)}
            action={{ label: "Reintentar", onClick: () => void ingredientsQuery.refetch() }}
          />
        ) : ingredients.length === 0 ? (
          <EmptyState title="Sin insumos activos" description="Creá insumos en Inventario → Insumos primero." />
        ) : (
          <div className="space-y-2">
            <p className="text-xs text-muted-foreground">{keyItems.length} de {ingredients.length} marcados como críticos.</p>
            <ul className="max-h-96 max-w-sm space-y-1 overflow-y-auto rounded-md border p-2">
              {ingredients.map((ingredient) => (
                <li key={ingredient.id} className="flex items-center gap-2 rounded-sm px-1.5 py-1 hover:bg-muted/50">
                  <Checkbox
                    id={`key-item-${ingredient.id}`}
                    checked={ingredient.key_item}
                    disabled={toggleKeyItemMutation.isPending}
                    onCheckedChange={(checked) =>
                      toggleKeyItemMutation.mutate({ ingredient, keyItem: checked === true })
                    }
                  />
                  <Label htmlFor={`key-item-${ingredient.id}`} className="flex-1 cursor-pointer font-normal">
                    {ingredient.name}
                  </Label>
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>
    </div>
  )
}

export default InventorySection
