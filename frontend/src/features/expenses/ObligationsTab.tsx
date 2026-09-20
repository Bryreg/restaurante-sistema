/**
 * Admin → Obligaciones y gastos → Obligaciones agendadas (T2,
 * `GET`/`POST /admin/obligations`, `POST /admin/obligations/{id}/settle`):
 * arriendo, servicios, impuestos, con su vencimiento y su estado.
 *
 * `status` es `"pending" | "paid"` (`app/expenses/schemas.py::
 * ObligationStatusLiteral`, verificado por lectura directa, no adivinado):
 * no existe un tercer estado "cancelada" — una obligación cancelada sigue
 * `pending` y lleva `cancelled_at` propio, que esta pantalla muestra aparte.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useState } from "react"

import { newIdempotencyKey } from "@/api/client"
import {
  createObligation,
  getObligations,
  settleObligation,
  type ObligationCategory,
  type ObligationOut,
  type ObligationStatus,
} from "@/api/expenses"
import { EmptyState } from "@/components/EmptyState"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { MoneyInput } from "@/components/MoneyInput"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { formatBusinessDate, formatInstant } from "@/lib/businessDate"
import { errorMessage } from "@/lib/errors"
import { formatCOP } from "@/lib/money"

import { obligationCategoryLabel, obligationStatusLabel, OBLIGATION_CATEGORY_LABEL } from "./lib"

function CreateObligationDialog({ storeId, onCreated }: { storeId: number; onCreated: () => void }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [description, setDescription] = useState("")
  const [category, setCategory] = useState<ObligationCategory>("other")
  const [dueDate, setDueDate] = useState("")
  const [amount, setAmount] = useState<number | null>(null)

  const mutation = useMutation({
    mutationFn: () =>
      createObligation(storeId, {
        description: description.trim(),
        category,
        due_date: dueDate,
        amount: amount as number,
      }),
    onSuccess: () => {
      setDescription("")
      setAmount(null)
      setOpen(false)
      onCreated()
    },
  })

  const canSubmit = description.trim() !== "" && dueDate.trim() !== "" && amount !== null && amount > 0

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button className="h-11 gap-2" />}>Agendar obligación</DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Agendar obligación</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="obligation-description">Descripción</Label>
            <Input id="obligation-description" className="h-11" value={description} onChange={(event) => setDescription(event.target.value)} />
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="obligation-category">Categoría</Label>
              <Select value={category} onValueChange={(value) => setCategory(value as ObligationCategory)}>
                <SelectTrigger id="obligation-category" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(Object.keys(OBLIGATION_CATEGORY_LABEL) as ObligationCategory[]).map((key) => (
                    <SelectItem key={key} value={key}>
                      {OBLIGATION_CATEGORY_LABEL[key]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="obligation-due-date">Vencimiento</Label>
              <Input id="obligation-due-date" type="date" className="h-11" value={dueDate} onChange={(event) => setDueDate(event.target.value)} />
            </div>
          </div>
          <div className="space-y-1">
            <Label htmlFor="obligation-amount">Monto</Label>
            <MoneyInput id="obligation-amount" value={amount} onChange={setAmount} />
          </div>
          {mutation.isError ? (
            <p role="alert" className="text-sm text-destructive">
              {errorMessage(mutation.error)}
            </p>
          ) : null}
          <Button type="button" className="w-full" disabled={!canSubmit || mutation.isPending} onClick={() => mutation.mutate()}>
            Guardar obligación
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function SettleAction({ obligation, onSettled }: { obligation: ObligationOut; onSettled: () => void }): React.JSX.Element {
  const mutation = useMutation({
    // `source` siempre "other" desde esta pantalla — "cash_drawer" exige
    // referenciar un `cash_movement_id` que ya exista, y esta pantalla no
    // tiene forma de elegir uno (gap declarado en el entregable).
    mutationFn: () => settleObligation(obligation.id, { source: "other" }, newIdempotencyKey()),
    onSuccess: onSettled,
  })
  return (
    <div className="space-y-1">
      <Button type="button" variant="outline" size="sm" disabled={mutation.isPending} onClick={() => mutation.mutate()}>
        Saldar
      </Button>
      {mutation.isError ? (
        <p role="alert" className="text-xs text-destructive">
          {errorMessage(mutation.error)}
        </p>
      ) : null}
    </div>
  )
}

export function ObligationsTab({ storeId }: { storeId: number }): React.JSX.Element {
  const [status, setStatus] = useState<ObligationStatus | "all">("all")
  const queryClient = useQueryClient()

  const query = useQuery({
    queryKey: ["expenses", "obligations", storeId, status],
    queryFn: () => getObligations({ storeId, status: status === "all" ? undefined : status }),
  })

  function invalidate() {
    void queryClient.invalidateQueries({ queryKey: ["expenses", "obligations"] })
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1">
          <Label htmlFor="obligation-status-filter">Estado</Label>
          <Select value={status} onValueChange={(value) => setStatus(value as ObligationStatus | "all")}>
            <SelectTrigger id="obligation-status-filter" className="w-48">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Todas</SelectItem>
              <SelectItem value="pending">Pendientes</SelectItem>
              <SelectItem value="paid">Pagadas</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <CreateObligationDialog storeId={storeId} onCreated={invalidate} />
      </div>

      {query.isLoading ? (
        <p className="text-sm text-muted-foreground">Cargando obligaciones…</p>
      ) : query.isError ? (
        <EmptyState role="alert" title="No se pudieron cargar las obligaciones" description={errorMessage(query.error)} action={{ label: "Reintentar", onClick: () => void query.refetch() }} />
      ) : (query.data ?? []).length === 0 ? (
        <EmptyState title="No hay obligaciones agendadas" />
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Descripción</TableHead>
                <TableHead>Categoría</TableHead>
                <TableHead>Vencimiento</TableHead>
                <TableHead>Monto</TableHead>
                <TableHead>Estado</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {(query.data ?? []).map((obligation) => (
                <TableRow key={obligation.id}>
                  <TableCell>{obligation.description ?? "—"}</TableCell>
                  <TableCell>{obligationCategoryLabel(obligation.category)}</TableCell>
                  <TableCell>
                    {formatBusinessDate(obligation.due_date)}
                    {obligation.overdue ? <Badge variant="destructive" className="ml-2">Vencida</Badge> : null}
                  </TableCell>
                  <TableCell className="tabular-nums">{formatCOP(obligation.amount ?? null)}</TableCell>
                  <TableCell>
                    <Badge variant={obligation.status === "paid" ? "secondary" : "outline"}>
                      {obligationStatusLabel(obligation.status)}
                    </Badge>
                    {obligation.cancelled_at ? (
                      <div className="mt-1 text-xs text-muted-foreground">
                        Cancelada {formatInstant(obligation.cancelled_at)}
                        {obligation.cancelled_reason ? `: ${obligation.cancelled_reason}` : ""}
                      </div>
                    ) : null}
                  </TableCell>
                  <TableCell>{obligation.status === "pending" && !obligation.cancelled_at ? <SettleAction obligation={obligation} onSettled={invalidate} /> : null}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  )
}

export default ObligationsTab
