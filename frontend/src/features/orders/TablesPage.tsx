import { useQueryClient } from "@tanstack/react-query"
import { BellRing, Circle, Link2, Move, Plus, Receipt, Send, UserRound, Users, Utensils } from "lucide-react"
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
import { TABLET_HORIZONTAL, useMediaQuery } from "@/lib/useMediaQuery"
import { cn } from "@/lib/utils"

import { AuthorizerDialog } from "./AuthorizerDialog"
import { TABLES_STATUS_QUERY_KEY, useAuthorizerFlow, useTablesStatus } from "./hooks"
import { elapsedMinutesLabel, initials } from "./lib"

type Mode = "idle" | "merge" | "move"

const STATUS_LABEL: Record<string, string> = { free: "Libre", occupied: "Ocupada", to_pay: "Por cobrar" }

/**
 * El fondo de la tarjeta dice el estado de lejos (handoff `PosMesas`):
 * libre en `card` con borde `border`; ocupada con `primary` al 12 % y borde
 * al 45 %; por cobrar con `warning` al 22 % y borde `warning`. Tokens del
 * tema (nunca un color crudo), con el texto en `foreground` para que el
 * contraste no dependa del fondo. El estado va además con ícono y palabra.
 */
const STATUS_CARD_CLASS: Record<string, string> = {
  free: "border-border bg-card",
  occupied: "border-primary/45 bg-primary/12",
  to_pay: "border-warning bg-warning/22",
}

const STATUS_ICON = { free: Circle, occupied: Utensils, to_pay: Receipt } as const
const STATUS_TEXT_CLASS: Record<string, string> = {
  free: "text-muted-foreground",
  occupied: "text-accent-foreground",
  to_pay: "text-foreground",
}

/** El cuadrito de la leyenda: la misma pareja fondo/borde que la tarjeta. */
function Muestra({ estado }: { estado: keyof typeof STATUS_ICON }): React.JSX.Element {
  return <span aria-hidden="true" className={cn("size-[14px] rounded-[4px] border-2", STATUS_CARD_CLASS[estado])} />
}

/** Botón de 56 px de la fila de Mesas (Mis mesas, Mover / unir). */
const BOTON_FILA = "h-[56px] gap-2 rounded-lg px-4 text-[16px] font-semibold [&_svg]:size-5"

/**
 * La tarjeta de una mesa (handoff `PosMesas`): 128 px de alto (112 en la
 * tablet apaisada), el nombre, las iniciales de quien la atiende en un
 * círculo de 34 px, el estado con ícono y palabra, «3 · 12 min» y el total
 * del servidor, y los chips «2 listos» (success) y «2 sin enviar»
 * (destructive), que son conteos del servidor, no cuentas de la pantalla.
 */
