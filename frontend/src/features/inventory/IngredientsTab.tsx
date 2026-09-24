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
import { DenseTable, DenseTableBar, MenuDeFila, type DenseColumn, type LegendEntry } from "@/components/admin"
import { CostValue } from "@/components/CostValue"
import { CsvExportButton } from "@/components/CsvExportButton"
import { EmptyState } from "@/components/EmptyState"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { DropdownMenuItem } from "@/components/ui/dropdown-menu"
import { Label } from "@/components/ui/label"
import { errorMessage } from "@/lib/errors"
import { formatCantidad } from "@/lib/format"

import { formValuesToIngredientIn, formValuesToIngredientUpdateIn, IngredientForm } from "./IngredientForm"

const UNIT_LABEL: Record<string, string> = { g: "g", ml: "ml", unit: "unidad" }

/** Las marcas de la ficha, en la palabra del negocio y no en el campo del
 * modelo (patrón 8c). Cada una cambia cómo se comporta el insumo en otra
 * pantalla, así que se ven acá y no sólo adentro del formulario. */
function Marks({ ingredient }: { ingredient: IngredientOut }): React.JSX.Element {
  const marks = [
    ingredient.key_item ? "Crítico" : null,
    ingredient.perishable ? "Perecedero" : null,
    ingredient.consumption_untracked ? "No predecible" : null,
  ].filter((m): m is string => m !== null)
  if (marks.length === 0) return <span className="text-muted-foreground">—</span>
  return (
    <span className="inline-flex items-center gap-1">
      {marks.map((mark) => (
        <span key={mark} className="rounded border px-1 py-px text-[0.7rem] text-muted-foreground">
          {mark}
        </span>
      ))}
    </span>
  )
}

/**
 * Las acciones de la fila, en el menú «⋯» (mapa de pantallas, regla 3: dos
 * botones por fila en 54 filas eran 108 botones, y la vista se iba a ellos
 * antes que a los datos). Viven en su propio componente porque cada una
 * tiene su mutación y su diálogo: lo que resuelve este componente es que
 * los `useMutation` de una fila no se cuelen en la tabla entera. El diálogo
 * de edición es **controlado**: lo abre el ítem del menú, no un trigger.
 */
function IngredientActions({
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
      void queryClient.invalidateQueries({
        queryKey: ["inventory", "ingredients"],
      })
    },
  })

  const deactivateMutation = useMutation({
    mutationFn: () => deactivateIngredient(ingredient.id),
    onSuccess: () =>
      void queryClient.invalidateQueries({
        queryKey: ["inventory", "ingredients"],
      }),
  })

  return (
    <>
      <MenuDeFila nombre={ingredient.name}>
        <DropdownMenuItem onClick={() => setEditing(true)}>Editar</DropdownMenuItem>
        {/* Desactivar sólo existe si el insumo está activo: el control que
            aparece y desaparece con el estado de la fila es de los que un
            rediseño pierde más fácil (`docs/INVENTARIO-CONTROLES.md` § 21). */}
        {ingredient.active ? (
          <DropdownMenuItem disabled={deactivateMutation.isPending} onClick={() => deactivateMutation.mutate()}>
            Desactivar
          </DropdownMenuItem>
        ) : null}
      </MenuDeFila>
      <Dialog open={editing} onOpenChange={setEditing}>
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
    </>
  )
}

