import { useQuery } from "@tanstack/react-query"
import { useSearchParams } from "react-router-dom"

import { useSession } from "@/app/session"
import { useStoreSelection } from "@/app/storeContext"
import { listSuppliers } from "@/api/purchases"
import { EmptyState } from "@/components/EmptyState"
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
    return <p className="p-4 text-sm text-muted-foreground">Cargando sedes…</p>
  }
  if (!enabled) {
    return (
      <EmptyState
        title="Compras no está habilitado"
        description='Activá «Proveedores, recepciones de compra y cuentas por pagar» en Admin → Funciones para usar esta pantalla.'
      />
    )
  }
  if (activeStoreId === null) {
    return <p className="p-4 text-sm text-muted-foreground">Todavía no hay sedes creadas.</p>
  }

  const suppliers = suppliersQuery.data ?? []

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-semibold">Compras</h1>
        <p className="text-sm text-muted-foreground">A quién le debo — proveedores, recepciones y cuentas por pagar.</p>
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
