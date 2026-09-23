/**
 * Admin → Analítica (T4, spec.md § "qué conviene vender"): ingeniería de
 * menú, varianza por plato, salud sostenida (D-1) y reposición sugerida.
 *
 * spec.md § 2 sólo declara dos flags para todo T4 (`analytics.menu_
 * engineering`, `inventory.replenishment`) y da a entender que "varianza
 * por plato"/"salud sostenida" comparten la primera. **Verificado por
 * lectura directa de `app/analytics/router.py`**: esas dos rutas están
 * detrás de `require_feature("inventory.variance")` (la MISMA función que
 * ya gatea "Varianza"/"Salud del control" en `features/inventory/`, no una
 * nueva) — no de `analytics.menu_engineering`. Esta pantalla gatea contra lo
 * que el backend de verdad exige, no contra la lectura de la prosa del
 * contrato: una pestaña gateada mal es una capacidad inalcanzable aunque el
 * código compile. Ver gaps del entregable.
 */
import { useSearchParams } from "react-router-dom"

import { useSession } from "@/app/session"
import { useStoreSelection } from "@/app/storeContext"
import { Cargando } from "@/components/Cargando"
import { PageHeader } from "@/components/admin"
import { EmptyState } from "@/components/EmptyState"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"

import { MenuEngineeringTab } from "./MenuEngineeringTab"
import { ReplenishmentTab } from "./ReplenishmentTab"
import { SustainedHealthTab } from "./SustainedHealthTab"
import { VarianceByDishTab } from "./VarianceByDishTab"

const ALL_TABS = ["ingenieria-menu", "varianza", "salud-sostenida", "reposicion"] as const
type TabValue = (typeof ALL_TABS)[number]

function isTabValue(value: string | null): value is TabValue {
  return (ALL_TABS as readonly string[]).includes(value ?? "")
}

export function AnalyticsAdminPage(): React.JSX.Element {
  const { hasFeature } = useSession()
  const { activeStoreId, loading: storeLoading } = useStoreSelection()
  const [searchParams, setSearchParams] = useSearchParams()

  const menuEngineeringEnabled = hasFeature("analytics.menu_engineering")
  const varianceEnabled = hasFeature("inventory.variance")
  const replenishmentEnabled = hasFeature("inventory.replenishment")
  const enabled = menuEngineeringEnabled || varianceEnabled || replenishmentEnabled

  const firstAvailableTab: TabValue = menuEngineeringEnabled ? "ingenieria-menu" : varianceEnabled ? "varianza" : "reposicion"
  const tabParam = searchParams.get("tab")
  const requestedTab: TabValue = isTabValue(tabParam) ? tabParam : firstAvailableTab
  const tabAvailable: Record<TabValue, boolean> = {
    "ingenieria-menu": menuEngineeringEnabled,
    varianza: varianceEnabled,
    "salud-sostenida": varianceEnabled,
    reposicion: replenishmentEnabled,
  }
  const tab: TabValue = tabAvailable[requestedTab] ? requestedTab : firstAvailableTab

  if (storeLoading) {
    return <Cargando texto="Cargando sedes…" className="p-4" />
  }
  if (!enabled) {
    // § 13 · Vacío por **función apagada**: nombra la función y lleva a
    // encenderla. Es el único motivo que entiende que **la URL sobrevive al
    // flag**: la entrada de navegación desaparece, pero el marcador del dueño
    // y los avisos de Hoy siguen apuntando acá. Son tres flags, así que se
    // nombran los tres en vez de inventar uno solo.
    return (
      <EmptyState
        reason="feature-off"
        title="Analítica no está habilitada"
        description="Activá «Ingeniería de menú», «Varianza de inventario» o «Reposición sugerida» en Admin → Funciones para usar esta pantalla."
        action={{ label: "Encenderla en Funciones", to: "/admin/features" }}
      />
    )
  }
  if (activeStoreId === null) {
    return <p className="p-4 text-sm text-muted-foreground">Todavía no hay sedes creadas.</p>
  }

  return (
    <div className="space-y-4">
      <PageHeader
        name="Analítica"
        question="Qué conviene vender, qué se está yendo sin que lo veas y qué hay que reponer antes de que falte."
        context={[
          { label: "Sólo lectura: acá no se cambia nada, se mira." },
          {
            label: "Sobre el costo congelado en la venta",
            title: "El costo viaja congelado en el ítem vendido: ninguna de estas tablas revalora una venta pasada con la carta de hoy.",
          },
        ]}
      >
      <Tabs
        value={tab}
        onValueChange={(value) => {
          const next = new URLSearchParams(searchParams)
          next.set("tab", value)
          setSearchParams(next, { replace: true })
        }}
      >
        <TabsList className="h-auto flex-wrap">
          {menuEngineeringEnabled ? <TabsTrigger value="ingenieria-menu">Ingeniería de menú</TabsTrigger> : null}
          {varianceEnabled ? <TabsTrigger value="varianza">Varianza por plato</TabsTrigger> : null}
          {varianceEnabled ? <TabsTrigger value="salud-sostenida">Salud sostenida</TabsTrigger> : null}
          {replenishmentEnabled ? <TabsTrigger value="reposicion">Reposición sugerida</TabsTrigger> : null}
        </TabsList>
        {menuEngineeringEnabled ? (
          <TabsContent value="ingenieria-menu" className="pt-4">
            <MenuEngineeringTab storeId={activeStoreId} />
          </TabsContent>
        ) : null}
        {varianceEnabled ? (
          <TabsContent value="varianza" className="pt-4">
            <VarianceByDishTab storeId={activeStoreId} />
          </TabsContent>
        ) : null}
        {varianceEnabled ? (
          <TabsContent value="salud-sostenida" className="pt-4">
            <SustainedHealthTab storeId={activeStoreId} />
          </TabsContent>
        ) : null}
        {replenishmentEnabled ? (
          <TabsContent value="reposicion" className="pt-4">
            <ReplenishmentTab storeId={activeStoreId} />
          </TabsContent>
        ) : null}
      </Tabs>
      </PageHeader>
    </div>
  )
}

export default AnalyticsAdminPage
