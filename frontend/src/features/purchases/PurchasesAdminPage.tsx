import { useQuery } from "@tanstack/react-query"
import { useSearchParams } from "react-router-dom"

import { useSession } from "@/app/session"
import { useStoreSelection } from "@/app/storeContext"
import { listSuppliers } from "@/api/purchases"
import { Cargando } from "@/components/Cargando"
import { FeatureOffEmptyState, PageHeader } from "@/components/admin"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"

import { PayablesTab } from "./PayablesTab"
import { ReceptionsTab } from "./ReceptionsTab"
import { SuppliersTab } from "./SuppliersTab"

type TabValue = "proveedores" | "recepciones" | "cuentas-por-pagar"

function isTabValue(value: string | null): value is TabValue {
  return value === "proveedores" || value === "recepciones" || value === "cuentas-por-pagar"
}

/**
 * Admin → Compras (SPEC-NEGOCIO §9.3: «¿a quién le debo?»): proveedores y
 * confiabilidad, recepciones, cuentas por pagar y pagos. Detrás de
 * `hasFeature("purchases")` en la navegación (`purchasesFeature.adminNav`,
 * `src/features/purchases/index.ts`) — si alguien llega igual a la ruta con
 * la función apagada, esta pantalla lo explica en vez de reventar contra un
 * `400 FEATURE_DISABLED`.
 */
export function PurchasesAdminPage(): React.JSX.Element {
  const { hasFeature } = useSession()
  const { activeStoreId, loading: storeLoading } = useStoreSelection()
  const [searchParams, setSearchParams] = useSearchParams()

  const enabled = hasFeature("purchases")
  const tabParam = searchParams.get("tab")
  const tab: TabValue = isTabValue(tabParam) ? tabParam : "proveedores"

  // Proveedores ACTIVOS, compartidos por Recepciones y Cuentas por pagar
  // (selector de la nueva recepción, filtro por proveedor, resolución de
  // nombre en cada fila) — un solo fetch, sin volver a pedirlo por pantalla.
  const suppliersQuery = useQuery({
    queryKey: ["purchases", "suppliers", "lookup", activeStoreId],
    queryFn: () => listSuppliers(activeStoreId as number, { active: true }),
    enabled: enabled && activeStoreId !== null,
  })

  if (storeLoading) {
    return <Cargando texto="Cargando sedes…" className="p-4" />
  }
  if (!enabled) {
    // Patrón 13, motivo «función apagada»: la URL sobrevive al flag —los
    // avisos de Hoy enlazan a `?tab=cuentas-por-pagar`— así que la pantalla
    // no puede limitarse a no existir.
    return (
      <FeatureOffEmptyState
        feature="Proveedores, recepciones de compra y cuentas por pagar"
        flag="purchases"
        description="Sin ella las compras no entran al inventario ni al costo: el stock sólo baja, nunca sube, y el food cost sale irreal."
      />
    )
  }
  if (activeStoreId === null) {
    return <p className="p-4 text-sm text-muted-foreground">Todavía no hay sedes creadas.</p>
  }

  const suppliers = suppliersQuery.data ?? []

  return (
    <div className="space-y-4">
      <PageHeader
        name="Compras"
        question="A quién le debo, qué entró de verdad y a qué precio — proveedores, recepciones y cuentas por pagar."
        context={
          suppliersQuery.isSuccess ? [{ label: "Proveedores activos", value: suppliers.length }] : undefined
        }
      />
      <Tabs
        value={tab}
        onValueChange={(value) => {
          const next = new URLSearchParams(searchParams)
          next.set("tab", value)
          setSearchParams(next, { replace: true })
        }}
      >
        <TabsList>
          <TabsTrigger value="proveedores">Proveedores</TabsTrigger>
          <TabsTrigger value="recepciones">Recepciones</TabsTrigger>
          <TabsTrigger value="cuentas-por-pagar">Cuentas por pagar</TabsTrigger>
        </TabsList>
        <TabsContent value="proveedores" className="pt-4">
          <SuppliersTab storeId={activeStoreId} />
        </TabsContent>
        <TabsContent value="recepciones" className="pt-4">
          <ReceptionsTab storeId={activeStoreId} suppliers={suppliers} />
        </TabsContent>
        <TabsContent value="cuentas-por-pagar" className="pt-4">
          <PayablesTab storeId={activeStoreId} suppliers={suppliers} />
        </TabsContent>
      </Tabs>
    </div>
  )
}

export default PurchasesAdminPage
