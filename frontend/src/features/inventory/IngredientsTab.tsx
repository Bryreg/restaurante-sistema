import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useState } from "react"

import {
  createIngredient,
  deactivateIngredient,
  ingredientsCsvUrl,
  listIngredients,
  updateIngredient,
  type IngredientOut,
} from "@/api/inventory"
import { CostValue } from "@/components/CostValue"
import { CsvExportButton } from "@/components/CsvExportButton"
import { EmptyState } from "@/components/EmptyState"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { errorMessage } from "@/lib/errors"

import { formValuesToIngredientIn, formValuesToIngredientUpdateIn, IngredientForm } from "./IngredientForm"

const UNIT_LABEL: Record<string, string> = { g: "g", ml: "ml", unit: "unidad" }

function IngredientRow({
  ingredient,
  otherIngredients,
}: {
  ingredient: IngredientOut
  otherIngredients: { id: number; name: string }[]
}): React.JSX.Element {
  const queryClient = useQueryClient()
  const [editing, setEditing] = useState(false)

  const updateMutation = useMutation({
    mutationFn: (values: Parameters<typeof formValuesToIngredientUpdateIn>[0]) =>
      updateIngredient(ingredient.id, formValuesToIngredientUpdateIn(values)),
    onSuccess: () => {
      setEditing(false)
      void queryClient.invalidateQueries({ queryKey: ["inventory", "ingredients"] })
    },
  })

  const deactivateMutation = useMutation({
    mutationFn: () => deactivateIngredient(ingredient.id),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["inventory", "ingredients"] }),
  })

  return (
    <TableRow>
      <TableCell className="font-medium">
        {ingredient.name}
        {ingredient.key_item ? (
          <Badge variant="secondary" className="ml-2">
            Crítico
          </Badge>
        ) : null}
      </TableCell>
      <TableCell>{ingredient.category ?? "—"}</TableCell>
      <TableCell>{UNIT_LABEL[ingredient.base_unit] ?? ingredient.base_unit}</TableCell>
      <TableCell className="tabular-nums">{ingredient.yield_pct}%</TableCell>
      <TableCell className="tabular-nums">
        {ingredient.min_stock} {UNIT_LABEL[ingredient.base_unit] ?? ingredient.base_unit}
      </TableCell>
      <TableCell>
        <CostValue cost={ingredient.cost} costSource={ingredient.cost_source} />
      </TableCell>
      <TableCell>
        {ingredient.perishable ? <Badge variant="outline">Perecedero</Badge> : null}
        {ingredient.consumption_untracked ? (
          <Badge variant="outline" className="ml-1">
            No predecible
          </Badge>
        ) : null}
      </TableCell>
      <TableCell>{ingredient.active ? <Badge variant="secondary">Activo</Badge> : <Badge variant="outline">Inactivo</Badge>}</TableCell>
      <TableCell>
        <div className="flex flex-wrap gap-2">
          <Dialog open={editing} onOpenChange={setEditing}>
            <DialogTrigger render={<Button variant="outline" size="sm" />}>Editar</DialogTrigger>
            <DialogContent className="max-w-2xl">
              <DialogHeader>
                <DialogTitle>Editar {ingredient.name}</DialogTitle>
              </DialogHeader>
              <IngredientForm
                ingredient={ingredient}
                otherIngredients={otherIngredients}
                submitting={updateMutation.isPending}
                submitLabel="Guardar"
                serverError={updateMutation.isError ? errorMessage(updateMutation.error) : null}
                onSubmit={(values) => updateMutation.mutate(values)}
              />
            </DialogContent>
          </Dialog>
          {ingredient.active ? (
            <Button
              variant="outline"
              size="sm"
              disabled={deactivateMutation.isPending}
              onClick={() => deactivateMutation.mutate()}
            >
              Desactivar
            </Button>
          ) : null}
        </div>
      </TableCell>
    </TableRow>
  )
}

