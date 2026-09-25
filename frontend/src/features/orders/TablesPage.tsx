import { useQueryClient } from "@tanstack/react-query"
import { BellRing, Link2, Move, Plus, Users } from "lucide-react"
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
import { Badge } from "@/components/ui/badge"
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
import { formatCOP } from "@/lib/money"
import { errorMessage } from "@/lib/errors"

import { AuthorizerDialog } from "./AuthorizerDialog"
import { TABLES_STATUS_QUERY_KEY, useAuthorizerFlow, useTablesStatus } from "./hooks"
import { elapsedLabel } from "./lib"

type Mode = "idle" | "merge" | "move"

const STATUS_LABEL: Record<string, string> = { free: "Libre", occupied: "Ocupada", to_pay: "Por cobrar" }
const STATUS_VARIANT: Record<string, "outline" | "secondary" | "default"> = {
  free: "outline",
  occupied: "secondary",
  to_pay: "default",
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
        <Cargando texto="Cargando mesas…" />
      ) : zones.length === 0 ? (
        <EmptyState title="Esta sede todavía no tiene zonas ni mesas activas" />
      ) : (
        zones.map((zone) => (
          <section key={zone.id} className="space-y-3">
            <h2 className="text-sm font-medium text-muted-foreground">{zone.name}</h2>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
              {(zone.tables ?? []).map((table) => {
                const isSelected = selected.includes(table.id)
                // Conteo del servidor: platos que cocina marcó listos y nadie
                // llevó todavía. Sin el campo (backend viejo) no se pinta nada.
                const readyCount = table.ready_count ?? 0
                const readyText = `${readyCount} ${readyCount === 1 ? "listo" : "listos"}`
                return (
                  <button
                    key={table.id}
                    type="button"
                    aria-label={`Mesa ${table.number}, ${STATUS_LABEL[table.status ?? "free"]}${
                      readyCount > 0 ? `, ${readyText} para servir` : ""
                    }`}
                    aria-pressed={mode !== "idle" ? isSelected : undefined}
                    className={`flex min-h-[88px] flex-col items-start gap-1 rounded-lg border p-3 text-left transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring ${
                      isSelected ? "border-primary ring-2 ring-primary" : "border-border"
                    }`}
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
                  >
                    <div className="flex w-full items-center justify-between">
                      <span className="text-base font-semibold">Mesa {table.number}</span>
                      <Badge variant={STATUS_VARIANT[table.status ?? "free"]}>
                        {STATUS_LABEL[table.status ?? "free"]}
                      </Badge>
                    </div>
                    <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                      <Users className="size-3" aria-hidden="true" />
                      {table.covers ?? table.seats ?? "—"}
                    </span>
                    {table.status !== "free" ? (
                      <span className="text-xs text-muted-foreground">
                        {elapsedLabel(table.opened_at)} · {formatCOP(table.total)}
                      </span>
                    ) : null}
                    {readyCount > 0 ? (
                      <span className="inline-flex items-center gap-1 rounded-full bg-success px-2 py-0.5 text-xs font-semibold text-success-foreground">
                        <BellRing className="size-3.5" aria-hidden="true" />
                        {readyText}
                      </span>
                    ) : null}
                  </button>
                )
              })}
            </div>
          </section>
        ))
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