const LEGEND: readonly LegendEntry[] = [
  {
    term: "Sin costo",
    meaning: (
      <>
        no es <b>$ 0</b> — el insumo no tiene costo oficial ni estimado. No se sabe cuánto vale, y por eso no
        entra en ninguna suma de costo.
      </>
    ),
  },
  {
    term: "Crítico",
    meaning: "entra al conteo rápido: es lo que se cuenta cuando no se cuenta todo.",
  },
  {
    term: "No predecible",
    meaning: "su consumo no se puede anticipar, así que no se le reclama varianza.",
  },
]

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
      void queryClient.invalidateQueries({
        queryKey: ["inventory", "ingredients"],
      })
    },
  })

  const ingredients = query.data ?? []
  const otherIngredients = ingredients.map((i) => ({ id: i.id, name: i.name }))
  const inactive = ingredients.filter((i) => !i.active).length

  const columns: readonly DenseColumn<IngredientOut>[] = [
    { key: "name", header: "Nombre", kind: "name", cell: (i) => i.name },
    { key: "category", header: "Categoría", cell: (i) => i.category ?? "—" },
    // Unidad y rendimiento, detrás de «Más columnas» (regla 3): el mínimo
    // ya lleva la unidad, y el rendimiento se toca al editar la ficha.
    {
      key: "unit",
      header: "Unidad",
      secondary: true,
      cell: (i) => UNIT_LABEL[i.base_unit] ?? i.base_unit,
    },
    {
      key: "yield",
      header: "Rendimiento",
      kind: "number",
      secondary: true,
      cell: (i) => formatCantidad(i.yield_pct, "%"),
    },
    {
      key: "min",
      header: "Mínimo",
      kind: "number",
      cell: (i) => formatCantidad(i.min_stock, UNIT_LABEL[i.base_unit] ?? i.base_unit),
    },
    {
      key: "cost",
      header: "Costo",
      kind: "number",
      cell: (i) => <CostValue cost={i.cost} costSource={i.cost_source} />,
    },
    { key: "marks", header: "Marcas", cell: (i) => <Marks ingredient={i} /> },
    {
      key: "actions",
      header: "",
      kind: "actions",
      cell: (i) => (
        <IngredientActions ingredient={i} otherIngredients={otherIngredients.filter((o) => o.id !== i.id)} />
      ),
    },
  ]

  if (query.isError) {
    return (
      <EmptyState
        role="alert"
        title="No se pudieron cargar los insumos"
        description={errorMessage(query.error)}
        action={{ label: "Reintentar", onClick: () => void query.refetch() }}
      />
    )
  }

  // Los filtros son **armazón**, no datos: cargando se conservan (patrón
  // 13, «cargando conserva el armazón y esqueletea sólo los datos»). Si
  // desaparecieran mientras llega la respuesta, lo que la persona acaba de
  // elegir parpadearía en cada consulta.
  const filters = (
    <>
      <div className="flex items-center gap-2">
        <Checkbox
          id="ing-show-inactive"
          checked={showInactive}
          onCheckedChange={(v) => setShowInactive(v === true)}
        />
        <Label htmlFor="ing-show-inactive">Mostrar inactivos</Label>
      </div>
      <CsvExportButton href={ingredientsCsvUrl({ storeId, activeOnly: !showInactive })} />
      {/* Con pestañas, la acción primaria de la pantalla baja a la
                  barra de la tabla (`docs/PATRONES-ADMIN.md` § 2). */}
      <Dialog open={creating} onOpenChange={setCreating}>
        <DialogTrigger render={<Button size="sm" />}>Nuevo insumo</DialogTrigger>
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
    </>
  )

  return (
    <div className="space-y-3">
      <DenseTable
        caption="Insumos de la sede"
        columns={columns}
        rows={ingredients}
        rowKey={(i) => String(i.id)}
        // Un insumo inactivo se sigue viendo —apagado y rayado—, nunca se
        // borra: «se desactiva, nunca se borra» es regla del proyecto.
        rowInactive={(i) => !i.active}
        legend={LEGEND}
        bar={
          <DenseTableBar
            shown={ingredients.length}
            total={ingredients.length}
            noun={showInactive ? "insumos" : "insumos activos"}
            hidden={
              query.isLoading
                ? "contando…"
                : showInactive
                  ? inactive > 0
                    ? `${inactive} inactivos, a la vista`
                    : undefined
                  : "los inactivos no se están mostrando"
            }
          >
            {filters}
          </DenseTableBar>
        }
        note={
          <>
            Unidad de uso y de compra con su factor, rendimiento, costo con origen y umbral mínimo
            obligatorio. <b>Desactivar no borra</b>: el insumo deja de ofrecerse y sus movimientos viejos
            quedan enteros.
          </>
        }
        empty={
          query.isLoading ? undefined : (
            <EmptyState
              title="Todavía no hay insumos"
              description="Creá el primero con «Nuevo insumo». Sin insumos no hay stock, ni recetas que descuenten, ni conteos que aplicar."
            />
          )
        }
      />
    </div>
  )
}

export default IngredientsTab
