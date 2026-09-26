import { Search, SlidersHorizontal } from "lucide-react"
import { useEffect, useMemo, useRef, useState } from "react"

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
/**
 * La fila de categorías: 56 px de alto por pestaña. En angosto se desliza de
 * costado (nunca se parte en dos renglones que empujan la carta hacia
 * abajo); desde `lg` —la tablet apaisada— es una columna de 11rem.
 */
const TAB_LIST_CLASS =
  "w-full max-w-full gap-2 bg-transparent p-0 group-data-horizontal/tabs:h-auto group-data-horizontal/tabs:overflow-x-auto lg:w-44 lg:shrink-0 lg:flex-col lg:items-stretch lg:overflow-visible"
const TAB_TRIGGER_CLASS =
  "h-14 min-h-14 flex-none rounded-lg border border-border bg-background px-4 text-base font-semibold text-foreground data-active:border-primary data-active:bg-primary data-active:text-primary-foreground dark:text-foreground dark:data-active:border-primary dark:data-active:bg-primary dark:data-active:text-primary-foreground lg:w-full lg:justify-start lg:whitespace-normal lg:text-left"
const SOLD_OUT_CLASS ="opacity-60 bg-[repeating-linear-gradient(135deg,transparent_0_8px,var(--muted)_8px_10px)]"

/** Cuánto hay que dejar el dedo sobre un plato para abrir sus opciones. */
const LONG_PRESS_MS = 500

/**
 * Mantener apretado un plato abre sus opciones (nota, curso, asiento,
 * adiciones) — el mismo atajo que «Elegir opciones», sin ir a buscar el
 * interruptor. El toque corto sigue sumando directo. El `click` que el
 * navegador dispara al soltar después de una pulsación larga se descarta:
 * sin eso el plato entraba dos veces (una con opciones y otra directo).
 */
function useLongPress(onLongPress: (() => void) | undefined) {
  const timer = useRef<number | null>(null)
  const fired = useRef(false)

  function clear() {
    if (timer.current !== null) {
      window.clearTimeout(timer.current)
      timer.current = null
    }
  }

  useEffect(() => clear, [])

  if (!onLongPress) return { handlers: {}, consumeClick: () => false }

  function fire() {
    clear()
    if (fired.current) return
    fired.current = true
    onLongPress?.()
  }

  return {
    handlers: {
      onPointerDown: () => {
        fired.current = false
        clear()
        timer.current = window.setTimeout(fire, LONG_PRESS_MS)
      },
      onPointerUp: clear,
      onPointerLeave: clear,
      onPointerCancel: clear,
      // En Android la pulsación larga dispara el menú contextual: es la
      // misma intención, y el menú del navegador no sirve de nada acá.
      onContextMenu: (event: React.MouseEvent) => {
        event.preventDefault()
        fire()
      },
    },
    /** `true` si este click es el de soltar una pulsación larga: se ignora. */
    consumeClick: () => {
      if (!fired.current) return false
      fired.current = false
      return true
    },
  }
}

function ProductButton({
  product,
  channel,
  showDailyCount,
  unsentQty,
  onSelect,
  onLongPress,
}: {
  product: CatalogProductOut
  channel: OrderChannel
  showDailyCount: boolean
  unsentQty: number
  onSelect: () => void
  onLongPress?: () => void
}) {
  const priceKey = channelPriceKey(channel)
  const soldOut = !product.available
  const longPress = useLongPress(soldOut ? undefined : onLongPress)
  return (
    <button
      type="button"
      disabled={soldOut}
      {...longPress.handlers}
      onClick={() => {
        if (longPress.consumeClick()) return
        onSelect()
      }}
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

  // La pestaña por defecto se DERIVA en cada render hasta que la persona
  // elija una: antes se congelaba en el primer render, con la carta todavía
  // cargando (sin combos), y «Menú del día» nunca quedaba elegida.
  const defaultTab = showDailyMenuTab ? "daily_menu" : "favorites"
  const [chosenTab, setChosenTab] = useState<string | null>(null)
  const tab = chosenTab ?? defaultTab

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
            onLongPress={
              quickAdd
                ? () => {
                    onSelectProduct(product, { withOptions: true })
                    setWithOptions(false)
                  }
                : undefined
            }
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
        <Tabs value={tab} onValueChange={(value) => setChosenTab(String(value))} className="gap-3 lg:flex-row! lg:items-start">
          {/* Pestañas de 56 px (antes 27): en vertical, una fila que se
              desliza de costado; en la tablet apaisada, una columna al lado
              de los platos, que es donde el pulgar llega sin tapar la carta. */}
          <TabsList className={TAB_LIST_CLASS}>
            {showDailyMenuTab ? (
              <TabsTrigger value="daily_menu" className={TAB_TRIGGER_CLASS}>
                Menú del día
              </TabsTrigger>
            ) : null}
            <TabsTrigger value="favorites" className={TAB_TRIGGER_CLASS}>
              Favoritos
            </TabsTrigger>
            {categories.map((category) => (
              <TabsTrigger key={category.id} value={String(category.id)} className={TAB_TRIGGER_CLASS}>
                {category.name}
              </TabsTrigger>
            ))}
          </TabsList>

          {showDailyMenuTab ? (
            <TabsContent value="daily_menu" className="min-w-0">
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

          <TabsContent value="favorites" className="min-w-0">
            {favorites.isLoading ? (
              <Cargando texto="Cargando favoritos…" />
            ) : favoriteProducts.length === 0 ? (
              <EmptyState title="Todavía no hay ventas para armar favoritos" description="Se arman con lo más vendido de los últimos 7 días." />
            ) : renderProducts(favoriteProducts)}
          </TabsContent>

          {categories.map((category) => {
            const categoryProducts = products.filter((p) => p.category_id === category.id)
            return (
              <TabsContent key={category.id} value={String(category.id)} className="min-w-0">
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
