import { useQuery } from "@tanstack/react-query"
import { useSearchParams } from "react-router-dom"

import { useSession } from "@/app/session"
import { useStoreSelection } from "@/app/storeContext"
import { listIngredients } from "@/api/inventory"
import { EmptyState } from "@/components/EmptyState"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"

import { ControlHealthTab } from "./ControlHealthTab"
import { CountsTab } from "./CountsTab"
import { IngredientsTab } from "./IngredientsTab"
import { LotsTab } from "./LotsTab"
import { MovementsWasteTab } from "./MovementsWasteTab"
import { StockTab } from "./StockTab"
import { VarianceTab } from "./VarianceTab"

const ALL_TABS = ["insumos", "stock", "movimientos", "conteos", "varianza", "lotes", "salud"] as const
type TabValue = (typeof ALL_TABS)[number]

function isTabValue(value: string | null): value is TabValue {
  return (ALL_TABS as readonly string[]).includes(value ?? "")
}

/**
 * Admin → Inventario (SPEC-NEGOCIO §9.3): Insumos, Stock, Movimientos y
 * mermas, y — pedido 2b — Conteos, Varianza, Lotes y Salud del control.
 * Detrás de `inventory.perpetual` en la navegación
 * (`inventoryFeature.adminNav`) — si alguien llega igual a la ruta con la
 * función apagada, esta pantalla explica qué la prende en vez de romperse
 * contra un `400 FEATURE_DISABLED`.
 *
 * Las cuatro pestañas de 2b se arman desde `hasFeature` de la sesión, cada
 * una detrás de SU flag (`app/core/features.py`): `inventory.counts` y
 * `inventory.lots` (`inventory.perpetual` ya lo exige el gate de toda la
 * página); `inventory.variance` requiere `inventory.counts`, y
 * "Salud del control" comparte esa misma flag porque
 * `GET /admin/control-health` está detrás de `inventory.variance` en el
 * backend (`app/inventory/router.py::get_control_health`). Si el `tab=` de
 * la URL apunta a una pestaña apagada, cae a "Insumos" en vez de mostrar un
 * panel roto.
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
  // Las pestañas se arman desde los flags de la sesión (AGENTS.md): cada
  // dependencia YA está declarada en `app/core/features.py` y acá sólo se
  // refleja — `inventory.counts`/`inventory.lots` requieren
  // `inventory.perpetual` (ya cubierto por el gate de toda la página);
  // `inventory.variance` requiere `inventory.counts`.
  const countsEnabled = hasFeature("inventory.counts")
  const varianceEnabled = hasFeature("inventory.variance")
  const lotsEnabled = hasFeature("inventory.lots")

  const tabParam = searchParams.get("tab")
  const requestedTab: TabValue = isTabValue(tabParam) ? tabParam : "insumos"
  const tabAvailable: Record<TabValue, boolean> = {
    insumos: true,
    stock: true,
    movimientos: true,
    conteos: countsEnabled,
    varianza: varianceEnabled,
    lotes: lotsEnabled,
    salud: varianceEnabled,
  }
  const tab: TabValue = tabAvailable[requestedTab] ? requestedTab : "insumos"

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
        <TabsList className="h-auto flex-wrap">
          <TabsTrigger value="insumos">Insumos</TabsTrigger>
          <TabsTrigger value="stock">Stock</TabsTrigger>
          <TabsTrigger value="movimientos">Movimientos y mermas</TabsTrigger>
          {countsEnabled ? <TabsTrigger value="conteos">Conteos</TabsTrigger> : null}
          {varianceEnabled ? <TabsTrigger value="varianza">Varianza</TabsTrigger> : null}
          {lotsEnabled ? <TabsTrigger value="lotes">Lotes</TabsTrigger> : null}
          {varianceEnabled ? <TabsTrigger value="salud">Salud del control</TabsTrigger> : null}
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
        {countsEnabled ? (
          <TabsContent value="conteos" className="pt-4">
            <CountsTab storeId={activeStoreId} />
          </TabsContent>
        ) : null}
        {varianceEnabled ? (
          <TabsContent value="varianza" className="pt-4">
            <VarianceTab storeId={activeStoreId} />
          </TabsContent>
        ) : null}
        {lotsEnabled ? (
          <TabsContent value="lotes" className="pt-4">
            <LotsTab storeId={activeStoreId} ingredients={ingredients} />
          </TabsContent>
        ) : null}
        {varianceEnabled ? (
          <TabsContent value="salud" className="pt-4">
            <ControlHealthTab storeId={activeStoreId} />
          </TabsContent>
        ) : null}
      </Tabs>
    </div>
  )
}

export default InventoryAdminPage
