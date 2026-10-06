/**
 * Admin → Caja → Consignaciones (T1, spec.md § "la plata después del
 * cajón"): las consignaciones y el saldo por consignar. Detrás de
 * `money.deposits` en la navegación (`bankingFeature.adminNav`).
 *
 * c10 (2026-10-06): el libro del banco, la mano del dueño y las dos
 * conciliaciones se mudaron a Plata (`/admin/plata`, `PlataAdminPage`) con
 * los mismos `?tab=`. Un marcador viejo (`/admin/banco?tab=libro`, `mano`,
 * `datafono`, `plataformas`) redirige allá, con el resto de la query.
 */
import { Navigate, useSearchParams } from "react-router-dom"

import { useSession } from "@/app/session"
import { useStoreSelection } from "@/app/storeContext"
import { Cargando } from "@/components/Cargando"
import { PageHeader } from "@/components/admin"
import { EmptyState } from "@/components/EmptyState"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"

import { DepositsTab } from "./DepositsTab"
import { PendingDepositsTab } from "./PendingDepositsTab"
import { PLATA_TABS } from "./lib"

const ALL_TABS = ["consignaciones", "por-consignar"] as const
type TabValue = (typeof ALL_TABS)[number]

function isTabValue(value: string | null): value is TabValue {
  return (ALL_TABS as readonly string[]).includes(value ?? "")
}

export function BankingAdminPage(): React.JSX.Element {
  const { hasFeature } = useSession()
  const { activeStoreId, loading: storeLoading } = useStoreSelection()
  const [searchParams, setSearchParams] = useSearchParams()

  const enabled = hasFeature("money.deposits")
  const tabParam = searchParams.get("tab")
  const tab: TabValue = isTabValue(tabParam) ? tabParam : "consignaciones"

  if ((PLATA_TABS as readonly string[]).includes(tabParam ?? "")) {
    return <Navigate to={`/admin/plata?${searchParams.toString()}`} replace />
  }
  if (storeLoading) {
    return <Cargando texto="Cargando sedes…" className="p-4" />
  }
  if (!enabled) {
    return (
      <EmptyState
        reason="feature-off"
        title="Consignaciones no está habilitado"
        description="Activá «Consignaciones» en Admin → Funciones para usar esta pantalla."
        action={{ label: "Encenderla en Funciones", to: "/admin/features" }}
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
        name="Consignaciones"
        question="Qué plata del cajón ya se llevó al banco y qué falta consignar."
      >
        <Tabs value={tab} onValueChange={cambiarPestana}>
          <TabsList className="h-auto flex-wrap group-data-horizontal/tabs:h-auto">
            <TabsTrigger value="consignaciones">Consignaciones</TabsTrigger>
            <TabsTrigger value="por-consignar">Por consignar</TabsTrigger>
          </TabsList>
          <TabsContent value="consignaciones" className="pt-4">
            <DepositsTab storeId={activeStoreId} />
          </TabsContent>
          <TabsContent value="por-consignar" className="pt-4">
            <PendingDepositsTab storeId={activeStoreId} />
          </TabsContent>
        </Tabs>
      </PageHeader>
    </div>
  )
}

export default BankingAdminPage
