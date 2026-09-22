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
import { MesaCard, type EstadoMesa } from "@/components/pos/MesaCard"
import { RielCanales, type GrupoCanal } from "@/components/pos/RielCanales"
import { SalonResumen } from "@/components/pos/SalonResumen"
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

  const mergeSelectable = mode === "merge" && selected.length >= 2
  const moveSelectable = mode === "move" && selected.length >= 2

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-lg font-semibold">Mesas</h1>
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant={mode === "merge" ? "default" : "outline"}
            className="h-11"
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
            className="h-11"
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
        <div className="space-y-4">
          {resumen ? (
            <SalonResumen
              tablesTotal={resumen.tables_total}
              tablesOccupied={resumen.tables_occupied}
              openTotal={resumen.open_total}
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
          {/* La maqueta pone acá una fila de marcas del sitio —«Entrada»,
              «Ventanal / Calle 63», «Paso a cocina»— que orientan a quien mira
              el plano. Este producto NO tiene ese dato: no hay referencias
              físicas del local en ninguna parte del modelo. Poner los nombres
              de zona en su lugar sólo repetía el título que ya está debajo de
              cada grupo, así que la fila queda fuera hasta que exista el dato
              de verdad. */}
          {zones.map((zone) => (
            <section key={zone.id} className="mb-4 last:mb-0">
              <h2 className="mb-2 text-xs tracking-wider text-muted-foreground uppercase">{zone.name}</h2>
              {/* `auto-fill` con mínimo de 124 px: el plano se adapta al ancho
                  de la tablet sin que nadie declare cuántas columnas hay. */}
              <div className="grid grid-cols-[repeat(auto-fill,minmax(124px,1fr))] gap-2.5">
                {(zone.tables ?? []).map((table) => (
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
            </section>
          ))}
          </div>

          <RielCanales
            grupos={(tablesStatus.data?.channels ?? []) as GrupoCanal[]}
            tiempo={(iso) => elapsedLabel(iso)}
            onAbrir={(orderId) => navigate(`/pos/comanda/${orderId}`)}
          />
          </div>

          {/* El pie de acciones de la maqueta: lo que se hace desde el salón
              sin pasar por una mesa. */}
          <div className="flex flex-wrap gap-2.5 border-t pt-4">
            <Button type="button" className="h-11 gap-2" onClick={() => navigate("/pos/comanda/nueva")}>
              <Plus className="size-4" aria-hidden="true" />
              Abrir cuenta nueva
            </Button>
            <Button type="button" variant="outline" className="h-11 gap-2" onClick={() => navigate("/pos/cocina")}>
              <ChefHat className="size-4" aria-hidden="true" />
              Cocina
            </Button>
          </div>
        </div>
      )}

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
