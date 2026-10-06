import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Plus, Trash2 } from "lucide-react"
import { useRef, useState } from "react"

import { useSession } from "@/app/session"
import { newIdempotencyKey } from "@/api/client"
import { listIngredients, type IngredientOut } from "@/api/inventory"
import {
  cancelPurchaseOrder,
  createPurchaseOrder,
  createPurchaseOrderFromReplenishment,
  listPurchaseOrders,
  sendPurchaseOrder,
  updatePurchaseOrder,
  type PurchaseOrderIn,
  type PurchaseOrderOut,
  type SupplierOut,
} from "@/api/purchases"
import { MenuDeFila } from "@/components/admin"
import { EmptyState } from "@/components/EmptyState"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { DropdownMenuItem } from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import { errorMessage } from "@/lib/errors"
import { formatFechaCorta } from "@/lib/format"
import { formatCOP } from "@/lib/money"

import { PURCHASE_ORDER_STATUS_LABEL, printOrderUrl } from "./lib"

interface LineDraft {
  key: string
  ingredientId: number | null
  quantity: string
  price: string
}

let lineSeq = 0
function emptyLine(): LineDraft {
  lineSeq += 1
  return { key: `po-line-${lineSeq}`, ingredientId: null, quantity: "", price: "" }
}

function linesFromOrder(order: PurchaseOrderOut): LineDraft[] {
  return order.lines.map((ln) => {
    lineSeq += 1
    return {
      key: `po-line-${lineSeq}`,
      ingredientId: ln.ingredient_id,
      quantity: ln.quantity,
      price: ln.expected_unit_price ?? "",
    }
  })
}

/**
 * Crear o editar una orden en borrador: proveedor, fecha esperada, notas y
 * las líneas en la unidad de COMPRA del insumo. Las cantidades y los precios
 * viajan como texto: el servidor los valida y convierte.
 */
