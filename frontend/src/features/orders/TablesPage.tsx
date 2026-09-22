import { useQueryClient } from "@tanstack/react-query"
import { ChefHat, Link2, Move, Plus } from "lucide-react"
import { useEffect, useState } from "react"
import { useNavigate } from "react-router-dom"

import {
  createOrder,
  getOrder,
  mergeOrders,
  moveOrder,
  type OrderOut,
  type TableStatusOut,
  type ZoneStatusOut,
} from "@/api/orders"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { EmptyState } from "@/components/EmptyState"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { useSession } from "@/app/session"
import { errorMessage } from "@/lib/errors"

import { AuthorizerDialog } from "./AuthorizerDialog"
import { BarraSitio } from "@/components/pos/BarraSitio"
import { MesaCard, type EstadoMesa } from "@/components/pos/MesaCard"
import { RielCanales, type GrupoCanal } from "@/components/pos/RielCanales"
import { SalonResumen } from "@/components/pos/SalonResumen"
import { Search } from "lucide-react"
import { cn } from "@/lib/utils"
import { formatCOP } from "@/lib/money"
import { elapsedFromSeconds, elapsedLabel } from "./lib"
import { TABLES_STATUS_QUERY_KEY, useAuthorizerFlow, useTablesStatus } from "./hooks"

type Mode = "idle" | "merge" | "move"

const RELOJ_BOGOTA = new Intl.DateTimeFormat("es-CO", {
  timeZone: "America/Bogota",
  hour: "numeric",
  minute: "2-digit",
})

/**
 * «9:00 p. m.» — la hora de una reserva, en hora de Bogotá.
 *
 * La escribe la PANTALLA y no el servidor, igual que los rótulos del riel de
 * canales: el servidor publica el instante y la prosa es presentación. Un
 * servidor que escribe «9:00 p. m.» no se puede traducir ni reusar desde otro
 * cliente.
 */
function horaDeReloj(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? "—" : RELOJ_BOGOTA.format(d)
}


