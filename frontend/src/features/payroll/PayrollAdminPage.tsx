/**
 * Admin → Nómina y propinas (T3, spec.md § "las personas"): horas, tablas de
 * recargos, liquidaciones y — D-3 — propinas repartidas. Detrás de
 * `payroll` en la navegación (`payrollFeature.adminNav`); "Propinas" vive en
 * esta misma página porque D-3 gatea bajo `pos.tips` (ya existía), no bajo
 * `payroll` — la página se muestra si CUALQUIERA de las dos está encendida,
 * para que una sede con propinas pero sin nómina siga llegando al reparto.
 *
 * **Propinas no es una pestaña de acá** (mapa de pantallas, regla 4): el
 * armazón ya la dibuja como pestaña de sección (`?tab=propinas`, al lado de
 * «Nómina»). Entrando por ahí no se dibuja la fila de pestañas de nómina;
 * entrando por «Nómina», la fila muestra lo que el restaurante usa —las
 * horas, que se le pasan al contador que lleva la nómina— y manda el resto a
 * «Más». Ningún `?tab=` cambió.
 */
import { useSearchParams } from "react-router-dom"

import { useSession } from "@/app/session"
import { useStoreSelection } from "@/app/storeContext"
import { Cargando } from "@/components/Cargando"
import { MasPestanas, PageHeader } from "@/components/admin"
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
    return <Cargando texto="Cargando sedes…" className="p-4" />
  }
  if (!enabled) {
    return (
      <EmptyState
        reason="feature-off"
        title="Nómina y propinas no está habilitado"
        description="Activá «Nómina» o «Propinas» en Admin → Funciones para usar esta pantalla."
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

  const enPropinas = tab === "propinas"

  return (
    <div className="space-y-4">
      {/* El nombre sigue a la pestaña de sección por la que se entró. La
          franja de contexto sólo dice qué función está apagada, cuando una lo
          está: el aviso de «control interno, no liquidación legal» vive
          arriba de la pestaña Liquidaciones, que es donde se lee la cifra. */}
      <PageHeader
        name={enPropinas ? "Propinas" : "Nómina"}
        question={
          enPropinas
            ? "Cuánta propina le toca a cada persona del período, con el método de reparto de la sede, y a quién se le entregó."
            : "Cuántas horas puso cada persona —lo que se le pasa al contador que lleva la nómina— y cuánto suma eso con las tarifas y los recargos vigentes."
        }
        context={
          payrollEnabled && tipsEnabled
            ? []
            : payrollEnabled
              ? [{ label: "Sólo «Nómina»", title: "«Propinas» (pos.tips) está apagada: la pestaña de reparto no se dibuja." }]
              : [{ label: "Sólo «Propinas»", title: "«Nómina» (payroll) está apagada: horas, tarifas, recargos y liquidaciones no se dibujan." }]
        }
      >
      <Tabs value={tab} onValueChange={cambiarPestana}>
        {/* Tres a la vista y el resto en «Más» (regla 4). Sin «Propinas»:
            ya es pestaña de sección, arriba. */}
        {payrollEnabled && !enPropinas ? (
          // `h-auto` solo no alcanza: la lista trae `h-8` con la variante
          // horizontal, que le gana (ver `BankingAdminPage.tsx`).
          <TabsList className="h-auto flex-wrap group-data-horizontal/tabs:h-auto">
            <TabsTrigger value="horas">Horas</TabsTrigger>
            <TabsTrigger value="liquidaciones">Liquidaciones</TabsTrigger>
            <TabsTrigger value="tarifas">Tarifas y calendario</TabsTrigger>
            <MasPestanas
              value={tab}
              onValueChange={cambiarPestana}
              items={[{ value: "recargos", label: "Tablas de recargos" }]}
            />
          </TabsList>
        ) : null}
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
      </PageHeader>
    </div>
  )
}

export default PayrollAdminPage
