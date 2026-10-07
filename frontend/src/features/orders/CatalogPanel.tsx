import { useQueryClient } from "@tanstack/react-query"
import { Ban, Search, SlidersHorizontal } from "lucide-react"
import { useEffect, useMemo, useRef, useState } from "react"

import { useSession } from "@/app/session"
import { newIdempotencyKey } from "@/api/client"
import { setProductAvailability, type CatalogComboOut, type CatalogProductOut } from "@/api/catalog"
import type { FavoriteOut, OrderChannel } from "@/api/orders"
import { Cargando } from "@/components/Cargando"
import { SegmentadoTactil } from "@/components/admin"
import { EmptyState } from "@/components/EmptyState"
import { Input } from "@/components/ui/input"
import { errorMessage } from "@/lib/errors"
import { formatCOP } from "@/lib/money"
import { cn } from "@/lib/utils"

import { CATALOG_QUERY_KEY, useCatalog, useFavorites } from "./hooks"
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
 * mentalmente»). Handoff «Burbujas» 9c: pastilla de tinta de 28 px, arriba a
 * la derecha. Va `aria-hidden`: el mismo número viaja en el `aria-label` del
 * botón, que es lo que un lector de pantalla lee.
 */
function UnsentBadge({ qty }: { qty: number }) {
  if (qty <= 0) return null
  return (
    <span
      aria-hidden="true"
      data-slot="unsent-badge"
      className="absolute top-3 right-3 grid h-7 min-w-7 place-items-center rounded-[14px] bg-foreground px-2 text-[13px] font-semibold tabular-nums text-card"
    >
      {qty}
    </span>
  )
}

function unsentSuffix(qty: number): string {
  return qty > 0 ? `, ${qty} en la ronda` : ""
}

/**
 * Tarjeta de plato: un pozo de 96 px (handoff «Burbujas» 9c), radio 18,
 * relleno 14 × 16; el nombre en 16/600 y el precio en 14 gris. Lo agotado
 * sigue visible —rayado, con el nombre tachado y «Agotado» antes del
 * precio— para que el mesero lo sepa antes de ofrecerlo, pero no se puede
 * tocar (el backend corta igual con `PRODUCT_UNAVAILABLE`).
 */
const CARD_CLASS =
  "relative flex min-h-[96px] min-w-0 flex-col items-start justify-between gap-1.5 rounded-[18px] bg-muted px-4 py-3.5 text-left text-foreground transition-colors hover:bg-fill-strong focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring active:bg-fill-strong disabled:cursor-not-allowed disabled:hover:bg-muted"
