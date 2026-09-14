import { useStoreSelection } from "@/app/storeContext"
import { useSession } from "@/app/session"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"

import { CategoriesTab } from "./CategoriesTab"
import { CombosTab } from "./CombosTab"
import { DailyMenuTab } from "./DailyMenuTab"
import { ModifiersTab } from "./ModifiersTab"
import { ProductsTab } from "./ProductsTab"

export function CatalogAdminPage() {
  const { hasFeature } = useSession()
  // La sede activa (con selector cuando `multi_store` está encendida) ya la
  // resuelve `AdminLayout` vía `StoreSelectionProvider`; esta pantalla sólo
  // la consume (`app/storeContext.tsx`, no es territorio de este módulo).
  const { activeStoreId, loading } = useStoreSelection()

  if (loading) {
    return <p className="p-4 text-sm text-muted-foreground">Cargando sedes…</p>
  }
  if (activeStoreId === null) {
    return <p className="p-4 text-sm text-muted-foreground">Todavía no hay sedes creadas.</p>
  }

  const showModifiers = hasFeature("pos.modifiers")
  const showCombos = hasFeature("pos.combos")
  const showDailyMenu = hasFeature("pos.daily_menu")

  return (
    <div className="space-y-4">
      <h1 className="text-lg font-semibold">Carta</h1>

      <Tabs defaultValue="categories">
        <TabsList>
          <TabsTrigger value="categories">Categorías</TabsTrigger>
          <TabsTrigger value="products">Productos</TabsTrigger>
          {showModifiers && <TabsTrigger value="modifiers">Modificadores</TabsTrigger>}
          {showCombos && <TabsTrigger value="combos">Combos</TabsTrigger>}
          {showDailyMenu && <TabsTrigger value="daily-menu">Menú del día</TabsTrigger>}
        </TabsList>

        <TabsContent value="categories">
          <CategoriesTab storeId={activeStoreId} />
        </TabsContent>
        <TabsContent value="products">
          <ProductsTab storeId={activeStoreId} />
        </TabsContent>
        {showModifiers && (
          <TabsContent value="modifiers">
            <ModifiersTab storeId={activeStoreId} />
          </TabsContent>
        )}
        {showCombos && (
          <TabsContent value="combos">
            <CombosTab storeId={activeStoreId} />
          </TabsContent>
        )}
        {showDailyMenu && (
          <TabsContent value="daily-menu">
            <DailyMenuTab storeId={activeStoreId} />
          </TabsContent>
        )}
      </Tabs>
    </div>
  )
}
