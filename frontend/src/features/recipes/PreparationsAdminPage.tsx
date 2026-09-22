import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useState } from "react"

import { useSession } from "@/app/session"
import { useStoreSelection } from "@/app/storeContext"
import {
  createPreparation,
  listIngredientOptions,
  listPreparations,
  preparationsCsvUrl,
  updatePreparation,
  type PreparationAdminOut,
} from "@/api/recipes"
import { CsvExportButton } from "@/components/CsvExportButton"
import {
  DenseTable,
  DenseTableBar,
  FeatureOffEmptyState,
  PageHeader,
  type DenseColumn,
  type LegendEntry,
} from "@/components/admin"
import { EmptyState } from "@/components/EmptyState"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"
import { errorMessage } from "@/lib/errors"
import { cn } from "@/lib/utils"

import { CostValue } from "./costDisplay"
import type { LineIngredientOption, LinePreparationOption } from "./ComponentLinesEditor"
import {
  formValuesToPreparationIn,
  formValuesToPreparationUpdateIn,
  PreparationForm,
} from "./PreparationForm"
import { PrepBatchesPanel } from "./PrepBatchesPanel"
import { PrepModeSwitchDialog } from "./PrepModeSwitchDialog"

const MODE_LABEL: Record<string, string> = { batch: "Por lote", exploded: "Explotada" }

/**
 * Las acciones de la fila, en su propio componente: cada una tiene su
 * mutación y su diálogo, y la columna de acciones del patrón 8 es de ancho
 * fijo para que el borde derecho no baile de fila a fila.
 */
/** La leyenda del pie: los dos modos, que NO son dos grados de lo mismo. */
const PREPS_LEGEND: readonly LegendEntry[] = [
  {
    term: "Explotada",
    meaning:
      "no lleva stock propio: al vender el plato se descuentan directo los insumos de su receta. Es el modo por defecto y el que no se puede desincronizar.",
  },
  {
    term: "Por lote",
    meaning: (
      <>
        lleva stock propio y <b>alguien tiene que producirla</b>. Si nadie lo hace, queda en negativo y el
        costo de los platos que la usan se va a las nubes.
      </>
    ),
  },
  {
    term: "Sin costo",
    meaning: (
      <>
        no es <b>$ 0</b> — no se pudo valorar la unidad porque algún componente no tiene costo conocido.
      </>
    ),
  },
]

function PreparationActions({
  preparation,
  ingredientOptions,
  preparationOptions,
}: {
  preparation: PreparationAdminOut
  ingredientOptions: LineIngredientOption[]
  preparationOptions: LinePreparationOption[]
}) {
  const queryClient = useQueryClient()
  const [editing, setEditing] = useState(false)
  const [switching, setSwitching] = useState(false)
  const [batches, setBatches] = useState(false)

  const updateMutation = useMutation({
    mutationFn: (values: Parameters<typeof formValuesToPreparationUpdateIn>[0]) =>
      updatePreparation(preparation.id, formValuesToPreparationUpdateIn(values)),
    onSuccess: () => {
      setEditing(false)
      void queryClient.invalidateQueries({ queryKey: ["recipes", "preparations"] })
    },
  })

  return (
    <div className="flex flex-nowrap justify-end gap-1">
      <Dialog open={editing} onOpenChange={setEditing}>
        <DialogTrigger render={<Button variant="outline" size="sm" />}>Editar</DialogTrigger>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Editar {preparation.name}</DialogTitle>
          </DialogHeader>
          <PreparationForm
            preparation={preparation}
            ingredients={ingredientOptions}
            preparations={preparationOptions}
            submitting={updateMutation.isPending}
            submitLabel="Guardar"
            onSubmit={(values) => updateMutation.mutate(values)}
          />
          {updateMutation.isError && (
            <p role="alert" className="text-sm text-destructive">
              {errorMessage(updateMutation.error)}
            </p>
          )}
        </DialogContent>
      </Dialog>
      <Button variant="outline" size="sm" onClick={() => setSwitching(true)}>
        Cambiar modo
      </Button>
      {/* «Ver lotes» SÓLO existe en modo «por lote»: un control que aparece y
          desaparece con el estado de la fila (`docs/INVENTARIO-CONTROLES.md`
          § 23). */}
      {preparation.mode === "batch" && (
        <Button variant="outline" size="sm" onClick={() => setBatches(true)}>
          Ver lotes
        </Button>
      )}
      {switching && (
        <PrepModeSwitchDialog preparation={preparation} open={switching} onOpenChange={setSwitching} />
      )}
      {batches && <PrepBatchesPanel preparation={preparation} open={batches} onOpenChange={setBatches} />}
    </div>
  )
}

