/**
 * Admin → Plata (c10): lo que pasa con la plata después del cajón — el libro
 * del banco (cuánto hay hoy y de dónde salió), la mano del dueño y las
 * conciliaciones de datáfono y plataformas. Vivían como pestañas de
 * `/admin/banco`; los `?tab=` son los mismos (`libro`, `mano`, `datafono`,
 * `plataformas`) y `/admin/banco` redirige acá los que eran de esta página.
 *
 * Todo detrás de `money.bank`, que depende de `money.deposits` (el servidor
 * valida la dependencia primero; acá se piden las dos).
 */
import { useSearchParams } from "react-router-dom"

import { useSession } from "@/app/session"
import { useStoreSelection } from "@/app/storeContext"
import { Cargando } from "@/components/Cargando"
import { PageHeader } from "@/components/admin"
import { EmptyState } from "@/components/EmptyState"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"

import { LedgerTab } from "./LedgerTab"
import { OwnerHandTab } from "./OwnerHandTab"
import { ReconciliationTab } from "./ReconciliationTab"
import { PLATA_TABS } from "./lib"

type TabValue = (typeof PLATA_TABS)[number]

function isTabValue(value: string | null): value is TabValue {
  return (PLATA_TABS as readonly string[]).includes(value ?? "")
}

export function PlataAdminPage(): React.JSX.Element {
  const { hasFeature } = useSession()
  const { activeStoreId, loading: storeLoading } = useStoreSelection()
  const [searchParams, setSearchParams] = useSearchParams()

  const enabled = hasFeature("money.deposits") && hasFeature("money.bank")
  const tabParam = searchParams.get("tab")
  const tab: TabValue = isTabValue(tabParam) ? tabParam : "libro"

  if (storeLoading) {
    return <Cargando texto="Cargando sedes…" className="p-4" />
  }
  if (!enabled) {
    return (
      <EmptyState
        reason="feature-off"
        title="El libro del banco no está habilitado"
        description="Activá «Consignaciones» y «Banco» en Admin → Funciones para ver el libro del banco, la mano del dueño y las conciliaciones."
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
        name="Plata"
        question="Cuánto hay en el banco hoy y de dónde salió, qué quedó en la mano del dueño y qué falta conciliar."
      >
        <Tabs value={tab} onValueChange={cambiarPestana}>
          <TabsList className="h-auto flex-wrap group-data-horizontal/tabs:h-auto">
            <TabsTrigger value="libro">Libro del banco</TabsTrigger>
            <TabsTrigger value="mano">Mano del dueño</TabsTrigger>
            <TabsTrigger value="datafono">Conciliación datáfono</TabsTrigger>
            <TabsTrigger value="plataformas">Conciliación plataformas</TabsTrigger>
          </TabsList>
          <TabsContent value="libro" className="pt-4">
            <LedgerTab storeId={activeStoreId} />
          </TabsContent>
          <TabsContent value="mano" className="pt-4">
            <OwnerHandTab storeId={activeStoreId} />
          </TabsContent>
          <TabsContent value="datafono" className="pt-4">
            <ReconciliationTab storeId={activeStoreId} kind="card" />
          </TabsContent>
          <TabsContent value="plataformas" className="pt-4">
            <ReconciliationTab storeId={activeStoreId} kind="platform" />
          </TabsContent>
        </Tabs>
      </PageHeader>
    </div>
  )
}

export default PlataAdminPage
