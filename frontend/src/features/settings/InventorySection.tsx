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
import {
  DependencyEmptyState,
  FeatureOffEmptyState,
  FormField,
  FormSection,
} from "@/components/admin"
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

  const yellowOk = yellowBp !== null
  const redOk = redBp !== null && yellowBp !== null && redBp > yellowBp

  return (
    <div className="space-y-3">
      <FormSection
        title="Desde qué desvío se revisa una varianza"
        governs="Los dos umbrales del semáforo de Inventario › Varianza. Cambiarlos acá cambia el color allá, no al revés: son las fronteras, el color es su consecuencia."
        scale={
          varianceEnabled && yellowOk && redOk ? (
            <div aria-hidden="true">
              <div className="flex h-2.5 overflow-hidden rounded-full">
                <span style={{ flex: yellowBp }} className="bg-success/45" />
                <span style={{ flex: Math.max(redBp - yellowBp, 1) }} className="bg-warning/45" />
                <span style={{ flex: Math.max(Math.round((redBp - yellowBp) * 0.75), 1) }} className="bg-destructive/45" />
              </div>
              <div className="mt-1 flex gap-2 text-[0.68rem] leading-tight">
                <span style={{ flex: yellowBp }} className="min-w-0">
                  <b className="block font-bold text-success tabular-nums">0 %</b>
                  <span className="block text-muted-foreground">Dentro de lo esperado</span>
                </span>
                <span style={{ flex: Math.max(redBp - yellowBp, 1) }} className="min-w-0">
                  <b className="block font-bold text-warning tabular-nums">{yellowText} %</b>
                  <span className="block text-muted-foreground">Revisar</span>
                </span>
                <span style={{ flex: Math.max(Math.round((redBp - yellowBp) * 0.75), 1) }} className="min-w-0">
                  <b className="block font-bold text-destructive tabular-nums">{redText} %</b>
                  <span className="block text-muted-foreground">Sostenido</span>
                </span>
              </div>
            </div>
          ) : null
        }
        reading={
          !varianceEnabled ? (
            <>Con la varianza apagada, estos dos umbrales quedan guardados sin que nada los lea.</>
          ) : redOk ? (
            <>
              Una varianza de hasta <b className="font-bold text-foreground tabular-nums">{yellowText} %</b> se
              dibuja en verde y nadie la mira. De ahí a{" "}
              <b className="font-bold text-foreground tabular-nums">{redText} %</b> sale en ámbar: hay que
              revisarla. Desde <b className="font-bold text-foreground tabular-nums">{redText} %</b> sale en rojo
              y se trata como desvío sostenido.
            </>
          ) : (
            <>
              El umbral rojo tiene que ser mayor que el amarillo. Así como están, la franja del medio no existe y
              el semáforo tendría dos colores en vez de tres.
            </>
          )
        }
        doesNotDo="Ninguno de los dos frena una venta ni una producción: pintan el semáforo de la varianza y nada más."
      >
        {!varianceEnabled ? (
          <FeatureOffEmptyState
            feature="Varianza de inventario y food cost real"
            flag="inventory.variance"
            description="Compara lo que las recetas dicen que se gastó contra lo que salió del inventario."
          />
        ) : settingsQuery.isLoading ? (
          <Skeleton className="h-32 w-full max-w-sm" />
        ) : settingsQuery.isError ? (
          <EmptyState
            role="alert"
            reason="error"
            title="No se pudieron cargar los umbrales"
            description={errorMessage(settingsQuery.error)}
            action={{ label: "Reintentar", onClick: () => void settingsQuery.refetch() }}
          />
        ) : (
          <form className="contents" onSubmit={handleSubmitSettings}>
            <FormField
              label="Umbral amarillo (revisar), en %"
              help={
                <>
                  Desde acá la varianza deja de ser ruido y se mira.{" "}
                  <span>Default de industria: {bpToPercentText(DEFAULT_YELLOW_BP)} %.</span>
                </>
              }
              scope={{ flag: "inventory.variance", affects: [{ screen: "Inventario › Varianza", verb: "Pinta" }] }}
            >
              {({ fieldId, describedBy }) => (
                <Input
                  id={fieldId}
                  aria-describedby={describedBy}
                  inputMode="decimal"
                  className="h-11"
                  value={yellowText}
                  aria-invalid={yellowText.trim() !== "" && yellowBp === null}
                  onChange={(event) => setYellowText(event.target.value)}
                />
              )}
            </FormField>

            <FormField
              label="Umbral rojo (sostenido), en %"
              help={
                <>
                  Desde acá se trata como desvío sostenido, no como un mal conteo.{" "}
                  <span>Default de industria: {bpToPercentText(DEFAULT_RED_BP)} %.</span>
                </>
              }
              error={yellowOk && redBp !== null && !redOk ? "El umbral rojo tiene que ser mayor que el amarillo." : undefined}
              scope={{ flag: "inventory.variance", affects: [{ screen: "Inventario › Varianza", verb: "Pinta" }] }}
            >
              {({ fieldId, describedBy }) => (
                <Input
                  id={fieldId}
                  aria-describedby={describedBy}
                  inputMode="decimal"
                  className="h-11"
                  value={redText}
                  aria-invalid={redText.trim() !== "" && (redBp === null || (yellowBp !== null && redBp <= yellowBp))}
                  onChange={(event) => setRedText(event.target.value)}
                />
              )}
            </FormField>

            <div className="sm:col-span-2">
              {saveError ? (
                <p role="alert" className="mb-2 text-sm font-medium text-destructive">
                  {saveError}
                </p>
              ) : null}
              {/* Esta sección NO usa la barra de guardado compartida: su
                  guardado depende de una validación cruzada (rojo > amarillo)
                  que se expresa apagando el botón, y `SaveBar` no tiene cómo
                  decir «hay cambios pero no se pueden guardar». Declarado en
                  el informe de la ola 2. */}
              <Button type="submit" disabled={!canSaveSettings || saveSettingsMutation.isPending}>
                {saveSettingsMutation.isPending ? "Guardando…" : "Guardar umbrales"}
              </Button>
            </div>
          </form>
        )}
      </FormSection>

      <FormSection
        title="Insumos críticos"
        columns="one"
        governs='Los que entran al conteo rápido de "Críticos" (5 a 15, el 60–70 % de las compras). También se pueden marcar insumo por insumo en Inventario → Insumos.'
        reading={
          !perpetualEnabled ? (
            <>Con el inventario apagado, no hay stock que contar y esta lista no alimenta ningún conteo.</>
          ) : (
            <>
              <b className="font-bold text-foreground tabular-nums">{keyItems.length}</b> de{" "}
              <b className="font-bold text-foreground tabular-nums">{ingredients.length}</b> insumos activos
              entran al conteo rápido. Los que no están marcados siguen existiendo y se cuentan en el conteo
              completo: esto elige a los de todos los días.
            </>
          )
        }
      >
        {!perpetualEnabled ? (
          <FeatureOffEmptyState
            feature="Movimientos de inventario y stock teórico"
            flag="inventory.perpetual"
            description="Lleva el stock teórico de cada insumo y deja contar contra él."
          />
        ) : ingredientsQuery.isLoading ? (
          <Skeleton className="h-48 w-full max-w-sm" />
        ) : ingredientsQuery.isError ? (
          <EmptyState
            role="alert"
            reason="error"
            title="No se pudieron cargar los insumos"
            description={errorMessage(ingredientsQuery.error)}
            action={{ label: "Reintentar", onClick: () => void ingredientsQuery.refetch() }}
          />
        ) : ingredients.length === 0 ? (
          <DependencyEmptyState
            title="Sin insumos activos"
            description="Acá se eligen los insumos que entran al conteo rápido. Primero tienen que existir."
            create={{ label: "Crear insumos", to: "/admin/inventario" }}
          />
        ) : (
          <div className="space-y-2">
            <p className="text-xs text-muted-foreground">
              {keyItems.length} de {ingredients.length} marcados como críticos.
            </p>
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
      </FormSection>
    </div>
  )
}

export default InventorySection
