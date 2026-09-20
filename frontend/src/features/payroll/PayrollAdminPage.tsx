/**
 * Admin → Nómina y propinas (T3, spec.md § "las personas"): horas, tablas de
 * recargos, liquidaciones y — D-3 — propinas repartidas. Detrás de
 * `payroll` en la navegación (`payrollFeature.adminNav`); "Propinas" vive en
 * esta misma página porque D-3 gatea bajo `pos.tips` (ya existía), no bajo
 * `payroll` — esta pestaña se muestra si CUALQUIERA de las dos está
 * encendida, para que una sede con propinas pero sin nómina siga llegando
 * al reparto.
 */
import { useSearchParams } from "react-router-dom"

import { useSession } from "@/app/session"
import { useStoreSelection } from "@/app/storeContext"
import { EmptyState } from "@/components/EmptyState"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"

import { HoursTab } from "./HoursTab"
import { RunsTab } from "./RunsTab"
import { SurchargeTablesTab } from "./SurchargeTablesTab"
import { WagesCalendarTab } from "./WagesCalendarTab"
import { TipsTab } from "./TipsTab"

const ALL_TABS = ["horas", "tarifas", "recargos", "liquidaciones", "propinas"] as const
type TabValue = (typeof ALL_TABS)[number]

function isTabValue(value: string | null): value is TabValue {
  return (ALL_TABS as readonly string[]).includes(value ?? "")
}

export function PayrollAdminPage(): React.JSX.Element {
  const { hasFeature } = useSession()
  const { activeStoreId, loading: storeLoading } = useStoreSelection()
  const [searchParams, setSearchParams] = useSearchParams()

  const payrollEnabled = hasFeature("payroll")
  const tipsEnabled = hasFeature("pos.tips")
  const enabled = payrollEnabled || tipsEnabled

  const tabParam = searchParams.get("tab")
  const requestedTab: TabValue = isTabValue(tabParam) ? tabParam : payrollEnabled ? "horas" : "propinas"
  const tabAvailable: Record<TabValue, boolean> = {
    horas: payrollEnabled,
    tarifas: payrollEnabled,
    recargos: payrollEnabled,
    liquidaciones: payrollEnabled,
    propinas: tipsEnabled,
  }
  const tab: TabValue = tabAvailable[requestedTab] ? requestedTab : payrollEnabled ? "horas" : "propinas"

  if (storeLoading) {
    return <p className="p-4 text-sm text-muted-foreground">Cargando sedes…</p>
  }
  if (!enabled) {
    return (
      <EmptyState
        title="Nómina y propinas no está habilitado"
        description="Activá «Nómina» o «Propinas» en Admin → Funciones para usar esta pantalla."
      />
    )
  }
  if (activeStoreId === null) {
    return <p className="p-4 text-sm text-muted-foreground">Todavía no hay sedes creadas.</p>
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-semibold">Nómina y propinas</h1>
        <p className="text-sm text-muted-foreground">Las personas: sus horas, sus recargos y su propina.</p>
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
          {payrollEnabled ? <TabsTrigger value="horas">Horas</TabsTrigger> : null}
          {payrollEnabled ? <TabsTrigger value="tarifas">Tarifas y calendario</TabsTrigger> : null}
          {payrollEnabled ? <TabsTrigger value="recargos">Tablas de recargos</TabsTrigger> : null}
          {payrollEnabled ? <TabsTrigger value="liquidaciones">Liquidaciones</TabsTrigger> : null}
          {tipsEnabled ? <TabsTrigger value="propinas">Propinas</TabsTrigger> : null}
        </TabsList>
        {payrollEnabled ? (
          <TabsContent value="horas" className="pt-4">
            <HoursTab storeId={activeStoreId} />
          </TabsContent>
        ) : null}
        {payrollEnabled ? (
          <TabsContent value="tarifas" className="pt-4">
            <WagesCalendarTab storeId={activeStoreId} />
          </TabsContent>
        ) : null}
        {payrollEnabled ? (
          <TabsContent value="recargos" className="pt-4">
            <SurchargeTablesTab storeId={activeStoreId} />
          </TabsContent>
        ) : null}
        {payrollEnabled ? (
          <TabsContent value="liquidaciones" className="pt-4">
            <RunsTab storeId={activeStoreId} />
          </TabsContent>
        ) : null}
        {tipsEnabled ? (
          <TabsContent value="propinas" className="pt-4">
            <TipsTab storeId={activeStoreId} />
          </TabsContent>
        ) : null}
      </Tabs>
    </div>
  )
}

export default PayrollAdminPage
