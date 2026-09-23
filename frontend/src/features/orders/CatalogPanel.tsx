import { Search, SlidersHorizontal } from "lucide-react"
import { useMemo, useState } from "react"

import { useSession } from "@/app/session"
import type { CatalogComboOut, CatalogProductOut } from "@/api/catalog"
import type { FavoriteOut, OrderChannel } from "@/api/orders"
import { Cargando } from "@/components/Cargando"
import { EmptyState } from "@/components/EmptyState"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { formatCOP } from "@/lib/money"
import { cn } from "@/lib/utils"

import { useCatalog, useFavorites } from "./hooks"
import { channelPriceKey } from "./lib"

export interface CatalogPanelProps {
  channel: OrderChannel
  /**
   * `withOptions`: la persona pidió ver las opciones del plato (nota, curso,
   * asiento, modificadores opcionales) en vez de sumarlo directo. Sólo llega
   * en `true` si `quickAdd` está encendido y tocó «Elegir opciones» antes.
   */
  onSelectProduct: (product: CatalogProductOut, options?: { withOptions: boolean }) => void
  onSelectCombo: (combo: CatalogComboOut) => void
  /**
   * Unidades de la ronda sin enviar por producto y por combo (de
   * `unsentQtyByProduct`): el número de la insignia de cada plato. Sin esto
   * la carta no pinta insignias.
   */
  unsentQty?: { products: Map<number, number>; combos: Map<number, number> }
  /** Un toque suma directo: muestra el interruptor «Elegir opciones». */
  quickAdd?: boolean
}

/**
 * Insignia con las unidades del plato en la ronda sin enviar (Momento 1 de
 * `docs/diseno/propuesta.html`: «el número sobre el plato evita contar
 * mentalmente»). Va `aria-hidden`: el mismo número viaja en el `aria-label`
 * del botón, que es lo que un lector de pantalla lee.
 */
function UnsentBadge({ qty }: { qty: number }) {
  if (qty <= 0) return null
  return (
    <span
      aria-hidden="true"
      data-slot="unsent-badge"
      className="absolute top-2 right-2 grid h-6 min-w-6 place-items-center rounded-full bg-primary px-1.5 text-xs font-extrabold tabular-nums text-primary-foreground"
    >
      {qty}
    </span>
  )
}

function unsentSuffix(qty: number): string {
  return qty > 0 ? `, ${qty} en la ronda` : ""
}

/**
 * Tarjeta de plato. Lo agotado sigue visible —rayado, con el nombre
 * tachado y «Agotado» antes del precio— para que el mesero lo sepa antes de
 * ofrecerlo, pero no se puede tocar (el backend corta igual con
 * `PRODUCT_UNAVAILABLE`).
 */
const CARD_CLASS =
  "relative flex min-h-[74px] min-w-0 flex-col items-start justify-between gap-1 rounded-xl border bg-card p-3 pr-9 text-left transition-colors hover:bg-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring active:bg-muted disabled:cursor-not-allowed disabled:hover:bg-card"
// El rayado es `background-image`: el `hover:bg-*` de la tarjeta sólo mueve
// el color de fondo, así que no lo tapa.
const SOLD_OUT_CLASS = "opacity-60 bg-[repeating-linear-gradient(135deg,transparent_0_8px,var(--muted)_8px_10px)]"

function ProductButton({
  product,
  channel,
  showDailyCount,
  unsentQty,
  onSelect,
}: {
  product: CatalogProductOut
  channel: OrderChannel
  showDailyCount: boolean
  unsentQty: number
  onSelect: () => void
}) {
  const priceKey = channelPriceKey(channel)
  const soldOut = !product.available
  return (
    <button
      type="button"
      disabled={soldOut}
      onClick={onSelect}
      aria-label={soldOut ? `${product.name}, agotado` : `Agregar ${product.name}${unsentSuffix(unsentQty)}`}
      className={cn(CARD_CLASS, soldOut && SOLD_OUT_CLASS)}
    >
      <UnsentBadge qty={unsentQty} />
      <span className={cn("text-[15px] leading-tight font-semibold", soldOut && "line-through")}>{product.name}</span>
      <span className="flex w-full flex-wrap items-center justify-between gap-1 text-sm text-muted-foreground">
        <span className="tabular-nums">
          {soldOut ? <span className="font-semibold">Agotado</span> : null}
          {soldOut ? " · " : null}
          {formatCOP(product.prices[priceKey])}
        </span>
        {!soldOut && showDailyCount && product.daily_remaining !== null && product.daily_remaining !== undefined ? (
          <Badge variant="outline">Quedan {product.daily_remaining}</Badge>
        ) : null}
      </span>
    </button>
  )
}

