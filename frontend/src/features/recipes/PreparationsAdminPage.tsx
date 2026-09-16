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
import { EmptyState } from "@/components/EmptyState"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { errorMessage } from "@/lib/errors"

import { CostValue } from "./costDisplay"
import type { LineIngredientOption, LinePreparationOption } from "./ComponentLinesEditor"
import { formValuesToPreparationIn, formValuesToPreparationUpdateIn, PreparationForm } from "./PreparationForm"
import { PrepBatchesPanel } from "./PrepBatchesPanel"
import { PrepModeSwitchDialog } from "./PrepModeSwitchDialog"

const MODE_LABEL: Record<string, string> = { batch: "Por lote", exploded: "Explotada" }

function PreparationRow({
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
    <TableRow>
      <TableCell className="font-medium">{preparation.name}</TableCell>
      <TableCell>
        <Badge variant={preparation.mode === "batch" ? "secondary" : "outline"}>{MODE_LABEL[preparation.mode]}</Badge>
      </TableCell>
      <TableCell className="tabular-nums">
        {preparation.standard_yield_qty} {preparation.standard_yield_unit}
      </TableCell>
      <TableCell className="tabular-nums">{preparation.process_loss_pct}%</TableCell>
      <TableCell className="tabular-nums">
        {preparation.shelf_life_days !== null ? `${preparation.shelf_life_days} días` : "No vence"}
      </TableCell>
      <TableCell className="tabular-nums">
        {preparation.mode === "batch" ? (preparation.current_stock ?? "0") : "—"}
      </TableCell>
      <TableCell>
        <CostValue cost={preparation.unit_cost} costSource={preparation.cost_source} />
      </TableCell>
      <TableCell>{preparation.active ? <Badge variant="secondary">Activa</Badge> : <Badge variant="outline">Inactiva</Badge>}</TableCell>
      <TableCell>
        <div className="flex flex-wrap gap-2">
          <Dialog open={editing} onOpenChange={setEditing}>
            <DialogTrigger render={<Button variant="outline" size="sm" />}>Editar</DialogTrigger>
            <DialogContent className="max-w-2xl">
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
          {preparation.mode === "batch" && (
            <Button variant="outline" size="sm" onClick={() => setBatches(true)}>
              Ver lotes
            </Button>
          )}
        </div>
        {switching && (
          <PrepModeSwitchDialog preparation={preparation} open={switching} onOpenChange={setSwitching} />
        )}
        {batches && <PrepBatchesPanel preparation={preparation} open={batches} onOpenChange={setBatches} />}
      </TableCell>
    </TableRow>
  )
}

function useIngredientOptions(storeId: number) {
  return useQuery({
    queryKey: ["recipes", "ingredient-options", storeId],
    queryFn: () => listIngredientOptions(storeId),
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
    return (
      <EmptyState
        title="Preparaciones no está habilitada"
        description="Activá «Preparaciones en dos modos» en Admin → Funciones para usar esta pantalla. Depende de «Fichas técnicas»."
      />
    )
  }
  if (activeStoreId === null) {
    return <p className="p-4 text-sm text-muted-foreground">Todavía no hay sedes creadas.</p>
  }

  const preparations = preparationsQuery.data ?? []
  const ingredientOptions = ingredientOptionsQuery.data ?? []
  const preparationOptions = preparations

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold">Preparaciones</h1>
          <p className="max-w-2xl text-sm text-muted-foreground">
            «Explotada» es el modo por defecto: sin registro de producción, una preparación en modo lote queda
            negativa y sus insumos se ven sobrevalorados. Usá «por lote» sólo para lo caro, perecedero o vendido por
            porción, y produciendo de verdad.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <CsvExportButton href={preparationsCsvUrl({ storeId: activeStoreId, activeOnly: !showInactive })} />
          <Dialog open={creating} onOpenChange={setCreating}>
            <DialogTrigger render={<Button />}>Nueva preparación</DialogTrigger>
            <DialogContent className="max-w-2xl">
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
        </div>
      </div>

      <div className="flex items-center gap-2">
        <Checkbox id="show-inactive" checked={showInactive} onCheckedChange={(v) => setShowInactive(v === true)} />
        <Label htmlFor="show-inactive">Mostrar inactivas</Label>
      </div>

      {preparationsQuery.isLoading ? (
        <p className="text-sm text-muted-foreground">Cargando preparaciones…</p>
      ) : preparationsQuery.isError ? (
        <p role="alert" className="text-sm text-destructive">
          {errorMessage(preparationsQuery.error)}
        </p>
      ) : preparations.length === 0 ? (
        <EmptyState title="Todavía no hay preparaciones" description="Creá la primera con «Nueva preparación»." />
      ) : (
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Nombre</TableHead>
                <TableHead>Modo</TableHead>
                <TableHead>Rendimiento estándar</TableHead>
                <TableHead>Merma esperada</TableHead>
                <TableHead>Vida útil</TableHead>
                <TableHead>Stock</TableHead>
                <TableHead>Costo por unidad</TableHead>
                <TableHead>Estado</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {preparations.map((preparation) => (
                <PreparationRow
                  key={preparation.id}
                  preparation={preparation}
                  ingredientOptions={ingredientOptions}
                  preparationOptions={preparationOptions}
                />
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  )
}
