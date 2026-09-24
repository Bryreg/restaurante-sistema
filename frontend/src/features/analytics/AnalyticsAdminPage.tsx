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

/** Las tres secciones del armazón por las que se entra a esta pantalla. */
type Seccion = "ingenieria" | "varianza" | "reposicion"

const SECCION_DE: Record<TabValue, Seccion> = {
  "ingenieria-menu": "ingenieria",
  varianza: "varianza",
  "salud-sostenida": "varianza",
  reposicion: "reposicion",
}

/**
 * El nombre y la pregunta de cada sección. «Sólo lectura» y «el costo viaja
 * congelado en el ítem vendido» eran dos frases en la franja de contexto;
 * explican, no dan un dato, así que pasaron a la pregunta plegada
 * (mapa de pantallas, regla 2).
 */
const SECCION: Record<Seccion, { label: string; question: string }> = {
  ingenieria: {
    label: "Ingeniería de menú",
    question:
      "Qué plato conviene sacar, cuál subir de precio, cuál promocionar y cuál dejar como está. Es sólo lectura: acá no se cambia nada, se mira. El costo viaja congelado en el ítem vendido: ninguna de estas tablas revalora una venta pasada con la carta de hoy.",
  },
  varianza: {
    label: "Varianza y salud",
    question:
      "Qué se está yendo sin que lo veas: cuánto insumo salió de más o de menos por plato entre dos conteos, y si la brecha del food cost se sostiene en rojo. Es sólo lectura: acá no se cambia nada, se mira.",
  },
  reposicion: {
    label: "Reposición sugerida",
    question:
      "Qué hay que pedir antes de que falte, con el consumo de cada insumo y los días que tarda su proveedor. Es sólo lectura: acá no se cambia nada, se mira.",
  },
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

  // La fila de pestañas de esta pantalla sólo muestra las de la sección del
  // armazón por la que se entró (`app/AdminLayout.tsx`, `RAIL`): «Ingeniería
  // de menú» vive en Informes, «Varianza y salud» y «Reposición» en
  // Inventario, y las secciones ya llevan sus propias pestañas arriba. Repetir
  // acá las cuatro era una segunda fila de navegación que contradecía a la
  // primera. Los `?tab=` no cambian.
  const seccion = SECCION_DE[tab]
  const { label: nombre, question } = SECCION[seccion]

  function cambiarPestana(value: string) {
    const next = new URLSearchParams(searchParams)
    next.set("tab", value)
    setSearchParams(next, { replace: true })
  }

  return (
    <div className="space-y-4">
      <PageHeader name={nombre} question={question}>
      <Tabs value={tab} onValueChange={cambiarPestana}>
        {/* Sólo «Varianza y salud» tiene dos pestañas propias; Ingeniería de
            menú y Reposición son una pantalla cada una, sin fila. */}
        {seccion === "varianza" ? (
          <TabsList className="h-auto flex-wrap">
            <TabsTrigger value="varianza">Varianza por plato</TabsTrigger>
            <TabsTrigger value="salud-sostenida">Salud sostenida</TabsTrigger>
          </TabsList>
        ) : null}
        {menuEngineeringEnabled ? (
          <TabsContent value="ingenieria-menu" className="pt-2">
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
          <TabsContent value="reposicion" className="pt-2">
            <ReplenishmentTab storeId={activeStoreId} />
          </TabsContent>
        ) : null}
      </Tabs>
      </PageHeader>
    </div>
  )
}

export default AnalyticsAdminPage
