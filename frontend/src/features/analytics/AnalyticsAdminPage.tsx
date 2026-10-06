/**
 * Admin → Analítica: ingeniería de menú y reposición sugerida.
 *
 * «Varianza por plato» y «Salud sostenida» vivían acá, con su propia entrada
 * del rail («Varianza y salud»); la varianza de inventario quedó en un solo
 * lugar (limpieza 2026-10): Inventario › Varianza (por insumo y por plato) e
 * Inventario › Salud del control (food cost y si la brecha se sostiene). Los
 * `?tab=` viejos redirigen allá, para que un marcador no muera.
 */
import { Navigate, useSearchParams } from "react-router-dom"

import { useSession } from "@/app/session"
import { useStoreSelection } from "@/app/storeContext"
import { Cargando } from "@/components/Cargando"
import { PageHeader } from "@/components/admin"
import { EmptyState } from "@/components/EmptyState"
import { Tabs, TabsContent } from "@/components/ui/tabs"

import { MenuEngineeringTab } from "./MenuEngineeringTab"
import { ReplenishmentTab } from "./ReplenishmentTab"

const ALL_TABS = ["ingenieria-menu", "reposicion"] as const
type TabValue = (typeof ALL_TABS)[number]

function isTabValue(value: string | null): value is TabValue {
  return (ALL_TABS as readonly string[]).includes(value ?? "")
}

/** Las dos secciones del armazón por las que se entra a esta pantalla. */
type Seccion = "ingenieria" | "reposicion"

const SECCION_DE: Record<TabValue, Seccion> = {
  "ingenieria-menu": "ingenieria",
  reposicion: "reposicion",
}

/** Las pestañas que se mudaron a Inventario, y a dónde. */
const MUDADAS: Record<string, string> = {
  varianza: "/admin/inventario?tab=varianza",
  "salud-sostenida": "/admin/inventario?tab=salud",
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
  const replenishmentEnabled = hasFeature("inventory.replenishment")
  const enabled = menuEngineeringEnabled || replenishmentEnabled

  const firstAvailableTab: TabValue = menuEngineeringEnabled ? "ingenieria-menu" : "reposicion"
  const tabParam = searchParams.get("tab")
  const mudada = tabParam === null ? undefined : MUDADAS[tabParam]
  const requestedTab: TabValue = isTabValue(tabParam) ? tabParam : firstAvailableTab
  const tabAvailable: Record<TabValue, boolean> = {
    "ingenieria-menu": menuEngineeringEnabled,
    reposicion: replenishmentEnabled,
  }
  const tab: TabValue = tabAvailable[requestedTab] ? requestedTab : firstAvailableTab

  if (mudada) {
    return <Navigate to={mudada} replace />
  }
  if (storeLoading) {
    return <Cargando texto="Cargando sedes…" className="p-4" />
  }
  if (!enabled) {
    // § 13 · Vacío por **función apagada**: nombra la función y lleva a
    // encenderla. Es el único motivo que entiende que **la URL sobrevive al
    // flag**: la entrada de navegación desaparece, pero el marcador del dueño
    // y los avisos de Hoy siguen apuntando acá. Son dos flags, así que se
    // nombran los dos en vez de inventar uno solo.
    return (
      <EmptyState
        reason="feature-off"
        title="Analítica no está habilitada"
        description="Activá «Ingeniería de menú» o «Reposición sugerida» en Admin → Funciones para usar esta pantalla."
        action={{ label: "Encenderla en Funciones", to: "/admin/features" }}
      />
    )
  }
  if (activeStoreId === null) {
    return <p className="p-4 text-sm text-muted-foreground">Todavía no hay sedes creadas.</p>
  }

  // La fila de pestañas de esta pantalla sólo muestra las de la sección del
  // armazón por la que se entró (`app/AdminLayout.tsx`, `RAIL`): «Ingeniería
  // de menú» vive en Informes y «Reposición» en Inventario, y las secciones ya
  // llevan sus propias pestañas arriba. Los `?tab=` no cambian.
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
        {menuEngineeringEnabled ? (
          <TabsContent value="ingenieria-menu" className="pt-2">
            <MenuEngineeringTab storeId={activeStoreId} />
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
