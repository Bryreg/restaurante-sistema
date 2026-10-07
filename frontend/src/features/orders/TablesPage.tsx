import { useQueryClient } from "@tanstack/react-query"
import { BellRing, Link2, Move, Plus } from "lucide-react"
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
import { SegmentadoTactil } from "@/components/admin"
import { Cargando } from "@/components/Cargando"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
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
import { usePosTarea } from "@/app/posTarea"
import { useSession } from "@/app/session"
import { CashRibbon } from "@/features/shifts"
import { formatCOP } from "@/lib/money"
import { errorMessage } from "@/lib/errors"
import { cn } from "@/lib/utils"

import { AuthorizerDialog } from "./AuthorizerDialog"
import { TABLES_STATUS_QUERY_KEY, useAuthorizerFlow, useTablesStatus } from "./hooks"
import { elapsedMinutesLabel, initials } from "./lib"
import { mergeAlerts, newlyReady, readyCountsOf, type ReadyAlert, type ReadyCounts } from "./readyAlerts"

type Mode = "idle" | "merge" | "move"

const STATUS_LABEL: Record<string, string> = { free: "Libre", occupied: "Ocupada", to_pay: "Por cobrar" }

/**
 * El fondo de la mesa dice el estado de lejos (handoff «Burbujas», 9b):
 * libre en `card` con anillo `inset 1.5px var(--input)`; ocupada en
 * `fill-strong` (un punto más oscura que el pozo); por cobrar en tinta, con
 * el texto en `card`. Tokens del tema: la noche (`salon-oscuro`) sale sola.
 * «Por cobrar» es el `status: "to_pay"` del servidor (cuenta presentada).
 */
const STATUS_CARD_CLASS: Record<string, string> = {
  free: "bg-card text-foreground shadow-[inset_0_0_0_1.5px_var(--input)]",
  occupied: "bg-fill-strong text-foreground",
  to_pay: "bg-foreground text-card",
}

/** El cuadrito de 12 px de la leyenda: el mismo fondo que la mesa. */
const MUESTRA_CLASS: Record<keyof typeof STATUS_LABEL, string> = {
  free: "shadow-[inset_0_0_0_1.5px_var(--input)]",
  occupied: "bg-fill-strong",
  to_pay: "bg-foreground",
}

function Muestra({ estado }: { estado: keyof typeof STATUS_LABEL }): React.JSX.Element {
  return <span aria-hidden="true" className={cn("size-3 shrink-0 rounded-[4px]", MUESTRA_CLASS[estado])} />
}

/** Botón de 52 px de la burbuja de filtros («Mis mesas», «Mover / unir»): pozo, o tinta si está activo. */
const BOTON_FILTRO =
  "inline-flex h-[52px] shrink-0 items-center gap-2 rounded-2xl px-[18px] text-[15px] font-semibold transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none [&_svg]:size-[18px]"
const BOTON_FILTRO_TONO = (activo: boolean) =>
  activo ? "bg-foreground text-card" : "bg-muted text-foreground hover:bg-fill-strong"

/** Botón de 52 px dentro de un aviso (pozo), y su variante principal. */
const BOTON_AVISO = "h-[52px] rounded-2xl px-[18px] text-[15px] font-semibold"

/** Pastilla de 24 px, texto blanco 12/600 («2 listos», «3 sin enviar»). */
const PASTILLA_MESA = "inline-flex h-6 shrink-0 items-center rounded-full px-[9px] text-[12px] font-semibold text-white"

/**
 * La mesa (handoff «Burbujas», 9b): botón de 112 px mínimo, radio 18. Arriba
 * el nombre en 19/600 y las iniciales de quien la atiende en un cuadro de
 * 30 px; la línea de estado («Libre · 4 puestos», «3 · 12 min» o «Por cobrar
 * · 3 · 12 min»); al pie las pastillas «N listos» (success) y «N sin enviar»
 * (destructive) —conteos del servidor, no cuentas de la pantalla— y el total
 * del servidor.
 */
