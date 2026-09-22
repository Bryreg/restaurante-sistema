import { Search, X } from "lucide-react"
import { useMemo, useState } from "react"

import { useSession } from "@/app/session"
import type { CatalogComboOut, CatalogProductOut } from "@/api/catalog"
import type { FavoriteOut, OrderChannel } from "@/api/orders"
import { EmptyState } from "@/components/EmptyState"
import { Input } from "@/components/ui/input"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { formatCOP } from "@/lib/money"

import { useCatalog, useFavorites } from "./hooks"
import { channelPriceKey } from "./lib"

/**
 * **La tarjeta de plato de `m2b`**: 96 px de alto mínimo, el nombre arriba y
 * el precio anclado al pie con `mt-auto`, para que toda la grilla tenga la
 * plata a la misma altura y el pulgar la encuentre sin leer. El borde se pone
 * azul al pasar por encima — es la única señal de que la tarjeta es un botón.
 */
const PLATO =
  "flex min-h-[96px] min-w-0 flex-col items-start gap-1.5 rounded-[10px] border border-input bg-card p-3 text-left " +
  "transition-colors hover:border-primary hover:bg-accent active:translate-y-px " +
  "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring " +
  "disabled:opacity-50 disabled:hover:border-input disabled:hover:bg-card"

/**
 * La grilla se llena sola (`auto-fill`, mínimo 168 px) en vez de fijar dos o
 * tres columnas: la carta se ve en tablet horizontal y en vertical, y una
 * grilla de columnas fijas deja media pantalla vacía en la primera y aprieta
 * los nombres en la segunda.
 */
const GRILLA = "grid gap-2.5 [grid-template-columns:repeat(auto-fill,minmax(168px,1fr))]"

/**
 * Las pastillas de categoría: redondas, ancho de su texto, y la activa en
 * negro como en `m2b`.
 *
 * **El estado activo se marca con `data-active`, no con `data-state="active"`.**
 * Este `Tabs` está construido sobre `@base-ui/react`, que usa el primero. Con
 * el segundo las clases compilan, Tailwind las emite y no falla nada — la
 * pastilla activa simplemente se dibuja igual que las demás, y la pantalla
 * deja de decir en qué categoría está parado el mesero.
 */
const CATEGORIA =
  "h-auto min-h-11 flex-none rounded-full border border-input bg-card px-4 text-[0.94rem] font-normal text-foreground " +
  "hover:bg-muted data-active:border-foreground data-active:bg-foreground data-active:text-background data-active:shadow-none"

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
  // El aviso de la maqueta: un renglón ámbar corto, no una pastilla. Va entre
  // el nombre y el precio porque es lo que cambia la decisión de cantarlo.
  const aviso = !product.available
    ? "Agotado"
    : showDailyCount && product.daily_remaining !== null && product.daily_remaining !== undefined
      ? `Quedan ${product.daily_remaining}`
      : null
  return (
    <button
      type="button"
      disabled={!product.available}
      onClick={onSelect}
      aria-label={`Agregar ${product.name}`}
      className={PLATO}
    >
      <span className="text-[0.94rem] leading-snug [overflow-wrap:anywhere]">{product.name}</span>
      {aviso ? <span className="text-xs text-warning">{aviso}</span> : null}
      <span className="mt-auto text-[1.06rem] font-bold tabular-nums">{formatCOP(product.prices[priceKey])}</span>
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
      className={PLATO}
    >
      <span className="text-[0.94rem] leading-snug [overflow-wrap:anywhere]">{combo.name}</span>
      {!combo.active_now ? <span className="text-xs text-warning">Fuera de horario</span> : null}
      <span className="mt-auto text-[1.06rem] font-bold tabular-nums">{formatCOP(combo.price)}</span>
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
  //: El buscador nace cerrado y ocupa el lugar de una pastilla al abrirse.
  const [buscando, setBuscando] = useState(false)

  if (catalog.isLoading) {
    return <p className="text-sm text-muted-foreground">Cargando la carta…</p>
  }

  return (
    <div className="space-y-3">
      <Tabs value={tab} onValueChange={(value) => setTab(String(value))}>
        {/* **UNA sola fila de pastillas** (`m2b`). El buscador era una banda
            propia de 44 px encima de las categorías: en una tablet, eso es
            una fila de platos menos, y el mesero que conoce la carta no lo
            usa nunca —toca la categoría—. Ahora es la última pastilla de la
            misma fila y se abre en su lugar: mismo alcance, ningún píxel de
            cromo. */}
        <div className="flex flex-wrap items-center gap-1.5">
          <TabsList className="h-auto flex-wrap justify-start gap-1.5 bg-transparent p-0">
            {showDailyMenuTab ? (
              <TabsTrigger value="daily_menu" className={CATEGORIA}>
                Menú del día
              </TabsTrigger>
            ) : null}
            <TabsTrigger value="favorites" className={CATEGORIA}>
              Favoritos
            </TabsTrigger>
            {categories.map((category) => (
              <TabsTrigger key={category.id} value={String(category.id)} className={CATEGORIA}>
                {category.name}
              </TabsTrigger>
            ))}
          </TabsList>

          {buscando ? (
            <div className="relative min-w-[13rem] flex-1">
              <Search
                className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
                aria-hidden="true"
              />
              <Input
                autoFocus
                className="h-11 pr-9 pl-9"
                placeholder="Buscar en la carta…"
                aria-label="Buscar producto"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    setSearch("")
                    setBuscando(false)
                  }
                }}
              />
              <button
                type="button"
                aria-label="Cerrar la búsqueda"
                className="absolute top-1/2 right-2 -translate-y-1/2 rounded p-1 text-muted-foreground hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                onClick={() => {
                  setSearch("")
                  setBuscando(false)
                }}
              >
                <X className="size-4" aria-hidden="true" />
              </button>
            </div>
          ) : (
            <button
              type="button"
              // `CATEGORIA` viene de `TabsTrigger`, que ya trae su propio
              // `inline-flex`; un `<button>` pelado no, y sin esto el icono
              // y la palabra se apilaban en dos renglones y la pastilla
              // quedaba más alta que las otras.
              className={`${CATEGORIA} inline-flex items-center justify-center gap-2 whitespace-nowrap`}
              aria-label="Buscar en la carta"
              onClick={() => setBuscando(true)}
            >
              <Search className="size-4" aria-hidden="true" />
              Buscar
            </button>
          )}
        </div>

        {searchResults ? (
          searchResults.length === 0 ? (
            <div className="mt-3">
              <EmptyState title="Ningún producto coincide con la búsqueda" />
            </div>
          ) : (
            <div className={`mt-3 ${GRILLA}`}>
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
          <>

          {showDailyMenuTab ? (
            <TabsContent value="daily_menu">
              <div className={GRILLA}>
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
              <div className={GRILLA}>
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
                  <div className={GRILLA}>
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
          </>
        )}
      </Tabs>
    </div>
  )
}

export default CatalogPanel
