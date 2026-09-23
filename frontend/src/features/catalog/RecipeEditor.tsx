import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useEffect, useRef, useState } from "react"
import { toast } from "sonner"

import { listProducts, type ProductAdminOut } from "@/api/catalog"
import { ApiError } from "@/api/client"
import {
  getProductRecipe,
  listIngredientOptions,
  listPreparations,
  putProductRecipe,
} from "@/api/recipes"
import { Cargando } from "@/components/Cargando"
import { EmptyState } from "@/components/EmptyState"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { errorMessage } from "@/lib/errors"
import { formatCOP } from "@/lib/money"

import {
  ComponentLinesEditor,
  componentLinesToDrafts,
  draftsToComponentLines,
  isLineComplete,
  type LineDraft,
} from "@/features/recipes/ComponentLinesEditor"
import { CostValue, FoodCostBadge } from "@/features/recipes/costDisplay"

/**
 * Editor de ficha técnica de un plato (SPEC-NEGOCIO §4.3 / §9.3 "Carta y
 * recetas"). Guardar sube la versión (`PUT /admin/products/{id}/recipe`) y
 * las versiones viejas se conservan — un ítem ya vendido sigue apuntando a
 * la suya, así que un reporte nunca revalora una venta pasada con la ficha
 * de hoy (snapshot, AGENTS.md). El costo teórico, el `cost_source` y el
 * food cost % los calcula el servidor: acá no se suma ni se divide nada.
 */