function TableCard({
  table,
  compact,
  selecting,
  isSelected,
  onClick,
}: {
  table: TableStatusOut
  compact: boolean
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
  const StatusIcon = STATUS_ICON[status] ?? Circle
  return (
    <button
      type="button"
      aria-label={`Mesa ${table.number}, ${STATUS_LABEL[status]}${
        readyCount > 0 ? `, ${readyText} para servir` : ""
      }${unsentCount > 0 ? `, ${unsentText}` : ""}${waiter ? `, atiende ${waiter}` : ""}`}
      aria-pressed={selecting ? isSelected : undefined}
      className={cn(
        "flex flex-col items-stretch gap-1.5 rounded-lg border-2 p-3 text-left text-foreground transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring",
        compact ? "min-h-[112px]" : "min-h-[128px]",
        STATUS_CARD_CLASS[status] ?? STATUS_CARD_CLASS.free,
        isSelected && "border-primary ring-2 ring-primary",
      )}
      onClick={onClick}
    >
      <span className="flex w-full items-center justify-between gap-1.5">
        <b className="text-[21px] leading-tight font-bold [font-stretch:90%]">Mesa {table.number}</b>
        {waiter ? (
          <span
            aria-hidden="true"
            title={waiter}
            className="grid size-[34px] shrink-0 place-items-center rounded-full border border-foreground/30 bg-background text-[13px] font-extrabold"
          >
            {initials(waiter)}
          </span>
        ) : null}
      </span>
      <span className={cn("inline-flex items-center gap-1.5 text-[14px] font-bold", STATUS_TEXT_CLASS[status])}>
        <StatusIcon className="size-4" aria-hidden="true" />
        {STATUS_LABEL[status]}
      </span>
      {status !== "free" ? (
        <span className="flex w-full flex-wrap items-baseline justify-between gap-x-2 text-[15px]">
          <span className="inline-flex items-center gap-1">
            <Users className="size-[15px]" aria-hidden="true" />
            {table.covers ?? table.seats ?? "—"} · {elapsedMinutesLabel(table.opened_at)}
          </span>
          <b className="tabular-nums">{formatCOP(table.total)}</b>
        </span>
      ) : (
        <span className="text-[14px] text-muted-foreground">{table.seats ?? "—"} puestos</span>
      )}
      {readyCount > 0 || unsentCount > 0 ? (
        <span className="mt-auto flex flex-wrap gap-1.5">
          {readyCount > 0 ? (
            <span className="inline-flex items-center gap-1 rounded-full bg-success px-[9px] py-[3px] text-[13px] font-bold text-success-foreground">
              <BellRing className="size-3.5" aria-hidden="true" />
              {readyText}
            </span>
          ) : null}
          {unsentCount > 0 ? (
            <span className="inline-flex items-center gap-1 rounded-full bg-destructive px-[9px] py-[3px] text-[13px] font-bold text-destructive-foreground">
              <Send className="size-3.5" aria-hidden="true" />
              {unsentText}
            </span>
          ) : null}
        </span>
      ) : null}
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
  // Mesas maneja su propio alto: la cinta y la fila de arriba quedan quietas
  // y sólo se desplaza la grilla.
  usePosTarea({ aLoAncho: true })
  const horizontal = useMediaQuery(TABLET_HORIZONTAL)
  const [zonaId, setZonaId] = useState<number | "todas" | null>(null)

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
  // Variante B (tablet apaisada): las zonas van en pestañas, arrancando por la primera.
  const zonaElegida = horizontal ? (zonaId ?? zones[0]?.id ?? "todas") : "todas"
  const zonasVisibles = zonaElegida === "todas" ? zones : zones.filter((zone) => zone.id === zonaElegida)
  const pestanas = [
    { id: "todas" as const, name: "Todas", n: tableById.size },
    ...zones.map((zone) => ({ id: zone.id, name: zone.name ?? "Zona", n: (zone.tables ?? []).length })),
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
    <div className="flex min-h-0 flex-1 flex-col">
      {/* La cinta de caja: una fila a lo ancho, arriba de Mesas. Sólo la ve
          quien puede manejar la caja, con turno abierto; cada acción abre su
          hoja encima de Mesas. */}
      <CashRibbon />

      <div className="flex flex-wrap items-center gap-2.5 px-4 pt-3 pb-1">
        <h1 className="text-[26px] leading-tight font-extrabold">Mesas</h1>
        <p className="flex flex-1 flex-wrap gap-x-3.5 gap-y-1 text-[14px] text-muted-foreground">
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
        {myId !== null ? (
          <Button
            type="button"
            variant={onlyMine ? "default" : "outline"}
            className={BOTON_FILA}
            aria-pressed={onlyMine}
            onClick={() => setOnlyMine((on) => !on)}
          >
            <UserRound aria-hidden="true" />
            Mis mesas
          </Button>
        ) : null}
        <DropdownMenu>
          <DropdownMenuTrigger
            className={cn(
              BOTON_FILA,
              "inline-flex items-center border transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
              mode === "idle"
                ? "border-border bg-background hover:bg-muted"
                : "border-primary bg-primary text-primary-foreground",
            )}
          >
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
      </div>

      {horizontal && zones.length > 1 ? (
        <div className="flex gap-2 overflow-x-auto px-4 pt-2" role="group" aria-label="Zonas">
          {pestanas.map((pestana) => {
            const activa = zonaElegida === pestana.id
            return (
              <button
                key={pestana.id}
                type="button"
                aria-pressed={activa}
                className={cn(
                  "inline-flex h-[56px] shrink-0 items-center gap-2 rounded-lg px-[18px] text-[17px] font-bold transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                  activa ? "bg-foreground text-background" : "bg-secondary text-foreground hover:bg-muted",
                )}
                onClick={() => setZonaId(pestana.id)}
              >
                {pestana.name}
                <span className="text-[14px] font-medium opacity-80">{pestana.n}</span>
              </button>
            )
          })}
        </div>
      ) : null}

      {mode !== "idle" ? (
        <div className="mx-4 mt-2 flex flex-wrap items-center gap-3 rounded-lg border-2 border-dashed border-primary/45 bg-accent/40 p-3 text-[15px]">
          <p className="flex-1">
            {mode === "merge"
              ? "Tocá las mesas ocupadas que querés unir (2 o más)."
              : selected.length === 0
                ? "Tocá la mesa que querés mover."
                : "Tocá una o más mesas libres de destino."}
          </p>
          {mode === "merge" && mergeSelectable ? (
            <Button
              type="button"
              className="h-[56px] px-5 text-[16px] font-semibold"
              onClick={() => {
                setMergeTarget(selected[0])
                setMergeDialogOpen(true)
              }}
            >
              Continuar
            </Button>
          ) : null}
          {mode === "move" && moveSelectable ? (
            <Button
              type="button"
              className="h-[56px] px-5 text-[16px] font-semibold"
              disabled={actionPending}
              onClick={() => void runMove()}
            >
              {actionPending ? "Moviendo…" : "Confirmar traslado"}
            </Button>
          ) : null}
          <Button type="button" variant="outline" className="h-[56px] px-5 text-[16px]" onClick={resetMode}>
            Cancelar
          </Button>
        </div>
      ) : null}

      {actionError ? (
        <p role="alert" className="px-4 pt-2 text-sm text-destructive">
          {actionError}
        </p>
      ) : null}

      <div className="flex min-h-0 flex-1 flex-col gap-3.5 overflow-y-auto px-4 pt-2 pb-4">
        {tablesStatus.isLoading ? (
          <Cargando texto="Cargando mesas…" />
        ) : zones.length === 0 ? (
          <EmptyState title="Esta sede todavía no tiene zonas ni mesas activas" />
        ) : (
          zonasVisibles.map((zone) => (
            <section key={zone.id} className="flex flex-col gap-2">
              <h2 className="text-[15px] font-bold tracking-[0.06em] text-muted-foreground uppercase">{zone.name}</h2>
              <div
                className={cn(
                  "grid gap-2.5",
                  horizontal
                    ? "grid-cols-[repeat(auto-fill,minmax(140px,1fr))]"
                    : "grid-cols-[repeat(auto-fill,minmax(180px,1fr))]",
                )}
              >
                {visibleTables(zone).map((table) => (
                  <TableCard
                    key={table.id}
                    table={table}
                    compact={horizontal}
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
          ))
        )}
      </div>

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
