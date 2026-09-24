import { useSearchParams } from "react-router-dom"

import { useStoreSelection } from "@/app/storeContext"
import { useSession } from "@/app/session"
import { Cargando } from "@/components/Cargando"
import { MasPestanas } from "@/components/admin"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"

import { CategoriesTab } from "./CategoriesTab"
import { CombosTab } from "./CombosTab"
import { DailyMenuTab } from "./DailyMenuTab"
import { ModifiersTab } from "./ModifiersTab"
import { ProductsTab } from "./ProductsTab"
import { RecipesTab } from "./RecipesTab"

type Pestana = "products" | "daily-menu" | "recipes" | "combos" | "categories" | "modifiers"

/**
 * Las pestañas de la carta **en el orden en que se usan**: primero lo de
 * todos los días —un producto agotado, un precio, el menú de hoy («armar el
 * menú de hoy en menos de dos minutos», SPEC-NEGOCIO §4.3), una ficha—, al
 * final lo que se arma una vez —combos, categorías, modificadores—. Las tres
 * primeras encendidas van a la vista y el resto en «Más» (mapa de
 * pantallas, regla 4); con un flag apagado, la siguiente sube a ocupar su
 * lugar. Los rótulos viajan como `label: "…"`, que el censo lee.
 */
const PESTANAS: readonly { value: Pestana; label: string }[] = [
  { value: "products", label: "Productos" },
  { value: "daily-menu", label: "Menú del día" },
  { value: "recipes", label: "Recetas" },
  { value: "combos", label: "Combos" },
  { value: "categories", label: "Categorías" },
  { value: "modifiers", label: "Modificadores" },
]

const A_LA_VISTA = 3

export function CatalogAdminPage() {
  const { hasFeature } = useSession()
  // La sede activa (con selector cuando `multi_store` está encendida) ya la
  // resuelve `AdminLayout` vía `StoreSelectionProvider`; esta pantalla sólo
  // la consume (`app/storeContext.tsx`, no es territorio de este módulo).
  const { activeStoreId, loading } = useStoreSelection()
  // Abre en Productos, que es la que se usa a diario (antes abría en
  // Categorías, que se toca una vez al montar la carta). La pestaña vive en
  // `?tab=` como en las demás pantallas: Punto de equilibrio enlaza a
  // «Carta › Recetas» y tiene que caer ahí.
  const [searchParams, setSearchParams] = useSearchParams()
  const tab = searchParams.get("tab") ?? "products"
  function setTab(value: string) {
    const next = new URLSearchParams(searchParams)
    next.set("tab", value)
    setSearchParams(next, { replace: true })
  }

  if (loading) {
    return <Cargando texto="Cargando sedes…" className="p-4" />
  }
  if (activeStoreId === null) {
    return <p className="p-4 text-sm text-muted-foreground">Todavía no hay sedes creadas.</p>
  }

  const showModifiers = hasFeature("pos.modifiers")
  const showCombos = hasFeature("pos.combos")
  const showDailyMenu = hasFeature("pos.daily_menu")
  // Fichas técnicas (pedido 2a): con `catalog.recipes` apagada, ni la
  // pestaña se ofrece — el costo queda `null` con origen visible en todos
  // lados y el sistema vende exactamente igual que antes (AGENTS.md).
  const showRecipes = hasFeature("catalog.recipes")

  const encendida: Record<Pestana, boolean> = {
    products: true,
    "daily-menu": showDailyMenu,
    recipes: showRecipes,
    combos: showCombos,
    categories: true,
    modifiers: showModifiers,
  }
  const encendidas = PESTANAS.filter((p) => encendida[p.value])
  const visibles = encendidas.slice(0, A_LA_VISTA)
  const enMas = encendidas.slice(A_LA_VISTA)

  return (
    <div className="space-y-4">
      <h1 className="text-lg font-semibold">Carta</h1>

      <Tabs value={tab} onValueChange={(value) => setTab(String(value))}>
        <TabsList className="h-auto flex-wrap group-data-horizontal/tabs:h-auto">
          {visibles.map((p) => (
            <TabsTrigger key={p.value} value={p.value}>
              {p.label}
            </TabsTrigger>
          ))}
          <MasPestanas value={tab} onValueChange={setTab} items={enMas} />
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
        {showRecipes && (
          <TabsContent value="recipes">
            <RecipesTab storeId={activeStoreId} />
          </TabsContent>
        )}
      </Tabs>
    </div>
  )
}