function useIngredientOptions(storeId: number) {
  return useQuery({
    queryKey: ["recipes", "ingredient-options", storeId],
    queryFn: () => listIngredientOptions(storeId),
    // Sin sede elegida todavía no hay qué pedir (antes salía `store_id=-1` y un 404).
    enabled: storeId > 0,
  })
}

/**
 * Admin → Preparaciones (SPEC-NEGOCIO §9.3). Detrás de `catalog.preps`
 * (que a su vez depende de `catalog.recipes`, `backend/app/core/features.py`):
 * con la función apagada se explica qué la prende, nunca una pantalla rota.
 */
export function PreparationsAdminPage(): React.JSX.Element {
  const { hasFeature } = useSession()
  const { activeStoreId, loading: storeLoading } = useStoreSelection()
  const [creating, setCreating] = useState(false)
  const [showInactive, setShowInactive] = useState(false)
  const queryClient = useQueryClient()

  const enabled = hasFeature("catalog.preps")

  const preparationsQuery = useQuery({
    queryKey: ["recipes", "preparations", activeStoreId, showInactive],
    queryFn: () => listPreparations(activeStoreId as number, { activeOnly: !showInactive }),
    enabled: enabled && activeStoreId !== null,
  })
  const ingredientOptionsQuery = useIngredientOptions(activeStoreId ?? -1)

  const createMutation = useMutation({
    mutationFn: (values: Parameters<typeof formValuesToPreparationIn>[0]) =>
      createPreparation(activeStoreId as number, formValuesToPreparationIn(values)),
    onSuccess: () => {
      setCreating(false)
      void queryClient.invalidateQueries({ queryKey: ["recipes", "preparations"] })
    },
  })

  if (storeLoading) {
    return <p className="p-4 text-sm text-muted-foreground">Cargando sedes…</p>
  }
  if (!enabled) {
    // Patrón 13, motivo «función apagada»: la entrada de navegación
    // desaparece con el flag, pero la URL sobrevive en un marcador y en los
    // avisos de Hoy.
    return (
      <FeatureOffEmptyState
        feature="Preparaciones en dos modos"
        flag="catalog.preps"
        description="Sin ella no hay preparaciones ni producción por lote: todo se explota directo a insumos. Depende además de «Fichas técnicas»."
      />
    )
  }
  if (activeStoreId === null) {
    return <p className="p-4 text-sm text-muted-foreground">Todavía no hay sedes creadas.</p>
  }

  const preparations = preparationsQuery.data ?? []
  const ingredientOptions = ingredientOptionsQuery.data ?? []
  const preparationOptions = preparations

  const columns: readonly DenseColumn<PreparationAdminOut>[] = [
    { key: "name", header: "Nombre", kind: "name", cell: (p) => p.name },
    {
      key: "mode",
      header: "Modo",
      // La palabra del negocio, no el enum: «Por lote» / «Explotada».
      cell: (p) => MODE_LABEL[p.mode],
    },
    {
      key: "yield",
      header: "Rendimiento",
      kind: "number",
      cell: (p) => `${p.standard_yield_qty} ${p.standard_yield_unit}`,
    },
    { key: "loss", header: "Merma esperada", kind: "number", cell: (p) => `${p.process_loss_pct} %` },
    {
      key: "shelf",
      header: "Vida útil",
      kind: "number",
      cell: (p) => (p.shelf_life_days !== null ? `${p.shelf_life_days} días` : "No vence"),
    },
    {
      key: "stock",
      header: "Stock",
      kind: "number",
      // En modo «explotada» no hay stock que llevar: es «—», no «0».
      cell: (p) =>
        p.mode === "batch" ? (
          <span className={cn(Number(p.current_stock ?? "0") <= 0 && "font-bold text-destructive")}>
            {p.current_stock ?? "0"}
          </span>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    },
    {
      key: "cost",
      header: "Costo por unidad",
      kind: "number",
      cell: (p) => <CostValue cost={p.unit_cost} costSource={p.cost_source} />,
    },
    {
      key: "actions",
      header: "",
      kind: "actions",
      cell: (p) => (
        <PreparationActions
          preparation={p}
          ingredientOptions={ingredientOptions}
          preparationOptions={preparationOptions}
        />
      ),
    },
  ]

  const inactive = preparations.filter((p) => !p.active).length
  const negativeBatch = preparations.filter(
    (p) => p.mode === "batch" && Number(p.current_stock ?? "0") <= 0,
  ).length

  return (
    <div className="space-y-4">
      <PageHeader
        name="Preparaciones"
        question="Qué se produce en cocina antes de vender, en qué modo descuenta sus insumos, y cuánto cuesta cada unidad."
        context={
          preparationsQuery.isSuccess
            ? [
                { label: "Preparaciones", value: preparations.length },
                { label: "Por lote en cero o negativo", value: negativeBatch },
              ]
            : undefined
        }
      />

      <p className="max-w-[80ch] text-sm text-muted-foreground">
        «Explotada» es el modo por defecto: sin registro de producción, una preparación en modo lote queda
        negativa y sus insumos se ven sobrevalorados. Usá «por lote» sólo para lo caro, perecedero o vendido
        por porción, y produciendo de verdad.
      </p>

      {preparationsQuery.isError ? (
        <p role="alert" className="text-sm text-destructive">
          {errorMessage(preparationsQuery.error)}
        </p>
      ) : (
        <DenseTable
          caption="Preparaciones de la sede"
          columns={columns}
          rows={preparations}
          rowKey={(p) => String(p.id)}
          rowInactive={(p) => !p.active}
          rowStatus={(p) => (p.mode === "batch" && Number(p.current_stock ?? "0") <= 0 ? "warning" : "none")}
          legend={PREPS_LEGEND}
          bar={
            <DenseTableBar
              shown={preparations.length}
              total={preparations.length}
              noun={showInactive ? "preparaciones" : "preparaciones activas"}
              hidden={
                preparationsQuery.isLoading
                  ? "contando…"
                  : showInactive
                    ? inactive > 0
                      ? `${inactive} inactivas, a la vista`
                      : undefined
                    : "las inactivas no se están mostrando"
              }
            >
              <div className="flex items-center gap-2">
                <Checkbox
                  id="show-inactive"
                  checked={showInactive}
                  onCheckedChange={(v) => setShowInactive(v === true)}
                />
                <Label htmlFor="show-inactive">Mostrar inactivas</Label>
              </div>
              <CsvExportButton
                href={preparationsCsvUrl({ storeId: activeStoreId, activeOnly: !showInactive })}
              />
              <Dialog open={creating} onOpenChange={setCreating}>
                <DialogTrigger render={<Button size="sm" />}>Nueva preparación</DialogTrigger>
                <DialogContent className="sm:max-w-2xl">
                  <DialogHeader>
                    <DialogTitle>Nueva preparación</DialogTitle>
                  </DialogHeader>
                  <PreparationForm
                    ingredients={ingredientOptions}
                    preparations={preparationOptions}
                    submitting={createMutation.isPending}
                    submitLabel="Crear"
                    onSubmit={(values) => createMutation.mutate(values)}
                  />
                  {createMutation.isError && (
                    <p role="alert" className="text-sm text-destructive">
                      {errorMessage(createMutation.error)}
                    </p>
                  )}
                </DialogContent>
              </Dialog>
            </DenseTableBar>
          }
          note={
            <>
              <b>Cambiar el modo no es un ajuste cosmético</b>: pasar de «por lote» a «explotada» cierra los
              lotes abiertos con un ajuste de conteo y no se deshace solo. Pide PIN de administrador en las
              dos direcciones.
            </>
          }
          empty={
            preparationsQuery.isLoading ? undefined : (
              <EmptyState
                title="Todavía no hay preparaciones"
                description="Creá la primera con «Nueva preparación». Una preparación es lo que la cocina arma antes de vender: una salsa, un caldo, una masa."
              />
            )
          }
        />
      )}
    </div>
  )
}