/**
 * Admin → Inventario → Insumos (SPEC-NEGOCIO §4.1 / §9.3). Nunca detrás de
 * `inventory.perpetual`/`inventory.waste`: `Ingredient` es dato maestro
 * (comentario declarado en `backend/app/inventory/router.py`) — pero la
 * pestaña vive adentro de "Inventario", que sí exige `inventory.perpetual`
 * (`inventoryFeature.adminNav`, ver `index.ts`), así que llegar acá ya
 * implica que la función está encendida.
 */
export function IngredientsTab({ storeId }: { storeId: number }): React.JSX.Element {
  const [creating, setCreating] = useState(false)
  const [showInactive, setShowInactive] = useState(false)
  const queryClient = useQueryClient()

  const query = useQuery({
    queryKey: ["inventory", "ingredients", storeId, showInactive],
    queryFn: () => listIngredients(storeId, { activeOnly: !showInactive }),
  })

  const createMutation = useMutation({
    mutationFn: (values: Parameters<typeof formValuesToIngredientIn>[0]) =>
      createIngredient(storeId, formValuesToIngredientIn(values)),
    onSuccess: () => {
      setCreating(false)
      void queryClient.invalidateQueries({ queryKey: ["inventory", "ingredients"] })
    },
  })

  const ingredients = query.data ?? []
  const otherIngredients = ingredients.map((i) => ({ id: i.id, name: i.name }))

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="max-w-2xl text-sm text-muted-foreground">
          Unidad de uso y de compra con su factor, rendimiento, costo con origen y umbral mínimo obligatorio. El
          costo nunca se muestra en $0 mudo: sin oficial ni estimado se dice «Sin costo».
        </p>
        <div className="flex items-center gap-3">
          <CsvExportButton href={ingredientsCsvUrl({ storeId, activeOnly: !showInactive })} />
          <Dialog open={creating} onOpenChange={setCreating}>
            <DialogTrigger render={<Button />}>Nuevo insumo</DialogTrigger>
            <DialogContent className="max-w-2xl">
              <DialogHeader>
                <DialogTitle>Nuevo insumo</DialogTitle>
              </DialogHeader>
              <IngredientForm
                otherIngredients={otherIngredients}
                submitting={createMutation.isPending}
                submitLabel="Crear"
                serverError={createMutation.isError ? errorMessage(createMutation.error) : null}
                onSubmit={(values) => createMutation.mutate(values)}
              />
            </DialogContent>
          </Dialog>
        </div>
      </div>

      <div className="flex items-center gap-2">
        <Checkbox id="ing-show-inactive" checked={showInactive} onCheckedChange={(v) => setShowInactive(v === true)} />
        <Label htmlFor="ing-show-inactive">Mostrar inactivos</Label>
      </div>

      {query.isLoading ? (
        <p className="text-sm text-muted-foreground">Cargando insumos…</p>
      ) : query.isError ? (
        <EmptyState
          role="alert"
          title="No se pudieron cargar los insumos"
          description={errorMessage(query.error)}
          action={{ label: "Reintentar", onClick: () => void query.refetch() }}
        />
      ) : ingredients.length === 0 ? (
        <EmptyState title="Todavía no hay insumos" description="Creá el primero con «Nuevo insumo»." />
      ) : (
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Nombre</TableHead>
                <TableHead>Categoría</TableHead>
                <TableHead>Unidad</TableHead>
                <TableHead>Rendimiento</TableHead>
                <TableHead>Mínimo</TableHead>
                <TableHead>Costo</TableHead>
                <TableHead>Notas</TableHead>
                <TableHead>Estado</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {ingredients.map((ingredient) => (
                <IngredientRow
                  key={ingredient.id}
                  ingredient={ingredient}
                  otherIngredients={otherIngredients.filter((o) => o.id !== ingredient.id)}
                />
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  )
}

export default IngredientsTab