export function RecipeEditor({ storeId }: { storeId: number }): React.JSX.Element {
  const queryClient = useQueryClient()
  const [productId, setProductId] = useState<number | null>(null)
  const [lines, setLines] = useState<LineDraft[]>([])
  const [justSaved, setJustSaved] = useState<{ from: number; to: number } | null>(null)

  const productsQuery = useQuery({
    queryKey: ["catalog", "products", storeId],
    queryFn: () => listProducts(storeId),
  })
  const recipeQuery = useQuery({
    queryKey: ["recipes", "product-recipe", productId],
    queryFn: () => getProductRecipe(productId as number),
    enabled: productId !== null,
  })
  const ingredientsQuery = useQuery({
    queryKey: ["recipes", "ingredient-options", storeId],
    queryFn: () => listIngredientOptions(storeId),
  })
  const preparationsQuery = useQuery({
    queryKey: ["recipes", "preparations", storeId, false],
    queryFn: () => listPreparations(storeId, { activeOnly: true }),
  })

  // Qué versión reflejan `lines`/`justSaved` ahora mismo: `null` mientras no
  // se cargó nada. Guardar con éxito actualiza el caché de React Query
  // (`setQueryData`, para que `recipeQuery.data` quede al día en el resto de
  // la pantalla sin refetch), y ESE cambio de `recipeQuery.data` es la señal
  // que el efecto de abajo usaría para "sincronizar desde el servidor" — sin
  // esta guarda, la sincronización pisaría `justSaved` en el mismo render
  // que lo puso, y el aviso "v1 → v2" nunca llegaría a verse.
  const syncedVersionRef = useRef<number | null>(null)

  useEffect(() => {
    if (!recipeQuery.data) return
    if (syncedVersionRef.current === recipeQuery.data.version) return
    syncedVersionRef.current = recipeQuery.data.version
    setLines(componentLinesToDrafts(recipeQuery.data.lines))
    setJustSaved(null)
  }, [recipeQuery.data])

  const saveMutation = useMutation({
    mutationFn: () => {
      const current = recipeQuery.data
      if (productId === null || current === undefined) throw new Error("Elegí un plato primero")
      return putProductRecipe(productId, { version: current.version, lines: draftsToComponentLines(lines) })
    },
    onSuccess: (out) => {
      const prevVersion = recipeQuery.data?.version ?? 0
      syncedVersionRef.current = out.version
      setJustSaved({ from: prevVersion, to: out.version })
      toast.success(`Ficha guardada: versión ${prevVersion} → ${out.version}.`)
      queryClient.setQueryData(["recipes", "product-recipe", productId], out)
    },
    onError: (err) => {
      if (err instanceof ApiError && err.code === "RECIPE_VERSION_STALE") {
        // La versión que el servidor tiene de verdad no es la que asumimos:
        // invalidar fuerza un refetch, y como NO tocamos `syncedVersionRef`
        // acá, el efecto de arriba sí va a resincronizar `lines` con lo que
        // haya en el servidor — descarta el intento local, a propósito.
        void queryClient.invalidateQueries({ queryKey: ["recipes", "product-recipe", productId] })
      }
    },
  })

  if (productsQuery.isLoading) {
    return <Cargando texto="Cargando productos…" />
  }
  if (productsQuery.isError) {
    return (
      <p role="alert" className="text-sm text-destructive">
        {errorMessage(productsQuery.error)}
      </p>
    )
  }

  const products: ProductAdminOut[] = productsQuery.data ?? []
  const ingredients = ingredientsQuery.data ?? []
  const preparations = preparationsQuery.data ?? []

  return (
    <div className="space-y-4">
      <div className="max-w-sm space-y-1">
        <Label htmlFor="recipe-product">Plato</Label>
        <Select
          value={productId === null ? undefined : String(productId)}
          onValueChange={(value) => {
            setProductId(Number(value))
            setJustSaved(null)
            // Otro plato: la versión que se sincronizó no dice nada de éste.
            syncedVersionRef.current = null
          }}
        >
          <SelectTrigger id="recipe-product" className="w-full">
            <SelectValue placeholder="Elegí un plato" />
          </SelectTrigger>
          <SelectContent>
            {products.map((product) => (
              <SelectItem key={product.id} value={String(product.id)}>
                {product.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {productId === null ? (
        <p className="text-sm text-muted-foreground">Elegí un plato para ver o editar su ficha técnica.</p>
      ) : recipeQuery.isLoading ? (
        <Cargando texto="Cargando ficha…" />
      ) : recipeQuery.isError ? (
        <p role="alert" className="text-sm text-destructive">
          {errorMessage(recipeQuery.error)}
        </p>
      ) : recipeQuery.data ? (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-4 rounded-md border p-3">
            <div>
              <p className="text-xs text-muted-foreground">Versión vigente</p>
              <p className="text-sm font-medium">
                {recipeQuery.data.version === 0 ? "Sin ficha todavía" : `v${recipeQuery.data.version}`}
              </p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Costo teórico</p>
              <CostValue cost={recipeQuery.data.theoretical_cost} costSource={recipeQuery.data.cost_source} />
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Precio neto de impuesto</p>
              <p className="text-sm tabular-nums">{formatCOP(recipeQuery.data.net_price)}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Food cost</p>
              <FoodCostBadge pct={recipeQuery.data.food_cost_pct} />
            </div>
          </div>

          {justSaved ? (
            <p className="rounded-md border border-dashed p-2 text-xs text-muted-foreground">
              Se guardó como versión {justSaved.to} (antes v{justSaved.from}). La versión anterior se conserva: los
              ítems que ya se vendieron con ella siguen reportando ese costo — ningún reporte revalora una venta
              pasada con la ficha de hoy.
            </p>
          ) : null}

          {recipeQuery.data.version === 0 ? (
            <p className="text-sm text-muted-foreground">
              Este plato todavía no tiene ficha técnica: mientras no la tenga, el costo queda «sin costo» con origen
              visible y este plato aparece en «Cobertura de recetas» como un plato que no descuenta nada al venderse.
            </p>
          ) : null}

          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">Insumos y preparaciones de la ficha</legend>
            <ComponentLinesEditor
              idPrefix="recipe"
              lines={lines}
              onChange={(next) => {
                setLines(next)
                setJustSaved(null)
              }}
              ingredients={ingredients}
              preparations={preparations}
            />
          </fieldset>

          <div className="flex items-center gap-3">
            <Button
              type="button"
              disabled={saveMutation.isPending || !lines.some(isLineComplete)}
              onClick={() => saveMutation.mutate()}
            >
              Guardar ficha
            </Button>
            {saveMutation.isError && (
              <p role="alert" className="text-sm text-destructive">
                {errorMessage(saveMutation.error)}
              </p>
            )}
          </div>
        </div>
      ) : (
        <EmptyState title="No se pudo cargar la ficha de este plato" />
      )}
    </div>
  )
}
