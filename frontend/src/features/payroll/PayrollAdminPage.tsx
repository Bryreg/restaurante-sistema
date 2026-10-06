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
 * entrando por «Nómina», la fila muestra lo que el dueño pidió ver
 * (2026-09-29): el **horario de la semana** (`?tab=semana`, la vista por
 * defecto), y manda el resto —Horas, Liquidaciones, Tarifas, Recargos,
 * Propinas— a «Más». Ningún `?tab=` de antes cambió.
 */
import { useSearchParams } from "react-router-dom"

import { useSession } from "@/app/session"
import { useStoreSelection } from "@/app/storeContext"
import { Cargando } from "@/components/Cargando"
import { MasPestanas, PageHeader } from "@/components/admin"
import { EmptyState } from "@/components/EmptyState"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"

import { ContractsTab } from "./ContractsTab"
import { HoursTab } from "./HoursTab"
import { PlanningTab } from "./PlanningTab"
import { RunsTab } from "./RunsTab"
import { SurchargeTablesTab } from "./SurchargeTablesTab"
import { WagesCalendarTab } from "./WagesCalendarTab"
import { TipsTab } from "./TipsTab"
import { WeekScheduleTab } from "./WeekScheduleTab"

const ALL_TABS = ["semana", "planeacion", "horas", "tarifas", "contratos", "recargos", "liquidaciones", "propinas"] as const
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
  const requestedTab: TabValue = isTabValue(tabParam) ? tabParam : payrollEnabled ? "semana" : "propinas"
  const tabAvailable: Record<TabValue, boolean> = {
    semana: payrollEnabled,
    planeacion: payrollEnabled,
    horas: payrollEnabled,
    tarifas: payrollEnabled,
    contratos: payrollEnabled,
    recargos: payrollEnabled,
    liquidaciones: payrollEnabled,
    propinas: tipsEnabled,
  }
  const tab: TabValue = tabAvailable[requestedTab] ? requestedTab : payrollEnabled ? "semana" : "propinas"

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
            : "Quién trabajó esta semana, de qué hora a qué hora cada día, y cuántas horas suma cada persona. Horas, liquidaciones, tarifas y recargos siguen en «Más»."
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
        {/* El horario de la semana a la vista y el resto en «Más»
            (decisión del dueño, 2026-09-29: «solo» quiere ver el horario).
            Ninguna pestaña se borró ni cambió su `?tab=`. «Propinas» también
            es pestaña de sección, arriba; acá va en «Más» para quien entra
            por «Nómina». */}
        {payrollEnabled && !enPropinas ? (
          // `h-auto` solo no alcanza: la lista trae `h-8` con la variante
          // horizontal, que le gana (ver `BankingAdminPage.tsx`).
          <TabsList className="h-auto flex-wrap group-data-horizontal/tabs:h-auto">
            <TabsTrigger value="semana">Horario de la semana</TabsTrigger>
            {/* Auditoría e1: los turnos planeados y la comparación con lo real. */}
            <TabsTrigger value="planeacion">Planeación</TabsTrigger>
            <MasPestanas
              value={tab}
              onValueChange={cambiarPestana}
              items={[
                { value: "horas", label: "Horas" },
                { value: "liquidaciones", label: "Liquidaciones" },
                { value: "tarifas", label: "Tarifas y calendario" },
                { value: "contratos", label: "Contratos y novedades" },
                { value: "recargos", label: "Tablas de recargos" },
                ...(tipsEnabled ? [{ value: "propinas", label: "Propinas" }] : []),
              ]}
            />
          </TabsList>
        ) : null}
        {payrollEnabled ? (
          <TabsContent value="semana" className="pt-4">
            <WeekScheduleTab storeId={activeStoreId} />
          </TabsContent>
        ) : null}
        {payrollEnabled ? (
          <TabsContent value="planeacion" className="pt-4">
            <PlanningTab storeId={activeStoreId} />
          </TabsContent>
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
          <TabsContent value="contratos" className="pt-4">
            <ContractsTab storeId={activeStoreId} />
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