function OrderEditor({
  storeId,
  suppliers,
  ingredients,
  order,
  onDone,
}: {
  storeId: number
  suppliers: SupplierOut[]
  ingredients: IngredientOut[]
  order: PurchaseOrderOut | null
  onDone: () => void
}): React.JSX.Element {
  const queryClient = useQueryClient()
  const [supplierId, setSupplierId] = useState<number | null>(order?.supplier_id ?? null)
  const [expectedDate, setExpectedDate] = useState(order?.expected_date ?? "")
  const [notes, setNotes] = useState(order?.notes ?? "")
  const [lines, setLines] = useState<LineDraft[]>(() => (order ? linesFromOrder(order) : [emptyLine()]))
  const keyRef = useRef(newIdempotencyKey())

  const mutation = useMutation({
    mutationFn: (payload: PurchaseOrderIn) =>
      order ? updatePurchaseOrder(order.id, payload, keyRef.current) : createPurchaseOrder(storeId, payload, keyRef.current),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["purchases", "orders"] })
      onDone()
    },
    onError: () => {
      keyRef.current = newIdempotencyKey()
    },
  })

  const complete = lines.filter((l) => l.ingredientId !== null && l.quantity.trim() !== "")
  const canSave = supplierId !== null && complete.length > 0 && !mutation.isPending

  function update(key: string, patch: Partial<LineDraft>) {
    setLines((prev) => prev.map((l) => (l.key === key ? { ...l, ...patch } : l)))
  }

  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault()
        if (!canSave) return
        mutation.mutate({
          supplier_id: supplierId as number,
          expected_date: expectedDate.trim() === "" ? null : expectedDate,
          notes: notes.trim() === "" ? null : notes.trim(),
          lines: complete.map((l) => ({
            ingredient_id: l.ingredientId as number,
            quantity: l.quantity.trim(),
            expected_unit_price: l.price.trim() === "" ? null : l.price.trim(),
          })),
        })
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <Label htmlFor="po-proveedor">Proveedor</Label>
          <Select value={supplierId === null ? "" : String(supplierId)} onValueChange={(v) => setSupplierId(v ? Number(v) : null)}>
            <SelectTrigger id="po-proveedor" aria-label="Proveedor" className="w-full">
              <SelectValue placeholder="Elegí un proveedor" />
            </SelectTrigger>
            <SelectContent>
              {suppliers.map((s) => (
                <SelectItem key={s.id} value={String(s.id)}>
                  {s.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="po-fecha">Fecha esperada de entrega (opcional)</Label>
          <Input id="po-fecha" type="date" value={expectedDate} onChange={(e) => setExpectedDate(e.target.value)} />
        </div>
      </div>

      <div className="space-y-2">
        <p className="text-sm font-medium">Qué se pide</p>
        {lines.map((line, idx) => {
          const ingredient = ingredients.find((i) => i.id === line.ingredientId)
          return (
            <div key={line.key} className="grid grid-cols-[1fr_7rem_8rem_auto] items-end gap-2">
              <div className="space-y-1">
                <Label htmlFor={`${line.key}-insumo`} className="sr-only">
                  Insumo de la línea {idx + 1}
                </Label>
                <Select
                  value={line.ingredientId === null ? "" : String(line.ingredientId)}
                  onValueChange={(v) => update(line.key, { ingredientId: v ? Number(v) : null })}
                >
                  <SelectTrigger id={`${line.key}-insumo`} aria-label={`Insumo de la línea ${idx + 1}`} className="w-full">
                    <SelectValue placeholder="Insumo" />
                  </SelectTrigger>
                  <SelectContent>
                    {ingredients.map((i) => (
                      <SelectItem key={i.id} value={String(i.id)}>
                        {i.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label htmlFor={`${line.key}-cantidad`} className="text-xs text-muted-foreground">
                  Cantidad{ingredient ? ` (${ingredient.purchase_unit})` : ""}
                </Label>
                <Input
                  id={`${line.key}-cantidad`}
                  inputMode="decimal"
                  value={line.quantity}
                  onChange={(e) => update(line.key, { quantity: e.target.value })}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor={`${line.key}-precio`} className="text-xs text-muted-foreground">
                  Precio esperado
                </Label>
                <Input
                  id={`${line.key}-precio`}
                  inputMode="decimal"
                  placeholder="opcional"
                  value={line.price}
                  onChange={(e) => update(line.key, { price: e.target.value })}
                />
              </div>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={`Quitar la línea ${idx + 1}`}
                disabled={lines.length === 1}
                onClick={() => setLines((prev) => prev.filter((l) => l.key !== line.key))}
              >
                <Trash2 className="size-4" aria-hidden="true" />
              </Button>
            </div>
          )
        })}
        <Button type="button" variant="outline" size="sm" className="gap-1" onClick={() => setLines((prev) => [...prev, emptyLine()])}>
          <Plus className="size-4" aria-hidden="true" />
          Agregar insumo
        </Button>
      </div>

      <div className="space-y-1">
        <Label htmlFor="po-notas">Notas para el proveedor (opcional)</Label>
        <Textarea id="po-notas" value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} />
      </div>

      {mutation.isError ? (
        <p role="alert" className="text-sm text-destructive">
          {errorMessage(mutation.error)}
        </p>
      ) : null}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onDone}>
          Cerrar sin guardar
        </Button>
        <Button type="submit" disabled={!canSave}>
          {order ? "Guardar borrador" : "Crear borrador"}
        </Button>
      </div>
    </form>
  )
}

/** Desde la reposición sugerida: el servidor arma el borrador con lo que falta de ese proveedor. */
function FromReplenishmentDialog({
  storeId,
  suppliers,
  open,
  onOpenChange,
}: {
  storeId: number
  suppliers: SupplierOut[]
  open: boolean
  onOpenChange: (open: boolean) => void
}): React.JSX.Element {
  const queryClient = useQueryClient()
  const [supplierId, setSupplierId] = useState<number | null>(null)
  const keyRef = useRef(newIdempotencyKey())
  const mutation = useMutation({
    mutationFn: () => createPurchaseOrderFromReplenishment(storeId, { supplier_id: supplierId as number }, keyRef.current),
    onSuccess: () => {
      keyRef.current = newIdempotencyKey()
      void queryClient.invalidateQueries({ queryKey: ["purchases", "orders"] })
      onOpenChange(false)
    },
    onError: () => {
      keyRef.current = newIdempotencyKey()
    },
  })
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Orden desde la reposición sugerida</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          Toma los insumos que tienen asignado a este proveedor y pide lo que la reposición sugerida dice que falta, en
          unidades de compra enteras. Queda en borrador para revisarla.
        </p>
        <div className="space-y-1">
          <Label htmlFor="po-rep-proveedor">Proveedor</Label>
          <Select value={supplierId === null ? "" : String(supplierId)} onValueChange={(v) => setSupplierId(v ? Number(v) : null)}>
            <SelectTrigger id="po-rep-proveedor" aria-label="Proveedor de la reposición" className="w-full">
              <SelectValue placeholder="Elegí un proveedor" />
            </SelectTrigger>
            <SelectContent>
              {suppliers.map((s) => (
                <SelectItem key={s.id} value={String(s.id)}>
                  {s.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {mutation.isError ? (
          <p role="alert" className="text-sm text-destructive">
            {errorMessage(mutation.error)}
          </p>
        ) : null}
        <div className="flex justify-end">
          <Button type="button" disabled={supplierId === null || mutation.isPending} onClick={() => mutation.mutate()}>
            Armar borrador
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function CancelDialog({ order, onClose }: { order: PurchaseOrderOut; onClose: () => void }): React.JSX.Element {
  const queryClient = useQueryClient()
  const [reason, setReason] = useState("")
  const keyRef = useRef(newIdempotencyKey())
  const mutation = useMutation({
    mutationFn: () => cancelPurchaseOrder(order.id, reason.trim(), keyRef.current),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["purchases", "orders"] })
      onClose()
    },
    onError: () => {
      keyRef.current = newIdempotencyKey()
    },
  })
  return (
    <Dialog open onOpenChange={(open) => (open ? null : onClose())}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Cancelar la orden #{order.number}</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">No se borra: queda cancelada, con quién, cuándo y por qué.</p>
        <div className="space-y-1">
          <Label htmlFor="po-cancel-motivo">Motivo</Label>
          <Textarea id="po-cancel-motivo" value={reason} onChange={(e) => setReason(e.target.value)} rows={2} />
        </div>
        {mutation.isError ? (
          <p role="alert" className="text-sm text-destructive">
            {errorMessage(mutation.error)}
          </p>
        ) : null}
        <div className="flex justify-end">
          <Button type="button" variant="destructive" disabled={reason.trim() === "" || mutation.isPending} onClick={() => mutation.mutate()}>
            Cancelar la orden
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function OrderRow({
  order,
  onEdit,
  onCancel,
}: {
  order: PurchaseOrderOut
  onEdit: () => void
  onCancel: () => void
}): React.JSX.Element {
  const queryClient = useQueryClient()
  const keyRef = useRef(newIdempotencyKey())
  const send = useMutation({
    mutationFn: () => sendPurchaseOrder(order.id, keyRef.current),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["purchases", "orders"] }),
  })
  const cancellable = order.status === "draft" || order.status === "sent" || order.status === "partially_received"
  const closed = order.lines.filter((l) => l.closed).length
  return (
    <tr className="border-t">
      <td className="px-3 py-2 tabular-nums">#{order.number}</td>
      <td className="px-3 py-2">{order.supplier_name}</td>
      <td className="px-3 py-2">
        {PURCHASE_ORDER_STATUS_LABEL[order.status]}
        {order.status === "partially_received" ? (
          <span className="ml-1 text-xs text-muted-foreground">
            ({closed} de {order.lines.length})
          </span>
        ) : null}
      </td>
      <td className="px-3 py-2">{formatFechaCorta(order.business_date)}</td>
      <td className="px-3 py-2 text-right tabular-nums" title={order.expected_total_reason ?? undefined}>
        {order.expected_total === null ? <span className="text-muted-foreground">Sin total</span> : formatCOP(order.expected_total)}
      </td>
      <td className="px-3 py-2 text-right">
        <MenuDeFila nombre={`la orden #${order.number}`}>
          <DropdownMenuItem onClick={() => window.open(printOrderUrl(order.id), "_blank", "noopener")}>
            Imprimir o compartir
          </DropdownMenuItem>
          {order.status === "draft" ? <DropdownMenuItem onClick={onEdit}>Editar</DropdownMenuItem> : null}
          {order.status === "draft" ? (
            <DropdownMenuItem disabled={send.isPending} onClick={() => send.mutate()}>
              Marcar enviada
            </DropdownMenuItem>
          ) : null}
          {cancellable ? <DropdownMenuItem onClick={onCancel}>Cancelar orden</DropdownMenuItem> : null}
        </MenuDeFila>
      </td>
    </tr>
  )
}

/**
 * Compras › Órdenes (tanda 5, i3): lo que se le pidió a cada proveedor.
 * Borrador → enviada → recibida en parte → recibida (o cancelada con
 * motivo). La recepción que nombra la orden cierra sus líneas; el estado lo
 * decide el servidor.
 */
export function PurchaseOrdersTab({ storeId, suppliers }: { storeId: number; suppliers: SupplierOut[] }): React.JSX.Element {
  const { hasFeature } = useSession()
  const replenishmentOn = hasFeature("inventory.replenishment")
  const [editing, setEditing] = useState<PurchaseOrderOut | "new" | null>(null)
  const [cancelling, setCancelling] = useState<PurchaseOrderOut | null>(null)
  const [fromReplenishment, setFromReplenishment] = useState(false)

  const ordersQuery = useQuery({
    queryKey: ["purchases", "orders", storeId],
    queryFn: () => listPurchaseOrders(storeId),
  })
  const ingredientsQuery = useQuery({
    queryKey: ["inventory", "ingredients", storeId, false],
    queryFn: () => listIngredients(storeId, { activeOnly: true }),
  })
  const orders = ordersQuery.data ?? []

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap justify-end gap-2">
        {replenishmentOn ? (
          <Button type="button" variant="outline" onClick={() => setFromReplenishment(true)}>
            Desde la reposición sugerida
          </Button>
        ) : null}
        <Button type="button" onClick={() => setEditing("new")}>
          Nueva orden de compra
        </Button>
      </div>

      {ordersQuery.isLoading ? (
        <p className="text-sm text-muted-foreground">Cargando órdenes…</p>
      ) : ordersQuery.isError ? (
        <EmptyState reason="error" title="No se pudieron leer las órdenes" description={errorMessage(ordersQuery.error)} />
      ) : orders.length === 0 ? (
        <EmptyState
          reason="dependency"
          title="Todavía no hay órdenes de compra"
          description="Armá una a mano o desde la reposición sugerida; al recibir, elegila en la recepción y se cierran sus líneas."
        />
      ) : (
        <table className="w-full text-sm">
          <thead className="text-xs text-muted-foreground">
            <tr>
              <th className="px-3 py-1.5 text-left font-medium">Orden</th>
              <th className="px-3 py-1.5 text-left font-medium">Proveedor</th>
              <th className="px-3 py-1.5 text-left font-medium">Estado</th>
              <th className="px-3 py-1.5 text-left font-medium">Creada</th>
              <th className="px-3 py-1.5 text-right font-medium">Total esperado</th>
              <th className="px-3 py-1.5" aria-label="Acciones" />
            </tr>
          </thead>
          <tbody>
            {orders.map((o) => (
              <OrderRow key={o.id} order={o} onEdit={() => setEditing(o)} onCancel={() => setCancelling(o)} />
            ))}
          </tbody>
        </table>
      )}

      <Dialog open={editing !== null} onOpenChange={(open) => (open ? null : setEditing(null))}>
        <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{editing !== null && editing !== "new" ? `Editar la orden #${editing.number}` : "Nueva orden de compra"}</DialogTitle>
          </DialogHeader>
          {editing !== null ? (
            <OrderEditor
              storeId={storeId}
              suppliers={suppliers}
              ingredients={ingredientsQuery.data ?? []}
              order={editing === "new" ? null : editing}
              onDone={() => setEditing(null)}
            />
          ) : null}
        </DialogContent>
      </Dialog>
      {replenishmentOn ? (
        <FromReplenishmentDialog storeId={storeId} suppliers={suppliers} open={fromReplenishment} onOpenChange={setFromReplenishment} />
      ) : null}
      {cancelling ? <CancelDialog order={cancelling} onClose={() => setCancelling(null)} /> : null}
    </div>
  )
}

export default PurchaseOrdersTab