const CARD_NAME_CLASS = "pr-[30px] text-base leading-[1.25] font-semibold"
const CARD_META_CLASS = "flex w-full flex-wrap items-center justify-between gap-1 text-sm text-muted-foreground"
// El rayado es `background-image`: el `hover:bg-*` de la tarjeta sólo mueve
// el color de fondo, así que no lo tapa.
const SOLD_OUT_CLASS = "opacity-60 bg-[repeating-linear-gradient(135deg,transparent_0_8px,var(--border)_8px_10px)]"
/** Una pastilla blanca chica dentro del pozo («Quedan 4», «Disponible ahora»). */
const CARD_PILL_CLASS = "inline-flex h-6 items-center rounded-xl bg-card px-2.5 text-xs font-semibold text-muted-foreground"
/** Los platos: 3 columnas con 8 px entre pozos (2 en la tablet vertical). */
const GRID_CLASS = "grid grid-cols-2 content-start gap-2 sm:grid-cols-3"
/** Herramientas de la carta (buscar, «Elegir opciones», «Agotados»): pozos de 48 px. */
const TOOL_CLASS =
  "inline-flex h-12 shrink-0 items-center gap-2 rounded-2xl px-4 text-[15px] font-semibold transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none [&_svg]:size-[18px]"

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
  soldOutMode = false,
  togglingSoldOut = false,
  onToggleSoldOut,
}: {
  product: CatalogProductOut
  channel: OrderChannel
  showDailyCount: boolean
  unsentQty: number
  onSelect: () => void
  onLongPress?: () => void
  /** «Agotados» encendido: el toque marca o desmarca el plato, no lo suma. */
  soldOutMode?: boolean
  togglingSoldOut?: boolean
  onToggleSoldOut?: () => void
}) {
  const priceKey = channelPriceKey(channel)
  const soldOut = !product.available
  const longPress = useLongPress(soldOut || soldOutMode ? undefined : onLongPress)
  const label = soldOutMode
    ? soldOut
      ? `Volver a ofrecer ${product.name}`
      : `Marcar agotado: ${product.name}`
    : soldOut
      ? `${product.name}, agotado`
      : `Agregar ${product.name}${unsentSuffix(unsentQty)}`
  return (
    <button
      type="button"
      disabled={soldOutMode ? togglingSoldOut : soldOut}
      aria-pressed={soldOutMode ? soldOut : undefined}
      {...longPress.handlers}
      onClick={() => {
        if (soldOutMode) {
          onToggleSoldOut?.()
          return
        }
        if (longPress.consumeClick()) return
        onSelect()
      }}
      aria-label={label}
      className={cn(
        CARD_CLASS,
        soldOut && SOLD_OUT_CLASS,
        soldOutMode && "shadow-[inset_0_0_0_1.5px_var(--destructive)]",
      )}
    >
      <UnsentBadge qty={unsentQty} />
      <span className={cn(CARD_NAME_CLASS, soldOut && "line-through")}>{product.name}</span>
      <span className={CARD_META_CLASS}>
        <span className="tabular-nums">
          {soldOut ? <span className="font-semibold">Agotado</span> : null}
          {soldOut ? " · " : null}
          {formatCOP(product.prices[priceKey])}
        </span>
        {!soldOut && showDailyCount && product.daily_remaining !== null && product.daily_remaining !== undefined ? (
          <span className={CARD_PILL_CLASS}>Quedan {product.daily_remaining}</span>
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
      <span className={CARD_NAME_CLASS}>{combo.name}</span>
      <span className={CARD_META_CLASS}>
        <span className="tabular-nums">{formatCOP(combo.price)}</span>
        <span className={cn(CARD_PILL_CLASS, combo.active_now && "text-success")}>
          {combo.active_now ? "Disponible ahora" : "Fuera de horario"}
        </span>
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
  const favorites = useFavorites()
  const [search, setSearch] = useState("")
  // «Elegir opciones» vale para UN plato, como la tecla de mayúsculas: el
  // toque siguiente vuelve a sumar directo, que es lo que pasa casi siempre.
  const [withOptions, setWithOptions] = useState(false)
  // Lista 86 (auditoría p5): con «Agotados» encendido, cada toque marca o
  // desmarca un plato. Queda encendido hasta apagarlo: cuando se acaba algo
  // en la cocina suele acabarse más de una cosa.
  const queryClient = useQueryClient()
  const [soldOutMode, setSoldOutMode] = useState(false)
  const [togglingId, setTogglingId] = useState<number | null>(null)
  const [soldOutError, setSoldOutError] = useState<string | null>(null)
  const [soldOutNotice, setSoldOutNotice] = useState<string | null>(null)

  async function toggleSoldOut(product: CatalogProductOut) {
    setTogglingId(product.id)
    setSoldOutError(null)
    try {
      const updated = await setProductAvailability(product.id, { available: !product.available }, newIdempotencyKey())
      setSoldOutNotice(updated.available ? `«${product.name}» vuelve a estar disponible.` : `«${product.name}» quedó agotado.`)
      await queryClient.invalidateQueries({ queryKey: CATALOG_QUERY_KEY })
    } catch (err) {
      setSoldOutError(errorMessage(err))
    } finally {
      setTogglingId(null)
    }
  }

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
  const tabOptions = [
    ...(showDailyMenuTab ? [{ value: "daily_menu", label: "Menú del día" }] : []),
    { value: "favorites", label: "Favoritos" },
    ...categories.map((category) => ({ value: String(category.id), label: category.name })),
  ]
  // Una pestaña elegida que ya no está (la carta cambió por debajo) vuelve a la de por defecto.
  const tab = chosenTab !== null && tabOptions.some((option) => option.value === chosenTab) ? chosenTab : defaultTab

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
      <div className={GRID_CLASS}>
        {list.map((product) => (
          <ProductButton
            key={product.id}
            product={product}
            channel={channel}
            showDailyCount={showDailyCount}
            unsentQty={unsentQty?.products.get(product.id) ?? 0}
            onSelect={() => selectProduct(product)}
            soldOutMode={soldOutMode}
            togglingSoldOut={togglingId === product.id}
            onToggleSoldOut={() => void toggleSoldOut(product)}
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

  function renderTab() {
    if (tab === "daily_menu" && showDailyMenuTab) {
      return (
        <div className={GRID_CLASS}>
          {activeCombos.map((combo) => (
            <ComboButton
              key={combo.id}
              combo={combo}
              unsentQty={unsentQty?.combos.get(combo.id) ?? 0}
              onSelect={() => onSelectCombo(combo)}
            />
          ))}
        </div>
      )
    }
    const category = categories.find((c) => String(c.id) === tab)
    if (category) {
      const categoryProducts = products.filter((p) => p.category_id === category.id)
      return categoryProducts.length === 0 ? (
        <EmptyState title="Esta categoría todavía no tiene productos" />
      ) : (
        renderProducts(categoryProducts)
      )
    }
    // «Favoritos».
    if (favorites.isLoading) return <Cargando texto="Cargando favoritos…" />
    return favoriteProducts.length === 0 ? (
      <EmptyState title="Todavía no hay ventas para armar favoritos" description="Se arman con lo más vendido de los últimos 7 días." />
    ) : (
      renderProducts(favoriteProducts)
    )
  }

  if (catalog.isLoading) {
    return <Cargando texto="Cargando la carta…" />
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3.5">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[180px] flex-1">
          <Search
            className="pointer-events-none absolute top-1/2 left-4 size-[18px] -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            className="h-12 rounded-2xl border-0 bg-muted pl-11 text-[15px] shadow-none dark:bg-muted"
            placeholder="Buscar en la carta…"
            aria-label="Buscar producto"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </div>
        {quickAdd ? (
          <button
            type="button"
            aria-pressed={withOptions}
            className={cn(TOOL_CLASS, withOptions ? "bg-foreground text-card" : "bg-muted text-foreground hover:bg-fill-strong")}
            onClick={() => setWithOptions((on) => !on)}
          >
            <SlidersHorizontal aria-hidden="true" />
            Elegir opciones
          </button>
        ) : null}
        <button
          type="button"
          aria-pressed={soldOutMode}
          className={cn(
            TOOL_CLASS,
            soldOutMode ? "bg-destructive-soft text-destructive" : "bg-muted text-foreground hover:bg-fill-strong",
          )}
          onClick={() => {
            setSoldOutMode((on) => !on)
            setSoldOutError(null)
            setSoldOutNotice(null)
          }}
        >
          <Ban aria-hidden="true" />
          Agotados
        </button>
      </div>
      {soldOutMode ? (
        <p className="rounded-2xl bg-destructive-soft px-4 py-3 text-sm text-destructive">
          Tocá un plato para marcarlo agotado, o uno agotado para volver a ofrecerlo. Apagá «Agotados» para seguir
          vendiendo.
        </p>
      ) : null}
      {soldOutError ? (
        <p role="alert" className="rounded-2xl bg-destructive-soft px-4 py-3 text-sm font-semibold text-destructive">
          {soldOutError}
        </p>
      ) : null}
      <p role="status" className={soldOutNotice ? "px-1 text-sm font-semibold" : "sr-only"}>
        {soldOutNotice ?? ""}
      </p>
      {quickAdd ? (
        <p className="sr-only" aria-live="polite">
          {withOptions
            ? "El próximo plato abre sus opciones: nota, curso, asiento y adiciones."
            : "Un toque suma el plato. Si el plato pide algo (término, acompañante), se pregunta antes."}
        </p>
      ) : null}

      {searchResults ? null : (
        // Handoff «Burbujas» 9c: las categorías en el interruptor segmentado
        // de 48 px, alineado al inicio; si no entran, se parte en dos filas.
        <SegmentadoTactil
          etiqueta="Categorías de la carta"
          opciones={tabOptions}
          valor={tab}
          onChange={(value) => setChosenTab(value)}
          alto={48}
          className="self-start"
        />
      )}

      <div className="min-h-0 flex-1 overflow-y-auto" data-slot="catalog-dishes">
        {searchResults ? (
          searchResults.length === 0 ? (
            <EmptyState title="Ningún producto coincide con la búsqueda" />
          ) : (
            renderProducts(searchResults)
          )
        ) : (
          renderTab()
        )}
      </div>
    </div>
  )
}

export default CatalogPanel