function ComboButton({ combo, unsentQty, onSelect }: { combo: CatalogComboOut; unsentQty: number; onSelect: () => void }) {
  return (
    <button
      type="button"
      disabled={!combo.active_now}
      onClick={onSelect}
      aria-label={`Agregar combo ${combo.name}${unsentSuffix(unsentQty)}`}
      className={cn(CARD_CLASS, !combo.active_now && SOLD_OUT_CLASS)}
    >
      <UnsentBadge qty={unsentQty} />
      <span className="text-[15px] leading-tight font-semibold">{combo.name}</span>
      <span className="flex w-full flex-wrap items-center justify-between gap-1 text-sm text-muted-foreground">
        <span className="tabular-nums">{formatCOP(combo.price)}</span>
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
export function CatalogPanel({
  channel,
  onSelectProduct,
  onSelectCombo,
  unsentQty,
  quickAdd = false,
}: CatalogPanelProps): React.JSX.Element {
  const { hasFeature } = useSession()
  const catalog = useCatalog()
  const favoritesEnabled = true
  const favorites = useFavorites(favoritesEnabled)
  const [search, setSearch] = useState("")
  // «Elegir opciones» vale para UN plato, como la tecla de mayúsculas: el
  // toque siguiente vuelve a sumar directo, que es lo que pasa casi siempre.
  const [withOptions, setWithOptions] = useState(false)

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

  function selectProduct(product: CatalogProductOut) {
    if (quickAdd) {
      onSelectProduct(product, { withOptions })
      setWithOptions(false)
      return
    }
    onSelectProduct(product)
  }

  function renderProducts(list: CatalogProductOut[]) {
    return (
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {list.map((product) => (
          <ProductButton
            key={product.id}
            product={product}
            channel={channel}
            showDailyCount={showDailyCount}
            unsentQty={unsentQty?.products.get(product.id) ?? 0}
            onSelect={() => selectProduct(product)}
          />
        ))}
      </div>
    )
  }

  if (catalog.isLoading) {
    return <Cargando texto="Cargando la carta…" />
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
          <Input
            className="h-11 min-h-[var(--control-min-h)] pl-9"
            placeholder="Buscar en la carta…"
            aria-label="Buscar producto"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </div>
        {quickAdd ? (
          <Button
            type="button"
            variant={withOptions ? "secondary" : "outline"}
            aria-pressed={withOptions}
            className="h-11 px-4"
            onClick={() => setWithOptions((on) => !on)}
          >
            <SlidersHorizontal aria-hidden="true" />
            Elegir opciones
          </Button>
        ) : null}
      </div>
      {quickAdd ? (
        <p className="text-sm text-muted-foreground" aria-live="polite">
          {withOptions
            ? "El próximo plato abre sus opciones: nota, curso, asiento y adiciones."
            : "Un toque suma el plato. Si el plato pide algo (término, acompañante), se pregunta antes."}
        </p>
      ) : null}

      {searchResults ? (
        searchResults.length === 0 ? (
          <EmptyState title="Ningún producto coincide con la búsqueda" />
        ) : renderProducts(searchResults)
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
                  <ComboButton
                    key={combo.id}
                    combo={combo}
                    unsentQty={unsentQty?.combos.get(combo.id) ?? 0}
                    onSelect={() => onSelectCombo(combo)}
                  />
                ))}
              </div>
            </TabsContent>
          ) : null}

          <TabsContent value="favorites">
            {favorites.isLoading ? (
              <Cargando texto="Cargando favoritos…" />
            ) : favoriteProducts.length === 0 ? (
              <EmptyState title="Todavía no hay ventas para armar favoritos" description="Se arman con lo más vendido de los últimos 7 días." />
            ) : renderProducts(favoriteProducts)}
          </TabsContent>

          {categories.map((category) => {
            const categoryProducts = products.filter((p) => p.category_id === category.id)
            return (
              <TabsContent key={category.id} value={String(category.id)}>
                {categoryProducts.length === 0 ? (
                  <EmptyState title="Esta categoría todavía no tiene productos" />
                ) : renderProducts(categoryProducts)}
              </TabsContent>
            )
          })}
        </Tabs>
      )}
    </div>
  )
}

export default CatalogPanel
