import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"

import { CoverageSection } from "./CoverageSection"
import { RecipeEditor } from "./RecipeEditor"
import { SuspiciousUnitsSection } from "./SuspiciousUnitsSection"

/**
 * "Carta y recetas" (SPEC-NEGOCIO §9.3): fichas técnicas por plato, costo
 * con origen y food cost %, cobertura de recetas y unidades sospechosas.
 * Vive dentro de la pestaña "Carta" que ya existe (`CatalogAdminPage.tsx`),
 * gateado por `catalog.recipes` desde ahí — acá adentro sólo se subdivide
 * en sus tres vistas.
 */
export function RecipesTab({ storeId }: { storeId: number }): React.JSX.Element {
  return (
    <div className="space-y-4">
      <Tabs defaultValue="editor">
        <TabsList>
          <TabsTrigger value="editor">Fichas técnicas</TabsTrigger>
          <TabsTrigger value="coverage">Cobertura</TabsTrigger>
          <TabsTrigger value="suspicious">Unidades sospechosas</TabsTrigger>
        </TabsList>
        <TabsContent value="editor">
          <RecipeEditor storeId={storeId} />
        </TabsContent>
        <TabsContent value="coverage">
          <CoverageSection storeId={storeId} />
        </TabsContent>
        <TabsContent value="suspicious">
          <SuspiciousUnitsSection storeId={storeId} />
        </TabsContent>
      </Tabs>
    </div>
  )
}