function TableCard({
  table,
  selecting,
  isSelected,
  onClick,
}: {
  table: TableStatusOut
  selecting: boolean
  isSelected: boolean
  onClick: () => void
}): React.JSX.Element {
  // Conteo del servidor: platos que cocina marcó listos y nadie llevó
  // todavía. Sin el campo (backend viejo) no se pinta nada.
  const readyCount = table.ready_count ?? 0
  const readyText = `${readyCount} ${readyCount === 1 ? "listo" : "listos"}`
  // Lo que el mesero cargó y todavía no salió a cocina: el olvido más caro
  // del turno, visible desde el mapa.
  const unsentCount = table.unsent_count ?? 0
  const unsentText = `${unsentCount} sin enviar`
  const waiter = table.opened_by?.name ?? null
  const status = table.status ?? "free"
  const tinta = status === "to_pay"
  const meta =
    status === "free"
      ? `Libre · ${table.seats ?? "—"} puestos`
      : `${tinta ? "Por cobrar · " : ""}${table.covers ?? table.seats ?? "—"} · ${elapsedMinutesLabel(table.opened_at)}`
  return (
    <button
      type="button"
      aria-label={`Mesa ${table.number}, ${STATUS_LABEL[status]}${
        readyCount > 0 ? `, ${readyText} para servir` : ""
      }${unsentCount > 0 ? `, ${unsentText}` : ""}${waiter ? `, atiende ${waiter}` : ""}`}
      aria-pressed={selecting ? isSelected : undefined}
      className={cn(
        "box-border flex min-h-[112px] flex-col items-stretch gap-1 rounded-[18px] px-3.5 py-3 text-left transition-[filter] hover:brightness-[0.97] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
        STATUS_CARD_CLASS[status] ?? STATUS_CARD_CLASS.free,
        isSelected && "outline-[3px] outline-offset-2 outline-primary",
      )}
      onClick={onClick}
    >
      <span className="flex w-full items-center justify-between gap-1.5">
        <b className="text-[19px] leading-tight font-semibold">Mesa {table.number}</b>
        {waiter ? (
          <span
            aria-hidden="true"
            title={waiter}
            className={cn(
              "grid size-[30px] shrink-0 place-items-center rounded-[10px] text-[12px] font-semibold",
              tinta ? "bg-[color-mix(in_oklab,var(--card)_18%,transparent)]" : "bg-card",
            )}
          >
            {initials(waiter)}
          </span>
        ) : null}
      </span>
      <span
        className={cn(
          "text-[13px]",
          tinta ? "text-[color-mix(in_oklab,var(--card)_75%,var(--foreground))]" : "text-muted-foreground",
        )}
      >
        {meta}
      </span>
      <span className="mt-auto flex w-full items-end justify-between gap-1.5">
        {readyCount > 0 || unsentCount > 0 ? (
          <span className="flex flex-wrap gap-1">
            {readyCount > 0 ? <span className={cn(PASTILLA_MESA, "bg-success")}>{readyText}</span> : null}
            {unsentCount > 0 ? <span className={cn(PASTILLA_MESA, "bg-destructive")}>{unsentText}</span> : null}
          </span>
        ) : null}
        {status !== "free" ? (
          <b className="ml-auto text-[16px] font-semibold tabular-nums">{formatCOP(table.total)}</b>
        ) : null}
      </span>
    </button>
  )
}

