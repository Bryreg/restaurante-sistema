/**
 * Admin → Obligaciones y gastos (T2, spec.md § "lo que cuesta tener
 * abierto"): gastos, obligaciones agendadas, punto de equilibrio, utilidad
 * y — D-2 — cuentas por pagar con diferencia de factura. Detrás de
 * `money.obligations` en la navegación (`expensesFeature.adminNav`); la
 * pestaña de cuentas por pagar (D-2) vive acá porque extiende el mismo
 * endpoint que `money.obligations` gatea en el contrato de esta fase.
 */
import { useSearchParams } from "react-router-dom"

import { useSession } from "@/app/session"
import { useStoreSelection } from "@/app/storeContext"
import { Cargando } from "@/components/Cargando"
import { FeatureOffEmptyState, MasPestanas, PageHeader } from "@/components/admin"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"

import { BreakEvenTab } from "./BreakEvenTab"
import { ExpensesTab } from "./ExpensesTab"
import { ObligationsTab } from "./ObligationsTab"
import { PayablesApprovalTab } from "./PayablesApprovalTab"
import { ProfitTab } from "./ProfitTab"

const ALL_TABS = ["gastos", "obligaciones", "equilibrio", "utilidad", "cuentas-por-pagar"] as const
type TabValue = (typeof ALL_TABS)[number]

function isTabValue(value: string | null): value is TabValue {
  return (ALL_TABS as readonly string[]).includes(value ?? "")
}

export function ExpensesAdminPage(): React.JSX.Element {
  const { hasFeature } = useSession()
  const { activeStoreId, loading: storeLoading } = useStoreSelection()
  const [searchParams, setSearchParams] = useSearchParams()

  const enabled = hasFeature("money.obligations")

  // Sin `?tab=` se abre Utilidad: es lo primero que el dueño quiere ver
  // (mapa de pantallas, sección «Plata»: «Utilidad y punto de equilibrio
  // arriba»). Los `?tab=` que ya existen siguen llegando a su pestaña.
  const tabParam = searchParams.get("tab")
  const tab: TabValue = isTabValue(tabParam) ? tabParam : "utilidad"

  if (storeLoading) {
    return <Cargando texto="Cargando sedes…" className="p-4" />
  }
  if (!enabled) {
    // Patrón 13, motivo «función apagada»: la entrada de navegación
    // desaparece con el flag, pero la URL sobrevive en un marcador.
    return (
      <FeatureOffEmptyState
        feature="Gastos y obligaciones"
        flag="money.obligations"
        description="Sin ella el restaurante sólo ve lo que vende: los arriendos, los servicios y lo que hay que pagar el mes que viene no entran en ninguna cuenta."
      />
    )
  }
  if (activeStoreId === null) {
    return <p className="p-4 text-sm text-muted-foreground">Todavía no hay sedes creadas.</p>
  }

  function cambiarPestana(value: string) {
    const next = new URLSearchParams(searchParams)
    next.set("tab", value)
    setSearchParams(next, { replace: true })
  }

  return (
    <div className="space-y-4">
      <PageHeader
        name="Obligaciones y gastos"
        question="Lo que cuesta tener el restaurante abierto, aunque no se venda nada: gastos del período, lo que vence, y a partir de cuánto se empieza a ganar."
      />
      <Tabs value={tab} onValueChange={cambiarPestana}>
        {/* Tres a la vista y el resto en «Más» (mapa de pantallas, regla 4),
            en el orden del mapa: utilidad y punto de equilibrio arriba, los
            gastos después; obligaciones y cuentas por pagar, en «Más». */}
        {/* `h-auto` solo no alcanzaba: la lista trae `h-8` con la variante
            horizontal, que le gana, y a 390 px «Más» quedaba en una segunda
            línea recortada. Con la misma variante, la fila de verdad se parte. */}
        <TabsList className="h-auto flex-wrap group-data-horizontal/tabs:h-auto">
          <TabsTrigger value="utilidad">Utilidad</TabsTrigger>
          <TabsTrigger value="equilibrio">Punto de equilibrio</TabsTrigger>
          <TabsTrigger value="gastos">Gastos</TabsTrigger>
          <MasPestanas
            value={tab}
            onValueChange={cambiarPestana}
            items={[
              { value: "obligaciones", label: "Obligaciones" },
              { value: "cuentas-por-pagar", label: "Cuentas por pagar" },
            ]}
          />
        </TabsList>
        <TabsContent value="gastos" className="pt-4">
          <ExpensesTab storeId={activeStoreId} />
        </TabsContent>
        <TabsContent value="obligaciones" className="pt-4">
          <ObligationsTab storeId={activeStoreId} />
        </TabsContent>
        <TabsContent value="equilibrio" className="pt-4">
          <BreakEvenTab storeId={activeStoreId} />
        </TabsContent>
        <TabsContent value="utilidad" className="pt-4">
          <ProfitTab storeId={activeStoreId} />
        </TabsContent>
        <TabsContent value="cuentas-por-pagar" className="pt-4">
          <PayablesApprovalTab storeId={activeStoreId} />
        </TabsContent>
      </Tabs>
    </div>
  )
}

export default ExpensesAdminPage
