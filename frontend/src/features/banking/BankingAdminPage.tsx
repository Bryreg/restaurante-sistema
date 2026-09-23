/**
 * Admin → Banco (T1, spec.md § "la plata después del cajón"): consignaciones,
 * saldo por consignar, libro del banco, mano del dueño y conciliación de
 * datáfono/plataformas. Detrás de `money.deposits` en la navegación
 * (`bankingFeature.adminNav`); las cuatro pestañas que dependen de
 * `money.bank` (Libro, Mano del dueño, Conciliación datáfono/plataformas)
 * llevan además su propio gate interno — mismo patrón que
 * `InventoryAdminPage.tsx` con `inventory.counts`/`inventory.variance`.
 */
import { useSearchParams } from "react-router-dom"

import { useSession } from "@/app/session"
import { useStoreSelection } from "@/app/storeContext"
import { Cargando } from "@/components/Cargando"
import { PageHeader } from "@/components/admin"
import { EmptyState } from "@/components/EmptyState"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"

import { DepositsTab } from "./DepositsTab"
import { LedgerTab } from "./LedgerTab"
import { OwnerHandTab } from "./OwnerHandTab"
import { PendingDepositsTab } from "./PendingDepositsTab"
import { ReconciliationTab } from "./ReconciliationTab"

const ALL_TABS = ["consignaciones", "por-consignar", "libro", "mano", "datafono", "plataformas"] as const
type TabValue = (typeof ALL_TABS)[number]

function isTabValue(value: string | null): value is TabValue {
  return (ALL_TABS as readonly string[]).includes(value ?? "")
}

export function BankingAdminPage(): React.JSX.Element {
  const { hasFeature } = useSession()
  const { activeStoreId, loading: storeLoading } = useStoreSelection()
  const [searchParams, setSearchParams] = useSearchParams()

  const enabled = hasFeature("money.deposits")
  const bankEnabled = hasFeature("money.bank")

  const tabParam = searchParams.get("tab")
  const requestedTab: TabValue = isTabValue(tabParam) ? tabParam : "consignaciones"
  const tabAvailable: Record<TabValue, boolean> = {
    consignaciones: true,
    "por-consignar": true,
    libro: bankEnabled,
    mano: bankEnabled,
    datafono: bankEnabled,
    plataformas: bankEnabled,
  }
  const tab: TabValue = tabAvailable[requestedTab] ? requestedTab : "consignaciones"

  if (storeLoading) {
    return <Cargando texto="Cargando sedes…" className="p-4" />
  }
  if (!enabled) {
    return (
      <EmptyState
        reason="feature-off"
        title="Banco no está habilitado"
        description="Activá «Consignaciones» en Admin → Funciones para usar esta pantalla."
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
        name="Banco"
        question="Qué pasó con la plata después de que salió del cajón: qué se consignó, qué quedó en la mano y qué falta conciliar."
        context={
          bankEnabled
            ? [{ label: "Seis pestañas: dos de consignaciones y cuatro del libro del banco." }]
            : [
                {
                  label: "Sólo Consignaciones y Por consignar",
                  title:
                    "«Banco» (money.bank) está apagada: el libro, la mano del dueño y las dos conciliaciones no se dibujan. La URL de esas pestañas sigue existiendo.",
                },
              ]
        }
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
          <TabsTrigger value="consignaciones">Consignaciones</TabsTrigger>
          <TabsTrigger value="por-consignar">Por consignar</TabsTrigger>
          {bankEnabled ? <TabsTrigger value="libro">Libro del banco</TabsTrigger> : null}
          {bankEnabled ? <TabsTrigger value="mano">Mano del dueño</TabsTrigger> : null}
          {bankEnabled ? <TabsTrigger value="datafono">Conciliación datáfono</TabsTrigger> : null}
          {bankEnabled ? <TabsTrigger value="plataformas">Conciliación plataformas</TabsTrigger> : null}
        </TabsList>
        <TabsContent value="consignaciones" className="pt-4">
          <DepositsTab storeId={activeStoreId} />
        </TabsContent>
        <TabsContent value="por-consignar" className="pt-4">
          <PendingDepositsTab storeId={activeStoreId} />
        </TabsContent>
        {bankEnabled ? (
          <TabsContent value="libro" className="pt-4">
            <LedgerTab storeId={activeStoreId} />
          </TabsContent>
        ) : null}
        {bankEnabled ? (
          <TabsContent value="mano" className="pt-4">
            <OwnerHandTab storeId={activeStoreId} />
          </TabsContent>
        ) : null}
        {bankEnabled ? (
          <TabsContent value="datafono" className="pt-4">
            <ReconciliationTab storeId={activeStoreId} kind="card" />
          </TabsContent>
        ) : null}
        {bankEnabled ? (
          <TabsContent value="plataformas" className="pt-4">
            <ReconciliationTab storeId={activeStoreId} kind="platform" />
          </TabsContent>
        ) : null}
      </Tabs>
      </PageHeader>
    </div>
  )
}

export default BankingAdminPage