export function TablesPage(): React.JSX.Element {
  const { hasFeature, me } = useSession()
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
  const [mergeTarget, setMergeTarget] = useState<number | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [actionPending, setActionPending] = useState(false);
  // «Mis mesas»: sólo las que abrió quien está identificado (y las libres,
  // que son las que puede abrir). Vive en la pantalla, no en el navegador.
  const [onlyMine, setOnlyMine] = useState(false)
  const myId = me?.employee?.id ?? null

  const authorizerFlow = useAuthorizerFlow();
  // Mesas maneja su propio alto: la burbuja de filtros y la columna «Caja»
  // quedan quietas y sólo se desplazan las burbujas de zona.
  usePosTarea({ aLoAncho: true })
  const [zonaId, setZonaId] = useState<number | "todas">("todas")

  // Aviso de «plato listo» (auditoría p4): cada lectura de Mesas se compara
  // con la anterior; la mesa a la que le llegó algo nuevo de cocina sale
  // arriba con un botón para ir. Se ajusta el estado al renderizar (el
  // patrón de React para derivar de una lectura nueva), no en un efecto.
  const [seenData, setSeenData] = useState<typeof tablesStatus.data>(undefined)
  const [readyCounts, setReadyCounts] = useState<ReadyCounts | null>(null)
  const [readyAlerts, setReadyAlerts] = useState<ReadyAlert[]>([])
  if (tablesStatus.data !== undefined && tablesStatus.data !== seenData) {
    const zonesNow = tablesStatus.data.zones ?? []
    const counts = readyCountsOf(zonesNow)
    setSeenData(tablesStatus.data)
    setReadyCounts(counts)
    setReadyAlerts((current) => mergeAlerts(current, newlyReady(readyCounts, zonesNow), counts))
  }
  const alertCount = readyAlerts.length
  useEffect(() => {
    // Un toque corto en la tablet cuando llega un aviso (si el equipo vibra).
    if (alertCount > 0 && typeof navigator !== "undefined" && typeof navigator.vibrate === "function") {
      navigator.vibrate(200)
    }
  }, [alertCount])

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

  const mergeSelectable = mode === "merge" && selected.length >= 2
  const moveSelectable = mode === "move" && selected.length >= 2

  // Conteos de la leyenda: mesas, no plata (el estado lo manda el servidor).
  const cuenta = { free: 0, occupied: 0, to_pay: 0 }
  for (const zone of zones) for (const table of zone.tables ?? []) cuenta[table.status ?? "free"] += 1
  const visibleTables = (zone: ZoneStatusOut) =>
    (zone.tables ?? []).filter((table) => !onlyMine || table.status === "free" || table.opened_by?.id === myId)
  // El segmentado de zona: «Todas» y las zonas reales, con su recuento de mesas.
  const zonaElegida = zonaId === "todas" || zones.some((zone) => zone.id === zonaId) ? zonaId : "todas"
  const zonasVisibles = zonaElegida === "todas" ? zones : zones.filter((zone) => zone.id === zonaElegida)
  const pestanas = [
    { value: "todas" as const, label: "Todas", detalle: tableById.size },
    ...zones.map((zone) => ({ value: zone.id, label: zone.name ?? "Zona", detalle: (zone.tables ?? []).length })),
  ]

  function toggleMode(next: Exclude<Mode, "idle">) {
    if (mode === next) {
      resetMode()
      return
    }
    setMode(next)
    setSelected([])
  }

  return (
    <div className="flex min-h-0 flex-1 gap-2.5">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-2.5">
        {/* La burbuja de filtros (9b): título, zona, leyenda, «Mover / unir» y «Mis mesas». */}
        <div className="flex flex-none flex-wrap items-center gap-3 rounded-[22px] bg-card py-2.5 pr-2.5 pl-[22px]">
          <h1 className="text-[26px] leading-tight font-semibold tracking-[-0.02em]">Mesas</h1>
          {zones.length > 0 ? (
            <SegmentadoTactil
              etiqueta="Zonas"
              opciones={pestanas}
              valor={zonaElegida}
              onChange={setZonaId}
              alto={48}
              className="ml-2"
            />
          ) : null}
          <p className="ml-auto flex flex-wrap gap-x-3.5 gap-y-1 text-[13px] text-muted-foreground">
            <span className="inline-flex items-center gap-1.5">
              <Muestra estado="free" />
              Libre {cuenta.free}
            </span>
            <span className="inline-flex items-center gap-1.5">
              <Muestra estado="occupied" />
              Ocupada {cuenta.occupied}
            </span>
            <span className="inline-flex items-center gap-1.5">
              <Muestra estado="to_pay" />
              Por cobrar {cuenta.to_pay}
            </span>
          </p>
          <DropdownMenu>
            <DropdownMenuTrigger className={cn(BOTON_FILTRO, BOTON_FILTRO_TONO(mode !== "idle"))}>
              <Move aria-hidden="true" />
              Mover / unir
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-auto min-w-56">
              <DropdownMenuItem className="min-h-14 gap-3 text-base" onClick={() => toggleMode("move")}>
                <Move className="size-5" aria-hidden="true" />
                Mover mesa
              </DropdownMenuItem>
              <DropdownMenuItem className="min-h-14 gap-3 text-base" onClick={() => toggleMode("merge")}>
                <Link2 className="size-5" aria-hidden="true" />
                Unir mesas
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          {myId !== null ? (
            <button
              type="button"
              className={cn(BOTON_FILTRO, BOTON_FILTRO_TONO(onlyMine))}
              aria-pressed={onlyMine}
              onClick={() => setOnlyMine((on) => !on)}
            >
              Mis mesas
            </button>
          ) : null}
        </div>

        {mode !== "idle" ? (
          <div className="flex flex-none flex-wrap items-center gap-3 rounded-[22px] bg-card py-2.5 pr-2.5 pl-[22px] shadow-[inset_0_0_0_2px_var(--primary)]">
            <p className="flex-1 text-[15px]">
              {mode === "merge"
                ? "Tocá las mesas ocupadas que querés unir (2 o más)."
                : selected.length === 0
                  ? "Tocá la mesa que querés mover."
                  : "Tocá una o más mesas libres de destino."}
            </p>
            {mode === "merge" && mergeSelectable ? (
              <Button
                type="button"
                className={BOTON_AVISO}
                onClick={() => {
                  setMergeTarget(selected[0])
                  setMergeDialogOpen(true)
                }}
              >
                Continuar
              </Button>
            ) : null}
            {mode === "move" && moveSelectable ? (
              <Button type="button" className={BOTON_AVISO} disabled={actionPending} onClick={() => void runMove()}>
                {actionPending ? "Moviendo…" : "Confirmar traslado"}
              </Button>
            ) : null}
            <button type="button" className={cn(BOTON_FILTRO, BOTON_FILTRO_TONO(false))} onClick={resetMode}>
              Cancelar
            </button>
          </div>
        ) : null}

        {readyAlerts.length > 0 ? (
          <ul className="flex flex-none flex-col gap-2.5" aria-label="Platos listos para servir">
            {readyAlerts.map((alert) => (
              <li
                key={alert.tableId}
                role="alert"
                className="flex flex-wrap items-center gap-3 rounded-[22px] bg-success-soft py-2.5 pr-2.5 pl-[22px] text-[16px]"
              >
                <BellRing className="size-6 shrink-0 text-success" aria-hidden="true" />
                <p className="min-w-0 flex-1 font-semibold">
                  Mesa {alert.tableNumber}: {alert.readyCount} {alert.readyCount === 1 ? "plato listo" : "platos listos"}{" "}
                  para servir
                </p>
                {alert.orderId !== null ? (
                  <Button
                    type="button"
                    className={BOTON_AVISO}
                    onClick={() => {
                      setReadyAlerts((current) => current.filter((a) => a.tableId !== alert.tableId))
                      navigate(`/pos/comanda/${alert.orderId}`)
                    }}
                  >
                    Ir a la mesa {alert.tableNumber}
                  </Button>
                ) : null}
                <button
                  type="button"
                  className={cn(BOTON_FILTRO, "bg-card text-foreground hover:bg-muted")}
                  onClick={() => setReadyAlerts((current) => current.filter((a) => a.tableId !== alert.tableId))}
                >
                  Entendido
                </button>
              </li>
            ))}
          </ul>
        ) : null}

        {actionError ? (
          <p role="alert" className="flex-none rounded-[22px] bg-destructive-soft px-[22px] py-3 text-[15px] text-destructive">
            {actionError}
          </p>
        ) : null}

        <div className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto">
          {tablesStatus.isLoading ? (
            <div className="rounded-[24px] bg-card p-[18px]">
              <Cargando texto="Cargando mesas…" />
            </div>
          ) : zones.length === 0 ? (
            <div className="rounded-[24px] bg-card p-[18px]">
              <EmptyState title="Esta sede todavía no tiene zonas ni mesas activas" />
            </div>
          ) : (
            zonasVisibles.map((zone) => {
              const todas = zone.tables ?? []
              const ocupadas = todas.filter((table) => (table.status ?? "free") !== "free").length
              return (
                <section key={zone.id} className="flex flex-none flex-col gap-3 rounded-[24px] bg-card p-[18px]">
                  <div className="flex items-baseline gap-2.5 px-1">
                    <h2 className="text-[16px] font-semibold">{zone.name}</h2>
                    <span className="text-[13px] text-muted-foreground">
                      {ocupadas} de {todas.length} ocupadas
                    </span>
                  </div>
                  <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-2">
                    {visibleTables(zone).map((table) => (
                      <TableCard
                        key={table.id}
                        table={table}
                        selecting={mode !== "idle"}
                        isSelected={selected.includes(table.id)}
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
                </section>
              )
            })
          )}
        </div>
      </div>

      {/* La columna «Caja» (9b): las acciones del turno a un toque. Sólo la
          ve quien puede manejar la caja, con turno abierto; cada acción abre
          su hoja encima de Mesas. Sin caja no dibuja nada y Mesas va a lo ancho. */}
      <CashRibbon variante="columna" />

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
