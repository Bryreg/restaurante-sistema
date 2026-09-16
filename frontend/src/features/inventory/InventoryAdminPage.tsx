import { useQuery } from "@tanstack/react-query"
import { useSearchParams } from "react-router-dom"

import { useSession } from "@/app/session"
import { useStoreSelection } from "@/app/storeContext"
import { listIngredients } from "@/api/inventory"
import { EmptyState } from "@/components/EmptyState"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"

import { IngredientsTab } from "./IngredientsTab"
import { MovementsWasteTab } from "./MovementsWasteTab"
import { StockTab } from "./StockTab"

type TabValue = "insumos" | "stock" | "movimientos"

function isTabValue(value: string | null): value is TabValue {
  return value === "insumos" || value === "stock" || value === "movimientos"
}

/**
 * Admin → Inventario (SPEC-NEGOCIO §9.3): Insumos, Stock, Movimientos y
 * mermas. Detrás de `inventory.perpetual` en la navegación
 * (`inventoryFeature.adminNav`) — si alguien llega igual a la ruta con la
 * función apagada, esta pantalla explica qué la prende en vez de romperse
 * contra un `400 FEATURE_DISABLED`.
 *
 * `tab`/`below_min`/`negative` en la query string: así "Hoy" puede enlazar
 * directo a "Stock" filtrado por negativos o bajo mínimo (cada alerta de
 * "Requiere tu atención" lleva a la pantalla que la resuelve, ya con el
 * filtro puesto — SPEC-NEGOCIO §9.3).
 */
export function InventoryAdminPage(): React.JSX.Element {
  const { hasFeature } = useSession()
  const { activeStoreId, loading: storeLoading } = useStoreSelection()
  const [searchParams, setSearchParams] = useSearchParams()

  const enabled = hasFeature("inventory.perpetual")
  const tabParam = searchParams.get("tab")
  const tab: TabValue = isTabValue(tabParam) ? tabParam : "insumos"

  const ingredientsQuery = useQuery({
    queryKey: ["inventory", "ingredients", activeStoreId, false],
    queryFn: () => listIngredients(activeStoreId as number, { activeOnly: true }),
    enabled: enabled && activeStoreId !== null,
  })

  if (storeLoading) {
    return <p className="p-4 text-sm text-muted-foreground">Cargando sedes…</p>
  }
  if (!enabled) {
    return (
      <EmptyState
        title="Inventario no está habilitado"
        description="Activá «Movimientos de inventario y stock teórico» en Admin → Funciones para usar esta pantalla."
      />
    )
  }
  if (activeStoreId === null) {
    return <p className="p-4 text-sm text-muted-foreground">Todavía no hay sedes creadas.</p>
  }

  const ingredients = ingredientsQuery.data ?? []

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-semibold">Inventario</h1>
        <p className="text-sm text-muted-foreground">Qué tengo y qué se me pierde.</p>
      </div>
      <Tabs
        value={tab}
        onValueChange={(value) => {
          const next = new URLSearchParams(searchParams)
          next.set("tab", value)
          setSearchParams(next, { replace: true })
        }}
      >
        <TabsList>
          <TabsTrigger value="insumos">Insumos</TabsTrigger>
          <TabsTrigger value="stock">Stock</TabsTrigger>
          <TabsTrigger value="movimientos">Movimientos y mermas</TabsTrigger>
        </TabsList>
        <TabsContent value="insumos" className="pt-4">
          <IngredientsTab storeId={activeStoreId} />
        </TabsContent>
        <TabsContent value="stock" className="pt-4">
          <StockTab
            storeId={activeStoreId}
            initialBelowMin={searchParams.get("below_min") === "1"}
            initialNegative={searchParams.get("negative") === "1"}
            initialCriticalOnly={searchParams.get("critical") === "1"}
          />
        </TabsContent>
        <TabsContent value="movimientos" className="pt-4">
          <MovementsWasteTab storeId={activeStoreId} ingredients={ingredients} />
        </TabsContent>
      </Tabs>
    </div>
  )
}

export default InventoryAdminPage
