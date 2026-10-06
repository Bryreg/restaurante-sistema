import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useEffect, useState } from "react"
import { Link } from "react-router-dom"

import { useSession } from "@/app/session"
import { getAreaCountSettings, listCountAreas, putAreaCountSettings } from "@/api/areaCounts"
import {
  getInventorySettings,
  getInventoryThresholds,
  putInventoryThresholds,
  type InventoryThresholds,
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
 *   Cada renglón dice en qué área vive el insumo (`inventory.shift_counts`):
 *   el área es dónde está y quién lo cuenta al abrir y cerrar; «Crítico» es
 *   una marca aparte para el conteo del administrador (limpieza 2026-10: las
 *   dos listas cortas se parecían y nada decía cuál era cuál).
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

  // Dónde vive cada insumo (su área de conteo), para que la lista de
  // críticos se lea junto a las áreas y no como otra lista corta más.
  const areaCountsEnabled = hasFeature("inventory.shift_counts")
  const areasQuery = useQuery({
    queryKey: ["area-counts", "areas", storeId],
    queryFn: () => listCountAreas(storeId as number),
    enabled: storeId !== null && perpetualEnabled && areaCountsEnabled,
  })
  const areaDe = new Map<number, string>()
  for (const area of areasQuery.data ?? []) {
    if (!area.active) continue
    for (const item of area.items) areaDe.set(item.ingredient_id, area.name)
  }

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

      <ThresholdsSection storeId={storeId} />

      <AreaCountLimitsSection storeId={storeId} />

      <FormSection
        title="Insumos críticos"
        columns="one"
        governs='Los que entran al conteo de "Críticos" del administrador (5 a 15, el 60–70 % de las compras), que ajusta el stock y alimenta la varianza. También se marcan insumo por insumo en Inventario → Insumos. No es la lista de cada área (Inventario → Por área): el área dice dónde vive un insumo y quién lo cuenta al abrir y cerrar; un insumo puede estar en las dos.'
        reading={
          !perpetualEnabled ? (
            <>Con el inventario apagado, no hay stock que contar y esta lista no alimenta ningún conteo.</>
          ) : (
            <>
              <b className="font-bold text-foreground tabular-nums">{keyItems.length}</b> de{" "}
              <b className="font-bold text-foreground tabular-nums">{ingredients.length}</b> insumos activos
              entran al conteo de críticos. Los que no están marcados siguen existiendo y se cuentan en el conteo
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
            description="Acá se eligen los insumos que entran al conteo de críticos. Primero tienen que existir."
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
                    {areaDe.has(ingredient.id) ? (
                      <span className="text-xs text-muted-foreground"> · vive en {areaDe.get(ingredient.id)}</span>
                    ) : null}
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

/**
 * Ajustes › Inventario y compras: los umbrales que vivían quemados en el
 * código (0035). Cada campo dice en una línea qué gobierna. Los de
 * confiabilidad de proveedores se escriben en % y viajan en puntos básicos
 * (9900 = 99 %): esa conversión es de formato de entrada, no de negocio.
 */
type Campo = {
  key: keyof InventoryThresholds
  label: string
  help: string
  bp?: boolean
  min: number
  max: number
}

const CAMPOS: readonly Campo[] = [
  {
    key: "price_jump_pct",
    label: "Salto de precio que pide confirmar (%)",
    help: "Una recepción con un precio que se aleja más que esto del promedio pide confirmación antes de entrar.",
    min: 1,
    max: 100,
  },
  {
    key: "prep_variance_alert_pct",
    label: "Rendimiento de producción que avisa (%)",
    help: "Una producción que rinde más o menos que esto contra lo teórico queda marcada con alerta.",
    min: 1,
    max: 100,
  },
  {
    key: "stale_days",
    label: "Días sin conteo completo para «no confiable»",
    help: "Pasados estos días sin un conteo completo aplicado, el food cost real se apaga y el inventario se marca no confiable.",
    min: 1,
    max: 120,
  },
  {
    key: "lot_expiring_window_days",
    label: "Días para «por vencer» en lotes",
    help: "Un lote que vence dentro de estos días sale en ámbar en Inventario › Lotes y en Hoy.",
    min: 1,
    max: 90,
  },
  {
    key: "food_cost_band_min_pct",
    label: "Food cost sano: piso (%)",
    help: "Debajo del piso la receta sale marcada «fuera de rango» en Carta › Recetas.",
    min: 1,
    max: 100,
  },
  {
    key: "food_cost_band_max_pct",
    label: "Food cost sano: techo (%)",
    help: "Encima del techo la receta sale marcada «fuera de rango» en Carta › Recetas.",
    min: 1,
    max: 100,
  },
  {
    key: "supplier_received_warning_bp",
    label: "Proveedor: recibido ÷ facturado en ámbar (%)",
    help: "Debajo de esto ya se está pagando algo que no entró.",
    bp: true,
    min: 1,
    max: 100,
  },
  {
    key: "supplier_received_critical_bp",
    label: "Proveedor: recibido ÷ facturado en rojo (%)",
    help: "Debajo de esto es faltante: el único uso del rojo.",
    bp: true,
    min: 1,
    max: 100,
  },
  {
    key: "supplier_drift_warning_bp",
    label: "Proveedor: subida de precio en ámbar (%)",
    help: "Una subida contra la compra anterior del mismo insumo desde esto pide mirar.",
    bp: true,
    min: 0.01,
    max: 100,
  },
  {
    key: "supplier_drift_critical_bp",
    label: "Proveedor: subida de precio en rojo (%)",
    help: "Desde esto, renegociar o cambiar de proveedor.",
    bp: true,
    min: 0.01,
    max: 100,
  },
  {
    key: "supplier_min_receptions",
    label: "Proveedor: recepciones mínimas",
    help: "Con menos recepciones en el rango la cifra se muestra marcada como muestra chica.",
    min: 1,
    max: 100,
  },
]

function aTexto(c: Campo, t: InventoryThresholds): string {
  const v = t[c.key]
  return c.bp ? String(v / 100) : String(v)
}

function aValor(c: Campo, texto: string): number | null {
  const n = Number(texto.trim().replace(",", "."))
  if (texto.trim() === "" || Number.isNaN(n) || n < c.min || n > c.max) return null
  return c.bp ? Math.round(n * 100) : Math.round(n)
}

function ThresholdsSection({ storeId }: { storeId: number | null }): React.JSX.Element {
  const queryClient = useQueryClient()
  const query = useQuery({
    queryKey: ["inventory", "thresholds", storeId],
    queryFn: () => getInventoryThresholds(storeId as number),
    enabled: storeId !== null,
  })
  const [textos, setTextos] = useState<Record<string, string>>({})
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const t = query.data
    if (t) setTextos(Object.fromEntries(CAMPOS.map((c) => [c.key, aTexto(c, t)])))
  }, [query.data])

  const mutation = useMutation({
    mutationFn: (data: Partial<InventoryThresholds>) => putInventoryThresholds(storeId as number, data),
    onSuccess: () => {
      setError(null)
      void queryClient.invalidateQueries({ queryKey: ["inventory", "thresholds", storeId] })
    },
    onError: (err) => setError(errorMessage(err)),
  })

  if (storeId === null) {
    return <EmptyState title="Elegí una sede" description="Creá una sede en la pestaña Sedes primero." />
  }
  if (query.isLoading) return <Skeleton className="h-48 w-full" />
  if (query.isError) {
    return (
      <EmptyState
        role="alert"
        reason="error"
        title="No se pudieron cargar los umbrales"
        description={errorMessage(query.error)}
        action={{ label: "Reintentar", onClick: () => void query.refetch() }}
      />
    )
  }

  const valores = Object.fromEntries(CAMPOS.map((c) => [c.key, aValor(c, textos[c.key] ?? "")]))
  const invalidos = CAMPOS.filter((c) => valores[c.key] === null)

  function guardar(event: React.FormEvent): void {
    event.preventDefault()
    if (invalidos.length > 0) return
    mutation.mutate(valores as Partial<InventoryThresholds>)
  }

  return (
    <FormSection
      title="Umbrales de compras e inventario"
      governs="Desde cuándo el sistema avisa: un precio de compra raro, una producción que rinde de más o de menos, un inventario viejo, un lote por vencer, una receta cara y un proveedor que entrega de menos o sube precios."
      reading={
        <>
          Ninguno frena nada por sí solo: pintan un color o piden una confirmación. Los valores de fábrica son 15 %,
          15 %, 14 días, 7 días, 28–35 %, 99/95 %, 5/10 % y 5 recepciones.
        </>
      }
    >
      <form className="contents" onSubmit={guardar}>
        {CAMPOS.map((c) => (
          <FormField
            key={c.key}
            label={c.label}
            help={c.help}
            error={textos[c.key] !== undefined && valores[c.key] === null ? `Entre ${c.min} y ${c.max}.` : undefined}
          >
            {({ fieldId, describedBy }) => (
              <Input
                id={fieldId}
                aria-describedby={describedBy}
                inputMode="decimal"
                className="h-11"
                value={textos[c.key] ?? ""}
                onChange={(e) => setTextos((t) => ({ ...t, [c.key]: e.target.value }))}
              />
            )}
          </FormField>
        ))}
        <div className="sm:col-span-2">
          {error ? (
            <p role="alert" className="mb-2 text-sm font-medium text-destructive">
              {error}
            </p>
          ) : null}
          <Button type="submit" disabled={invalidos.length > 0 || mutation.isPending}>
            {mutation.isPending ? "Guardando…" : "Guardar umbrales de compras e inventario"}
          </Button>
        </div>
      </form>
    </FormSection>
  )
}

/**
 * Ajustes › Inventario › Conteo por área: los límites que antes estaban
 * quemados en el backend y repetidos en la pantalla (artículos por área, por
 * recuento, hora de sugerir «Cierre»). El umbral de aviso y el conteo
 * mensual siguen en Inventario › Conteo por área, con su enlace acá.
 */
function AreaCountLimitsSection({ storeId }: { storeId: number | null }): React.JSX.Element | null {
  const { hasFeature } = useSession()
  const enabled = hasFeature("inventory.shift_counts") && hasFeature("inventory.perpetual")
  const queryClient = useQueryClient()
  const query = useQuery({
    queryKey: ["area-counts", "settings", storeId],
    queryFn: () => getAreaCountSettings(storeId as number),
    enabled: storeId !== null && enabled,
  })
  const [items, setItems] = useState("")
  const [recount, setRecount] = useState("")
  const [hour, setHour] = useState("")
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (query.data) {
      setItems(String(query.data.max_items_per_area))
      setRecount(String(query.data.max_recount_items))
      setHour(String(query.data.suggest_closing_from_hour))
    }
  }, [query.data])

  const mutation = useMutation({
    mutationFn: () => {
      const s = query.data
      if (!s) throw new Error("Todavía no se cargó la configuración")
      return putAreaCountSettings(storeId as number, {
        threshold_pct_bp: s.threshold_pct_bp,
        threshold_amount: s.threshold_amount,
        max_items_per_area: Number(items),
        max_recount_items: Number(recount),
        suggest_closing_from_hour: Number(hour),
      })
    },
    onSuccess: () => {
      setError(null)
      void queryClient.invalidateQueries({ queryKey: ["area-counts", "settings", storeId] })
    },
    onError: (err) => setError(errorMessage(err)),
  })

  if (storeId === null || !enabled) return null

  const ok =
    Number.isInteger(Number(items)) && Number(items) >= 1 && Number(items) <= 100 &&
    Number.isInteger(Number(recount)) && Number(recount) >= 1 && Number(recount) <= 50 &&
    Number.isInteger(Number(hour)) && hour.trim() !== "" && Number(hour) >= 0 && Number(hour) <= 23

  return (
    <FormSection
      title="Conteo por área: límites"
      governs="Cuántos artículos cuenta cada área, cuántos entran en un recuento sorpresa y desde qué hora la tablet propone «Cierre» en vez de «Apertura»."
      reading={
        <>
          El umbral de aviso de faltantes y el conteo completo del mes se configuran en{" "}
          <Link to="/admin/inventario?tab=por-area" className="text-primary underline underline-offset-2">
            Inventario › Conteo por área
          </Link>
          .
        </>
      }
    >
      {query.isLoading ? (
        <Skeleton className="h-24 w-full" />
      ) : (
        <form
          className="contents"
          onSubmit={(e) => {
            e.preventDefault()
            if (ok) mutation.mutate()
          }}
        >
          <FormField label="Artículos por área (máximo)" help="La lista es corta a propósito: los clave, no todo el inventario.">
            {({ fieldId, describedBy }) => (
              <Input id={fieldId} aria-describedby={describedBy} type="number" min={1} max={100} className="h-11" value={items} onChange={(e) => setItems(e.target.value)} />
            )}
          </FormField>
          <FormField label="Artículos por recuento sorpresa (máximo)" help="Un recuento es rápido: pocos artículos, contados sin ver el sistema.">
            {({ fieldId, describedBy }) => (
              <Input id={fieldId} aria-describedby={describedBy} type="number" min={1} max={50} className="h-11" value={recount} onChange={(e) => setRecount(e.target.value)} />
            )}
          </FormField>
          <FormField label="Hora desde la que se sugiere «Cierre» (0–23)" help="Sin conteo en el día, desde esta hora de Bogotá la tablet propone el conteo de cierre.">
            {({ fieldId, describedBy }) => (
              <Input id={fieldId} aria-describedby={describedBy} type="number" min={0} max={23} className="h-11" value={hour} onChange={(e) => setHour(e.target.value)} />
            )}
          </FormField>
          <div className="sm:col-span-2">
            {error ? (
              <p role="alert" className="mb-2 text-sm font-medium text-destructive">
                {error}
              </p>
            ) : null}
            <Button type="submit" disabled={!ok || mutation.isPending}>
              {mutation.isPending ? "Guardando…" : "Guardar límites del conteo"}
            </Button>
          </div>
        </form>
      )}
    </FormSection>
  )
}

export default InventorySection
