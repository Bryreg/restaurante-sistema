import { Search } from "lucide-react"
import { useMemo, useState } from "react"

import { useSession } from "@/app/session"
import type { CatalogComboOut, CatalogProductOut } from "@/api/catalog"
import type { FavoriteOut, OrderChannel } from "@/api/orders"
import { EmptyState } from "@/components/EmptyState"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { formatCOP } from "@/lib/money"

import { useCatalog, useFavorites } from "./hooks"
import { channelPriceKey } from "./lib"

export interface CatalogPanelProps {
  channel: OrderChannel
  onSelectProduct: (product: CatalogProductOut) => void
  onSelectCombo: (combo: CatalogComboOut) => void
}

function ProductButton({
  product,
  channel,
  showDailyCount,
  onSelect,
}: {
  product: CatalogProductOut
  channel: OrderChannel
  showDailyCount: boolean
  onSelect: () => void
}) {
  const priceKey = channelPriceKey(channel)
  return (
    <button
      type="button"
      disabled={!product.available}
      onClick={onSelect}
      aria-label={`Agregar ${product.name}`}
      className="flex min-h-[64px] flex-col items-start gap-1 rounded-lg border p-3 text-left text-sm transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50"
    >
      <span className="font-medium">{product.name}</span>
      <span className="flex w-full items-center justify-between text-muted-foreground">
        <span>{formatCOP(product.prices[priceKey])}</span>
        {!product.available ? (
          <Badge variant="destructive">Agotado</Badge>
        ) : showDailyCount && product.daily_remaining !== null && product.daily_remaining !== undefined ? (
          <Badge variant="outline">Quedan {product.daily_remaining}</Badge>
        ) : null}
      </span>
    </button>
  )
}

function ComboButton({ combo, onSelect }: { combo: CatalogComboOut; onSelect: () => void }) {
  return (
    <button
      type="button"
      disabled={!combo.active_now}
      onClick={onSelect}
      aria-label={`Agregar combo ${combo.name}`}
      className="flex min-h-[64px] flex-col items-start gap-1 rounded-lg border p-3 text-left text-sm transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50"
    >
      <span className="font-medium">{combo.name}</span>
      <span className="flex w-full items-center justify-between text-muted-foreground">
        <span>{formatCOP(combo.price)}</span>
        <Badge variant={combo.active_now ? "default" : "outline"}>
          {combo.active_now ? "Disponible ahora" : "Fuera de horario"}
        </Badge>
      </span>
    </button>
  )
}

/**
 * Carta por categorías, búsqueda, favoritos y menú del día — misión de
 * `frontend-comanda`. La pestaña "Menú del día" va PRIMERO cuando hay al
 * menos un combo `active_now` y `pos.daily_menu` está encendida.
 */
export function CatalogPanel({ channel, onSelectProduct, onSelectCombo }: CatalogPanelProps): React.JSX.Element {
  const { hasFeature } = useSession()
  const catalog = useCatalog()
  const favoritesEnabled = true
  const favorites = useFavorites(favoritesEnabled)
  const [search, setSearch] = useState("")

  const products = catalog.data?.products ?? []
  const combos = catalog.data?.combos ?? []
  const categories = catalog.data?.categories ?? []

  const activeCombos = combos.filter((c) => c.active_now)
  const showDailyMenuTab = hasFeature("pos.daily_menu") && activeCombos.length > 0
  const showDailyCount = hasFeature("pos.daily_count")

  const favoriteProducts = useMemo(() => {
    const byId = new Map(products.map((p) => [p.id, p]))
    return (favorites.data ?? [])
      .map((f: FavoriteOut) => byId.get(f.product_id))
      .filter((p): p is CatalogProductOut => p !== undefined)
  }, [favorites.data, products])

  const searchResults = useMemo(() => {
    const query = search.trim().toLowerCase()
    if (query === "") return null
    return products.filter((p) => p.name.toLowerCase().includes(query))
  }, [search, products])

  const defaultTab = showDailyMenuTab ? "daily_menu" : "favorites"
  const [tab, setTab] = useState(defaultTab)

  if (catalog.isLoading) {
    return <p className="text-sm text-muted-foreground">Cargando la carta…</p>
  }

  return (
    <div className="space-y-3">
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
        <Input
          className="h-11 pl-9"
          placeholder="Buscar en la carta…"
          aria-label="Buscar producto"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
      </div>

      {searchResults ? (
        searchResults.length === 0 ? (
          <EmptyState title="Ningún producto coincide con la búsqueda" />
        ) : (
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {searchResults.map((product) => (
              <ProductButton
                key={product.id}
                product={product}
                channel={channel}
                showDailyCount={showDailyCount}
                onSelect={() => onSelectProduct(product)}
              />
            ))}
          </div>
        )
      ) : (
        <Tabs value={tab} onValueChange={(value) => setTab(String(value))}>
          <TabsList className="h-auto flex-wrap">
            {showDailyMenuTab ? <TabsTrigger value="daily_menu">Menú del día</TabsTrigger> : null}
            <TabsTrigger value="favorites">Favoritos</TabsTrigger>
            {categories.map((category) => (
              <TabsTrigger key={category.id} value={String(category.id)}>
                {category.name}
              </TabsTrigger>
            ))}
          </TabsList>

          {showDailyMenuTab ? (
            <TabsContent value="daily_menu">
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                {activeCombos.map((combo) => (
                  <ComboButton key={combo.id} combo={combo} onSelect={() => onSelectCombo(combo)} />
                ))}
              </div>
            </TabsContent>
          ) : null}

          <TabsContent value="favorites">
            {favorites.isLoading ? (
              <p className="text-sm text-muted-foreground">Cargando favoritos…</p>
            ) : favoriteProducts.length === 0 ? (
              <EmptyState title="Todavía no hay ventas para armar favoritos" description="Se arman con lo más vendido de los últimos 7 días." />
            ) : (
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                {favoriteProducts.map((product) => (
                  <ProductButton
                    key={product.id}
                    product={product}
                    channel={channel}
                    showDailyCount={showDailyCount}
                    onSelect={() => onSelectProduct(product)}
                  />
                ))}
              </div>
            )}
          </TabsContent>

          {categories.map((category) => {
            const categoryProducts = products.filter((p) => p.category_id === category.id)
            return (
              <TabsContent key={category.id} value={String(category.id)}>
                {categoryProducts.length === 0 ? (
                  <EmptyState title="Esta categoría todavía no tiene productos" />
                ) : (
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                    {categoryProducts.map((product) => (
                      <ProductButton
                        key={product.id}
                        product={product}
                        channel={channel}
                        showDailyCount={showDailyCount}
                        onSelect={() => onSelectProduct(product)}
                      />
                    ))}
                  </div>
                )}
              </TabsContent>
            )
          })}
        </Tabs>
      )}
    </div>
  )
}

export default CatalogPanel
