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
import { Cargando } from "@/components/Cargando"
import { CsvExportButton } from "@/components/CsvExportButton"
import {
  DenseTable,
  DenseTableBar,
  FeatureOffEmptyState,
  MenuDeFila,
  PageHeader,
  type DenseColumn,
  type LegendEntry,
} from "@/components/admin"
import { EmptyState } from "@/components/EmptyState"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { DropdownMenuItem } from "@/components/ui/dropdown-menu"
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

/**
 * Las acciones de la fila —Editar, Cambiar modo y, en modo lote, Ver lotes—
 * en el menú «⋯» (mapa de pantallas, regla 3: eran hasta tres botones por
 * fila). Los tres diálogos son **controlados**: los abre el ítem del menú.
 */
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
    <>
      <MenuDeFila nombre={preparation.name}>
        <DropdownMenuItem onClick={() => setEditing(true)}>Editar</DropdownMenuItem>
        <DropdownMenuItem onClick={() => setSwitching(true)}>Cambiar modo</DropdownMenuItem>
        {/* «Ver lotes» SÓLO existe en modo «por lote»: un control que aparece y
            desaparece con el estado de la fila (`docs/INVENTARIO-CONTROLES.md`
            § 23). */}
        {preparation.mode === "batch" && (
          <DropdownMenuItem onClick={() => setBatches(true)}>Ver lotes</DropdownMenuItem>
        )}
      </MenuDeFila>
      <Dialog open={editing} onOpenChange={setEditing}>
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
      {switching && (
        <PrepModeSwitchDialog preparation={preparation} open={switching} onOpenChange={setSwitching} />
      )}
      {batches && <PrepBatchesPanel preparation={preparation} open={batches} onOpenChange={setBatches} />}
    </>
  )
}

/** Rojo cuando hay alguna (faltante que alguien tiene que producir); neutro en cero. */
function CifraDeLotes({ label, value }: { label: string; value: number }): React.JSX.Element {
  return (
    <p className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
      <span
        className={cn(
          "text-4xl leading-none font-bold tracking-tight tabular-nums",
          value > 0 ? "text-destructive" : "text-foreground",
        )}
      >
        {value}
      </span>
      <span className="text-base font-medium">{label.toLowerCase()}</span>
    </p>
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
    return <Cargando texto="Cargando sedes…" className="p-4" />
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

  // Cinco a la vista (mapa de pantallas, regla 3): nombre, modo,
  // rendimiento, stock y costo. La merma esperada y la vida útil son de la
  // ficha, no de la decisión del día: quedan detrás de «Más columnas».
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
    { key: "loss", header: "Merma esperada", kind: "number", secondary: true, cell: (p) => `${p.process_loss_pct} %` },
    {
      key: "shelf",
      header: "Vida útil",
      kind: "number",
      secondary: true,
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
          preparationsQuery.isSuccess ? [{ label: "Preparaciones", value: preparations.length }] : undefined
        }
      />

      {/* La cifra protagonista (regla 1): las preparaciones por lote en cero
          o negativo, que son las que alguien tiene que producir ya. Antes
          era el segundo dato de la franja de contexto. Es un recuento de
          filas, no una cifra nueva. */}
      {preparationsQuery.isSuccess ? (
        <CifraDeLotes label="Por lote en cero o negativo" value={negativeBatch} />
      ) : null}

      {/* Por qué «explotada» es el default, plegado (regla 2): se lee una
          vez, no cada vez que se abre la pantalla. */}
      <details className="text-sm text-muted-foreground">
        <summary className="w-fit cursor-pointer font-medium select-none hover:text-foreground">
          ¿Explotada o por lote?
        </summary>
        <p className="mt-1 max-w-[80ch]">
          «Explotada» es el modo por defecto: sin registro de producción, una preparación en modo lote queda
          negativa y sus insumos se ven sobrevalorados. Usá «por lote» sólo para lo caro, perecedero o vendido
          por porción, y produciendo de verdad.
        </p>
      </details>

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
