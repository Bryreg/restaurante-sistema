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
import { FeatureOffEmptyState, PageHeader } from "@/components/admin"
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

  const tabParam = searchParams.get("tab")
  const tab: TabValue = isTabValue(tabParam) ? tabParam : "gastos"

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

  return (
    <div className="space-y-4">
      <PageHeader
        name="Obligaciones y gastos"
        question="Lo que cuesta tener el restaurante abierto, aunque no se venda nada: gastos del período, lo que vence, y a partir de cuánto se empieza a ganar."
      />
      <Tabs
        value={tab}
        onValueChange={(value) => {
          const next = new URLSearchParams(searchParams)
          next.set("tab", value)
          setSearchParams(next, { replace: true })
        }}
      >
        <TabsList className="h-auto flex-wrap">
          <TabsTrigger value="gastos">Gastos</TabsTrigger>
          <TabsTrigger value="obligaciones">Obligaciones</TabsTrigger>
          <TabsTrigger value="equilibrio">Punto de equilibrio</TabsTrigger>
          <TabsTrigger value="utilidad">Utilidad</TabsTrigger>
          <TabsTrigger value="cuentas-por-pagar">Cuentas por pagar</TabsTrigger>
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