export function TablesPage(): React.JSX.Element {
  const { hasFeature } = useSession()
  const enabled = hasFeature("pos.tables")
  const tablesStatus = useTablesStatus(enabled)
  const navigate = useNavigate()
  const queryClient = useQueryClient()

  const [mode, setMode] = useState<Mode>("idle")
  const [selected, setSelected] = useState<number[]>([])
  const [openTable, setOpenTable] = useState<TableStatusOut | null>(null)
  const [covers, setCovers] = useState<number | null>(null)
  const [openError, setOpenError] = useState<string | null>(null)
  const [openPending, setOpenPending] = useState(false)

  const [mergeDialogOpen, setMergeDialogOpen] = useState(false)
  const [buscando, setBuscando] = useState(false)
  const [busqueda, setBusqueda] = useState("")
  const [mergeTarget, setMergeTarget] = useState<number | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [actionPending, setActionPending] = useState(false);

  const authorizerFlow = useAuthorizerFlow();

  useEffect(() => {
    if (!openTable) return
    setCovers(openTable.seats ?? null)
    setOpenError(null)
  }, [openTable])

  if (!enabled) {
    return (
      <EmptyState
        title="Las mesas no están habilitadas"
        description="Activá «Mesas» en Admin → Funciones para usar esta pantalla."
      />
    )
  }

  const zones: ZoneStatusOut[] = tablesStatus.data?.zones ?? []
  const resumen = tablesStatus.data?.summary
  const tableById = new Map<number, TableStatusOut>()
  for (const zone of zones) {
    for (const table of zone.tables ?? []) {
      tableById.set(table.id, table)
    }
  }

  function resetMode() {
    setMode("idle")
    setSelected([])
    setActionError(null)
  }

  function toggleSelected(table: TableStatusOut) {
    if (mode === "idle") return
    if (mode === "merge") {
      if (table.status === "free") return
      setSelected((prev) => (prev.includes(table.id) ? prev.filter((id) => id !== table.id) : [...prev, table.id]))
      return
    }
    // mode === "move": primero la mesa origen (ocupada/por cobrar), después uno o más destinos libres.
    if (selected.length === 0) {
      if (table.status === "free") return
      setSelected([table.id])
      return
    }
    if (table.status !== "free") return
    setSelected((prev) => (prev.includes(table.id) ? prev.filter((id) => id !== table.id) : [...prev, table.id]))
  }

  async function handleOpenTable() {
    if (!openTable) return
    setOpenPending(true)
    setOpenError(null)
    try {
      const order = await createOrder({
        channel: "dine_in",
        table_ids: [openTable.id],
        covers: covers ?? undefined,
      })
      setOpenTable(null)
      void queryClient.invalidateQueries({ queryKey: TABLES_STATUS_QUERY_KEY })
      navigate(`/pos/comanda/${order.id}`)
    } catch (err) {
      setOpenError(errorMessage(err))
    } finally {
      setOpenPending(false)
    }
  }

  async function runMerge(pin?: string) {
    if (mergeTarget === null) return
    const destTable = tableById.get(mergeTarget)
    if (!destTable?.order_id) return
    setActionPending(true)
    setActionError(null)
    try {
      const sourceTableIds = selected.filter((id) => id !== mergeTarget)
      let destOrder: OrderOut = await getOrder(destTable.order_id)
      for (const tableId of sourceTableIds) {
        const sourceTable = tableById.get(tableId)
        if (!sourceTable?.order_id) continue
        destOrder = await mergeOrders(destOrder.id, {
          expected_version: destOrder.version ?? 0,
          from_order_id: sourceTable.order_id,
          authorizer_pin: pin,
        })
      }
      setMergeDialogOpen(false)
      authorizerFlow.close()
      resetMode()
      void queryClient.invalidateQueries({ queryKey: TABLES_STATUS_QUERY_KEY })
    } catch (err) {
      const handled = authorizerFlow.handleError(err, (retryPin) => void runMerge(retryPin))
      if (handled) {
        if (pin === undefined) setActionError(errorMessage(err))
        else authorizerFlow.fail(errorMessage(err))
        return
      }
      setActionError(errorMessage(err))
    } finally {
      setActionPending(false)
    }
  }

  async function runMove(pin?: string) {
    const [sourceTableId, ...destTableIds] = selected
    const sourceTable = tableById.get(sourceTableId)
    if (!sourceTable?.order_id || destTableIds.length === 0) return
    setActionPending(true)
    setActionError(null)
    try {
      const order = await getOrder(sourceTable.order_id)
      await moveOrder(order.id, {
        expected_version: order.version ?? 0,
        table_ids: destTableIds,
        authorizer_pin: pin,
      })
      authorizerFlow.close()
      resetMode()
      void queryClient.invalidateQueries({ queryKey: TABLES_STATUS_QUERY_KEY })
    } catch (err) {
      const handled = authorizerFlow.handleError(err, (retryPin) => void runMove(retryPin))
      if (handled) {
        if (pin === undefined) setActionError(errorMessage(err))
        else authorizerFlow.fail(errorMessage(err))
        return
      }
      setActionError(errorMessage(err))
    } finally {
      setActionPending(false)
    }
  }

  // Las marcas del sitio de TODAS las zonas, sin repetir: son del local y se
  // dibujan una sola vez sobre el plano entero.
  const marcasDelSitio = Array.from(new Set(zones.flatMap((z) => z.landmarks ?? [])))

  // Cuántas comandas están esperando en cocina, contadas sobre lo que el
  // plano YA recibió: las del riel en estado «en cocina» más las mesas que
  // marcharon. No es una regla nueva ni una consulta nueva — es el mismo
  // estado tipado que publica el servidor, contado.
  const pendientesEnCocina = (tablesStatus.data?.channels ?? [])
    .flatMap((g) => g.orders ?? [])
    .filter((o) => o.state === "in_kitchen").length

  // Lo que la búsqueda recorre: las mesas con cuenta abierta y las comandas
  // del riel. Todo ya está en memoria — buscar no le pregunta nada nuevo al
  // servidor porque quien busca está mirando justamente esta pantalla.
  const q = busqueda.trim().toLowerCase()
  const resultadosBusqueda =
    q === ""
      ? []
      : [
          ...zones.flatMap((z) =>
            (z.tables ?? [])
              .filter((t) => t.order_id != null)
              .map((t) => ({
                tipo: "mesa" as const,
                orderId: t.order_id as number,
                codigo: t.is_counter ? (t.number ?? "Barra") : `Mesa ${t.number ?? ""}`,
                titulo: t.served_by ?? "Sin asignar",
                total: t.total ?? 0,
              })),
          ),
          ...(tablesStatus.data?.channels ?? []).flatMap((g) =>
            (g.orders ?? []).map((o) => ({
              tipo: "canal" as const,
              orderId: o.order_id,
              codigo: o.code,
              titulo: o.title,
              total: o.total,
            })),
          ),
        ].filter((r) => `${r.codigo} ${r.titulo}`.toLowerCase().includes(q))

  const mergeSelectable = mode === "merge" && selected.length >= 2
  const moveSelectable = mode === "move" && selected.length >= 2

  return (
    /* **La pantalla ocupa la tablet.** `m2b` es un marco completo: el plano
       se queda con el alto que sobra y el pie de acciones vive pegado abajo,
       donde la mano lo alcanza sin mirar. Con la pantalla hugging el borde
       de arriba, el pie quedaba flotando a media altura y debajo había un
       palmo de fondo vacío — que es exactamente lo que hace que no se vea
       como el diseño. */
    <div className="flex min-h-full flex-col gap-4">
      {/* **La cabecera de `m2b`**: a la izquierda qué es la pantalla y qué se
          hace en ella; a la derecha, la cifra que el dueño mira primero —
          cuánta plata hay viva en el salón—. Esa cifra estaba metida como una
          cinta más entre otras cuatro, que es donde no se ve. */}
      <div className="flex flex-wrap items-start gap-4 border-b pb-3">
        <div className="min-w-0">
          <h1 className="text-xl leading-tight font-semibold">Mesas</h1>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Tocá una mesa para abrir o seguir su cuenta.
          </p>
        </div>
        <div className="ml-auto text-right">
          <span className="block text-xs tracking-wider text-muted-foreground uppercase">Abierto en mesas</span>
          <span className="block text-[1.75rem] leading-tight font-bold tabular-nums">
            {resumen ? formatCOP(resumen.open_total) : "—"}
          </span>
        </div>
      </div>

      {mode !== "idle" ? (
        <div className="flex flex-wrap items-center gap-3 rounded-md border border-dashed p-3 text-sm">
          <p>
            {mode === "merge"
              ? "Tocá las mesas ocupadas que querés unir (2 o más)."
              : selected.length === 0
                ? "Tocá la mesa que querés mover."
                : "Tocá una o más mesas libres de destino."}
          </p>
          {mode === "merge" && mergeSelectable ? (
            <Button
              type="button"
              className="h-9"
              onClick={() => {
                setMergeTarget(selected[0])
                setMergeDialogOpen(true)
              }}
            >
              Continuar
            </Button>
          ) : null}
          {mode === "move" && moveSelectable ? (
            <Button type="button" className="h-9" disabled={actionPending} onClick={() => void runMove()}>
              {actionPending ? "Moviendo…" : "Confirmar traslado"}
            </Button>
          ) : null}
          <Button type="button" variant="ghost" className="h-9" onClick={resetMode}>
            Cancelar
          </Button>
        </div>
      ) : null}

      {actionError ? (
        <p role="alert" className="text-sm text-destructive">
          {actionError}
        </p>
      ) : null}

      {tablesStatus.isLoading ? (
        <p className="text-sm text-muted-foreground">Cargando mesas…</p>
      ) : zones.length === 0 ? (
        <EmptyState title="Esta sede todavía no tiene zonas ni mesas activas" />
      ) : (
        <div className="flex min-h-0 flex-1 flex-col gap-4">
          {resumen ? (
            <SalonResumen
              tablesTotal={resumen.tables_total}
              tablesOccupied={resumen.tables_occupied}
              averageOpen={resumen.average_open ?? null}
              oldestTable={resumen.oldest_table ?? null}
              oldestLabel={
                resumen.oldest_minutes != null ? elapsedFromSeconds(resumen.oldest_minutes * 60) : null
              }
              askedForBill={resumen.asked_for_bill ?? 0}
            />
          ) : null}

          {/* Plano + riel, como `m2b`: el riel es fijo de 296 px y el plano se
              queda con el resto. Bajo el punto de quiebre el riel cae debajo —
              en una tablet en vertical, dos columnas de 300 px no son dos
              columnas. */}
          <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_296px]">
          <div className="rounded-xl border bg-card p-4">
            {/* **Las marcas del sitio, una sola vez** (`m2b`). Son del local,
                no de cada zona: repetirlas por grupo las convierte en ruido y
                pierde lo que hacen —orientar a quien mira el plano entero—.
                «Paso a cocina» va a la derecha porque es hacia dónde queda. */}
            {marcasDelSitio.length > 0 ? (
              <div className="mb-3 flex flex-wrap items-center gap-2">
                {marcasDelSitio.map((marca, i) => (
                  <span
                    key={marca}
                    className={cn(
                      "rounded-md border border-dashed border-input px-2.5 py-1 text-[0.72rem] tracking-[0.07em] text-muted-foreground uppercase",
                      i === marcasDelSitio.length - 1 && marcasDelSitio.length > 1 && "ml-auto",
                    )}
                  >
                    {marca}
                  </span>
                ))}
              </div>
            ) : null}
          {zones.map((zone) => {
            // La barra se dibuja como una tira debajo del plano de la zona,
            // no como una tarjeta más en la grilla: `m2b` la separa porque no
            // se mira igual que una mesa.
            const mesas = (zone.tables ?? []).filter((t) => !t.is_counter)
            const barras = (zone.tables ?? []).filter((t) => t.is_counter)
            return (
            <section key={zone.id} className="mb-3 last:mb-0">
              {/* **Sin título de zona.** `m2b` dibuja UN plano continuo: el
                  mesero mira el salón, no una lista de grupos. La zona sigue
                  existiendo en el modelo y ordena las mesas; simplemente no
                  se rotula, porque el rótulo repetía lo que las marcas del
                  sitio ya dicen mejor. */}
              <div className="grid grid-cols-[repeat(auto-fill,minmax(124px,1fr))] gap-2.5">
                {mesas.map((table) => (
                  <MesaCard
                    key={table.id}
                    numero={table.number ?? "—"}
                    puestos={table.covers ?? table.seats ?? 0}
                    estado={(table.status ?? "free") as EstadoMesa}
                    tiempo={table.opened_at ? elapsedLabel(table.opened_at) : null}
                    total={table.status === "free" ? null : table.total}
                    atiende={table.served_by}
                    lenta={table.is_slow ?? false}
                    reserva={
                      table.reservation
                        ? {
                            // La hora la escribe la PANTALLA: el servidor
                            // publica el instante y la prosa es presentación
                            // —mismo criterio que el riel de canales—.
                            hora: horaDeReloj(table.reservation.at),
                            nombre: table.reservation.party_name,
                            personas: table.reservation.party_size,
                          }
                        : null
                    }
                    seleccionada={selected.includes(table.id)}
                    onClick={() => {
                      if (mode !== "idle") {
                        toggleSelected(table)
                        return
                      }
                      if (table.status === "free") {
                        setOpenTable(table)
                      } else if (table.order_id) {
                        navigate(`/pos/comanda/${table.order_id}`)
                      }
                    }}
                  />
                ))}
              </div>

              {/* La barra, si la zona tiene. Los puestos ocupados salen de los
                  comensales que alguien contó (`covers`): si nadie los contó,
                  la tira muestra el total al lado y los puestos vacíos —
                  pintar «6 de 6» porque hay una comanda abierta sería
                  inventar cuánta gente hay sentada. */}
              {barras.map((barra) => (
                <BarraSitio
                  key={barra.id}
                  nombre={barra.number ?? "Barra"}
                  puestos={barra.seats ?? 0}
                  ocupados={barra.status === "free" ? 0 : (barra.covers ?? 0)}
                  total={barra.status === "free" ? null : barra.total}
                  onClick={() => {
                    if (mode !== "idle") {
                      toggleSelected(barra)
                      return
                    }
                    if (barra.status === "free") {
                      setOpenTable(barra)
                    } else if (barra.order_id) {
                      navigate(`/pos/comanda/${barra.order_id}`)
                    }
                  }}
                />
              ))}
            </section>
            )
          })}
          </div>

          <RielCanales
            grupos={(tablesStatus.data?.channels ?? []) as GrupoCanal[]}
            tiempo={(iso) => elapsedLabel(iso)}
            onAbrir={(orderId) => navigate(`/pos/comanda/${orderId}`)}
          />
          </div>

          {/* El pie de acciones de la maqueta: lo que se hace desde el salón
              sin pasar por una mesa. «Buscar una cuenta» y el contador de
              cocina son de `m2b` — el contador sobre todo: dice si vale la
              pena ir a cocina antes de caminar hasta allá. */}
          <div className="mt-auto flex flex-wrap items-center gap-2.5 border-t pt-3">
            <Button type="button" className="h-11 gap-2" onClick={() => navigate("/pos/comanda/nueva")}>
              <Plus className="size-4" aria-hidden="true" />
              Abrir cuenta nueva
            </Button>
            <Button type="button" variant="outline" className="h-11 gap-2" onClick={() => setBuscando(true)}>
              <Search className="size-4" aria-hidden="true" />
              Buscar una cuenta
            </Button>
            {/* **Unir y mover bajan acá.** Arriba eran una banda propia entre
                la cabecera y las cintas —la quinta franja de cromo de una
                pantalla de tablet— para dos acciones que se usan cuando una
                mesa ya está abierta. `m2b` junta en el pie todo lo que se
                hace desde el salón sin tocar una mesa; esto es eso. */}
            <Button
              type="button"
              variant={mode === "merge" ? "default" : "outline"}
              className="h-11 gap-2"
              aria-pressed={mode === "merge"}
              onClick={() => {
                if (mode === "merge") {
                  resetMode()
                  return
                }
                setMode("merge")
                setSelected([])
              }}
            >
              <Link2 className="size-4" aria-hidden="true" />
              Unir mesas
            </Button>
            <Button
              type="button"
              variant={mode === "move" ? "default" : "outline"}
              className="h-11 gap-2"
              aria-pressed={mode === "move"}
              onClick={() => {
                if (mode === "move") {
                  resetMode()
                  return
                }
                setMode("move")
                setSelected([])
              }}
            >
              <Move className="size-4" aria-hidden="true" />
              Mover mesa
            </Button>
            <Button
              type="button"
              variant="outline"
              className="ml-auto h-11 gap-2"
              onClick={() => navigate("/pos/cocina")}
            >
              <ChefHat className="size-4" aria-hidden="true" />
              {/* El número lo cuenta el SERVIDOR, en las comandas que ya
                  publica el plano: no hay una segunda consulta ni una regla
                  nueva de «qué es pendiente». */}
              Cocina{pendientesEnCocina > 0 ? ` · ${pendientesEnCocina} pendientes` : ""}
            </Button>
          </div>
        </div>
      )}

      {/* **«Buscar una cuenta»** (`m2b`). En un salón de doce mesas con
          mostrador y domicilios, la comanda que alguien busca no siempre está
          en el plano: puede ser un pedido para llevar a nombre de una
          persona. Se busca sobre lo que el plano YA tiene —mesas y riel—, sin
          una consulta nueva: quien busca está mirando esta pantalla. */}
      <Dialog open={buscando} onOpenChange={(next) => { setBuscando(next); if (!next) setBusqueda("") }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Buscar una cuenta</DialogTitle>
          </DialogHeader>
          <div className="space-y-1">
            <Label htmlFor="buscar-cuenta">Mesa, nombre o código</Label>
            <Input
              id="buscar-cuenta"
              className="h-11"
              autoFocus
              placeholder="Mesa 7, Camila, P-001…"
              value={busqueda}
              onChange={(e) => setBusqueda(e.target.value)}
            />
          </div>
          <ul className="max-h-72 divide-y overflow-y-auto">
            {resultadosBusqueda.length === 0 ? (
              <li className="py-3 text-sm text-muted-foreground">
                {busqueda.trim() === "" ? "Escribí para buscar." : "Ninguna cuenta abierta coincide."}
              </li>
            ) : (
              resultadosBusqueda.map((r) => (
                <li key={`${r.tipo}-${r.orderId}`}>
                  <button
                    type="button"
                    className="flex w-full items-center gap-3 py-2.5 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                    onClick={() => {
                      setBuscando(false)
                      setBusqueda("")
                      navigate(`/pos/comanda/${r.orderId}`)
                    }}
                  >
                    <span className="shrink-0 text-xs whitespace-nowrap text-muted-foreground">{r.codigo}</span>
                    <span className="min-w-0 flex-1 truncate text-sm font-medium">{r.titulo}</span>
                    <span className="shrink-0 text-sm font-bold tabular-nums">{formatCOP(r.total)}</span>
                  </button>
                </li>
              ))
            )}
          </ul>
        </DialogContent>
      </Dialog>

      <Dialog open={openTable !== null} onOpenChange={(next) => !next && setOpenTable(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Abrir mesa {openTable?.number}</DialogTitle>
          </DialogHeader>
          <div className="space-y-1">
            <Label htmlFor="table-covers">Comensales</Label>
            <Input
              id="table-covers"
              type="number"
              min={1}
              className="h-11"
              value={covers ?? ""}
              onChange={(event) => setCovers(event.target.value === "" ? null : Number(event.target.value))}
            />
          </div>
          {openError ? (
            <p role="alert" className="text-sm text-destructive">
              {openError}
            </p>
          ) : null}
          <DialogFooter>
            <Button type="button" className="h-11" disabled={openPending} onClick={() => void handleOpenTable()}>
              <Plus className="size-4" aria-hidden="true" />
              {openPending ? "Abriendo…" : "Abrir mesa"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={mergeDialogOpen} onOpenChange={setMergeDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>¿Cuál mesa queda como destino?</DialogTitle>
          </DialogHeader>
          <div className="space-y-1">
            <Label htmlFor="merge-target">Comanda destino</Label>
            <Select
              value={mergeTarget !== null ? String(mergeTarget) : undefined}
              onValueChange={(value) => setMergeTarget(Number(value))}
            >
              <SelectTrigger id="merge-target" className="h-11 w-full">
                <SelectValue placeholder="Elegí la mesa destino" />
              </SelectTrigger>
              <SelectContent>
                {selected.map((tableId) => (
                  <SelectItem key={tableId} value={String(tableId)}>
                    Mesa {tableById.get(tableId)?.number ?? tableId}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <DialogFooter>
            <Button type="button" className="h-11" disabled={actionPending} onClick={() => void runMerge()}>
              {actionPending ? "Uniendo…" : "Unir mesas"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AuthorizerDialog
        open={authorizerFlow.open}
        onOpenChange={(next) => !next && authorizerFlow.close()}
        onSubmit={authorizerFlow.submitPin}
        pending={authorizerFlow.pending}
        errorMessage={authorizerFlow.pinError}
        reason="La comanda ya tiene cuenta presentada: unir o mover mesas necesita autorización."
      />
    </div>
  )
}

export default TablesPage
