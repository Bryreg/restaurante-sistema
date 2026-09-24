import { ArrowRight } from "lucide-react"
import { Link } from "react-router-dom"

import { useStoreSelection } from "@/app/storeContext"
import { Cargando } from "@/components/Cargando"
import { PageHeader } from "@/components/admin"
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
 *
 * Patrón 2 (`docs/PATRONES-ADMIN.md`): «Ventas» no se explica sola —el nombre
 * no dice contra qué datos se mira— así que la cabecera lleva **la pregunta
 * que la pantalla contesta** y las dos salidas a la derecha.
 */
export function SalesPage(): React.JSX.Element {
  const { activeStoreId, loading: storeLoading } = useStoreSelection()

  if (storeLoading) {
    return <Cargando texto="Cargando sedes…" />
  }
  if (activeStoreId === null) {
    return <p className="text-sm text-muted-foreground">Todavía no hay sedes creadas.</p>
  }

  return (
    <div className="space-y-4">
      <PageHeader
        name="Ventas"
        question="Qué se vendió en el período, cómo te lo pagaron y qué parte de eso tuvo ficha técnica de verdad."
        actions={
          <>
            <Link
              to="/admin/fiscal/documentos"
              className="inline-flex items-center gap-1 text-sm font-bold text-primary hover:underline"
            >
              Documentos con detalle
              <ArrowRight className="size-3.5" aria-hidden="true" />
            </Link>
            <Link
              to="/admin/fiscal/notas"
              className="inline-flex items-center gap-1 text-sm font-bold text-primary hover:underline"
            >
              Notas
              <ArrowRight className="size-3.5" aria-hidden="true" />
            </Link>
          </>
        }
      >
        {/* La pestaña por defecto no cambia: esta ronda es apariencia y
            composición, no comportamiento. Dónde se elige cada cosa era una
            franja de contexto que explicaba en vez de dar un dato (mapa de
            pantallas, regla 2): pasó al `title` de las pestañas, que es de
            lo que habla. */}
        <Tabs defaultValue="sales">
          <TabsList
            className="mt-1 h-auto flex-wrap"
            title="El período y la agrupación se eligen en cada pestaña; la sede, en la lateral."
          >
            <TabsTrigger value="sales">Ventas</TabsTrigger>
            <TabsTrigger value="accountant">Informe del contador</TabsTrigger>
            <TabsTrigger value="unavailable">Agotados</TabsTrigger>
          </TabsList>
          <TabsContent value="sales" className="pt-4">
            <SalesTab storeId={activeStoreId} />
          </TabsContent>
          <TabsContent value="accountant" className="pt-4">
            <AccountantReportTab storeId={activeStoreId} />
          </TabsContent>
          <TabsContent value="unavailable" className="pt-4">
            <UnavailableLogTab storeId={activeStoreId} />
          </TabsContent>
        </Tabs>
      </PageHeader>
    </div>
  )
}

export default SalesPage
