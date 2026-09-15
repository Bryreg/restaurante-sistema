import { ArrowRight } from "lucide-react"
import { Link } from "react-router-dom"

import { useStoreSelection } from "@/app/storeContext"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"

import { AccountantReportTab } from "./AccountantReportTab"
import { SalesTab } from "./SalesTab"
import { UnavailableLogTab } from "./UnavailableLogTab"

/**
 * "Ventas" (SPEC-NEGOCIO §9.3): ¿qué vendí y cómo me pagaron?, con el
 * informe para el contador y los agotados del período. "Documentos con
 * detalle" y "notas" ya tienen su propia pantalla completa en Documentos
 * fiscales/Notas (`fiscalFeature`, territorio de `frontend-fiscal`) — acá no
 * se duplican, sólo se agrupan/exportan las ventas y se enlaza a esas
 * pantallas cuando hace falta el detalle documento por documento.
 */
export function SalesPage(): React.JSX.Element {
  const { activeStoreId, loading: storeLoading } = useStoreSelection()

  if (storeLoading) {
    return <p className="text-sm text-muted-foreground">Cargando sedes…</p>
  }
  if (activeStoreId === null) {
    return <p className="text-sm text-muted-foreground">Todavía no hay sedes creadas.</p>
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-lg font-semibold">Ventas</h1>
        <div className="flex flex-wrap gap-4 text-sm">
          <Link to="/admin/fiscal/documentos" className="inline-flex items-center gap-1 font-medium text-primary hover:underline">
            Documentos con detalle
            <ArrowRight className="size-3.5" aria-hidden="true" />
          </Link>
          <Link to="/admin/fiscal/notas" className="inline-flex items-center gap-1 font-medium text-primary hover:underline">
            Notas
            <ArrowRight className="size-3.5" aria-hidden="true" />
          </Link>
        </div>
      </div>
      <Tabs defaultValue="sales">
        <TabsList>
          <TabsTrigger value="sales">Ventas</TabsTrigger>
          <TabsTrigger value="accountant">Informe del contador</TabsTrigger>
          <TabsTrigger value="unavailable">Agotados</TabsTrigger>
        </TabsList>
        <TabsContent value="sales">
          <SalesTab storeId={activeStoreId} />
        </TabsContent>
        <TabsContent value="accountant">
          <AccountantReportTab storeId={activeStoreId} />
        </TabsContent>
        <TabsContent value="unavailable">
          <UnavailableLogTab storeId={activeStoreId} />
        </TabsContent>
      </Tabs>
    </div>
  )
}

export default SalesPage
