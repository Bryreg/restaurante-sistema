/**
 * Detalle de una cuenta por pagar: aprobación explícita, registro de pago
 * y anulación de un pago (spec.md § Payables and payments).
 *
 * **Hueco de contrato declarado** (`frontend-compras.md § 8`): no existe
 * `GET /admin/payables/{id}/payments` — sólo se puede CREAR un pago y
 * ANULARLO por id, nunca LISTAR los que ya existen. Esta pantalla guarda,
 * en el `QueryClient` (vive mientras dura la sesión del navegador, nunca en
 * el servidor), los pagos que ESTA pantalla registró en esta sesión, para
 * poder mostrarlos y anularlos — rotulado explícitamente como "Pagos
 * registrados en esta sesión", nunca como el historial completo, porque no
 * lo es: un pago de una sesión anterior, o hecho por otra persona en otra
 * pestaña, no aparece acá. El saldo (`balance`) que sí se muestra siempre
 * es el que el servidor devuelve — ese es correcto y completo, esté o no
 * la lista de pagos.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useRef, useState } from "react"

import { ApiError, newIdempotencyKey } from "@/api/client"
import {
  approvePayable,
  createPayment,
  listPayablePayments,
  voidPayment,
  type PayableOut,
  type PaymentOut,
  type SupplierPaymentMethod,
} from "@/api/purchases"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { MoneyInput } from "@/components/MoneyInput"
import { PinPad } from "@/components/PinPad"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Textarea } from "@/components/ui/textarea"
import { formatBusinessDate, formatInstant } from "@/lib/businessDate"
import { errorMessage } from "@/lib/errors"
import { formatCOP } from "@/lib/money"

import { PAYABLE_STATUS_LABEL, SUPPLIER_PAYMENT_METHOD_LABEL } from "./lib"

/** El historial de pagos viene del servidor.
 *
 * Hasta el cierre de 2b esta pantalla guardaba los pagos en memoria de la
 * sesión, porque `GET /admin/payables/{id}/payments` no existía: faltaba en
 * el contrato de la spec. El resultado era que un administrador que volvía
 * al día siguiente no veía nada, y no podía anular un pago porque el
 * `payment_id` sólo había existido en la respuesta del `POST` que lo creó. */
function paymentsKey(payableId: number) {
  return ["purchases", "payables", payableId, "payments"] as const
}

function ApproveAction({ payable, onApproved }: { payable: PayableOut; onApproved: () => void }): React.JSX.Element {
  const mutation = useMutation({
    mutationFn: (pin: string) => approvePayable(payable.id, { authorizer_pin: pin }),
    onSuccess: onApproved,
  })
  return (
    <div className="space-y-3 rounded-md border p-4">
      <p className="text-sm">
        Mientras está <strong>pendiente de revisión</strong> no se puede pagar: es el control mínimo entre quien
        recibió la mercancía y quien autoriza el pago.
      </p>
      {mutation.isError ? (
        <p role="alert" className="text-sm text-destructive">
          {errorMessage(mutation.error)}
        </p>
      ) : null}
      <PinPad length={4} label="PIN de administrador para aprobar" disabled={mutation.isPending} onSubmit={(pin) => mutation.mutate(pin)} />
    </div>
  )
}

function VoidPaymentAction({
  payableId,
  payment,
  onVoided,
}: {
  payableId: number
  payment: PaymentOut
  onVoided: (payment: PaymentOut) => void
}): React.JSX.Element {
  const [reason, setReason] = useState("")
  const [pin, setPin] = useState("")

  const mutation = useMutation({
    mutationFn: () => voidPayment(payableId, payment.id, { reason: reason.trim(), authorizer_pin: pin.trim() }),
    onSuccess: (voided) => {
      setReason("")
      setPin("")
      onVoided(voided)
    },
  })

  // La anulación, con su motivo y su responsable, la muestra la columna
  // «Estado» de la tabla. Acá sólo queda no ofrecer el botón dos veces.
  if (payment.voided_at) {
    return <span className="text-xs text-muted-foreground">—</span>
  }

  return (
    <AlertDialog onOpenChange={(open) => !open && mutation.reset()}>
      <AlertDialogTrigger render={<Button type="button" variant="outline" size="sm" />}>Anular</AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Anular pago de {formatCOP(payment.amount)}</AlertDialogTitle>
        </AlertDialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor={`void-reason-${payment.id}`}>Motivo</Label>
            <Textarea id={`void-reason-${payment.id}`} value={reason} onChange={(event) => setReason(event.target.value)} />
          </div>
          <div className="space-y-1">
            <Label htmlFor={`void-pin-${payment.id}`}>PIN de administrador</Label>
            <Input
              id={`void-pin-${payment.id}`}
              type="password"
              inputMode="numeric"
              className="h-11"
              value={pin}
              onChange={(event) => setPin(event.target.value)}
            />
          </div>
          {mutation.isError ? (
            <p role="alert" className="text-sm text-destructive">
              {errorMessage(mutation.error)}
            </p>
          ) : null}
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancelar</AlertDialogCancel>
          <AlertDialogAction disabled={reason.trim() === "" || pin.trim() === "" || mutation.isPending} onClick={() => mutation.mutate()}>
            Anular pago
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

function nowLocalDatetime(): string {
  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}`
}

function RegisterPaymentForm({
  payable,
  onPaid,
}: {
  payable: PayableOut
  onPaid: (payment: PaymentOut) => void
}): React.JSX.Element {
  const [amount, setAmount] = useState<number | null>(null)
  const [method, setMethod] = useState<SupplierPaymentMethod>("cash")
  const [paidAt, setPaidAt] = useState(nowLocalDatetime)
  const [reference, setReference] = useState("")
  const [fromCashDrawer, setFromCashDrawer] = useState(false)
  const idempotencyKeyRef = useRef(newIdempotencyKey())

  const mutation = useMutation({
    mutationFn: (pin: string) => {
      if (amount === null) {
        // Guarda tipada, no decorativa (H-9, ronda 2): sin monto no hay pago
        // que enviar, punto — nunca se arma el cuerpo con `amount ?? 0` (eso
        // es exactamente "null dibujado como 0", AGENTS.md). El botón que
        // dispara esto ya exige `amountValid` más abajo; este early-return
        // es la defensa real, para que un refactor que mueva esa guarda no
        // pueda mandar un pago de $0 sin que nada lo impida.
        return Promise.reject(new Error("Falta el monto del pago"))
      }
      return createPayment(
        payable.id,
        {
          amount,
          method,
          paid_at: paidAt,
          reference: reference.trim() === "" ? null : reference.trim(),
          from_cash_drawer: fromCashDrawer,
          authorizer_pin: pin,
        },
        idempotencyKeyRef.current,
      )
    },
    onSuccess: (payment) => {
      setAmount(null)
      setReference("")
      idempotencyKeyRef.current = newIdempotencyKey()
      onPaid(payment)
    },
    onError: (err) => {
      if (!(err instanceof ApiError) || err.status !== 409) {
        idempotencyKeyRef.current = newIdempotencyKey()
      }
    },
  })

  const amountValid = amount !== null && amount > 0

  return (
    <div className="space-y-3 rounded-md border p-4">
      <p className="text-sm text-muted-foreground">Saldo pendiente: {formatCOP(payable.balance)}</p>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <Label htmlFor="pay-amount">Monto</Label>
          <MoneyInput id="pay-amount" value={amount} onChange={setAmount} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="pay-method">Medio</Label>
          <Select value={method} onValueChange={(value) => setMethod(value as SupplierPaymentMethod)}>
            <SelectTrigger id="pay-method" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(SUPPLIER_PAYMENT_METHOD_LABEL) as SupplierPaymentMethod[]).map((m) => (
                <SelectItem key={m} value={m}>
                  {SUPPLIER_PAYMENT_METHOD_LABEL[m]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="pay-paid-at">Fecha real de salida</Label>
          <Input id="pay-paid-at" type="datetime-local" className="h-11" value={paidAt} onChange={(event) => setPaidAt(event.target.value)} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="pay-reference">Comprobante (opcional)</Label>
          <Input id="pay-reference" className="h-11" value={reference} onChange={(event) => setReference(event.target.value)} />
        </div>
      </div>
      <div className="flex items-center gap-3">
        <Switch id="pay-from-drawer" checked={fromCashDrawer} onCheckedChange={setFromCashDrawer} />
        <Label htmlFor="pay-from-drawer">Desde el cajón</Label>
      </div>
      {fromCashDrawer ? (
        <p className="text-xs text-muted-foreground">
          Esto va a crear un egreso en el turno abierto de esta sede, en la misma operación. Si no hay un turno
          abierto, el pago no se registra.
        </p>
      ) : null}
      {mutation.isError ? (
        <p role="alert" className="text-sm font-medium text-destructive">
          {errorMessage(mutation.error)}
        </p>
      ) : null}
      <PinPad
        length={4}
        label="PIN de administrador para pagar"
        disabled={!amountValid || mutation.isPending}
        onSubmit={(pin) => mutation.mutate(pin)}
      />
    </div>
  )
}

export function PayableDetailDialog({
  payable,
  supplierLabel,
}: {
  payable: PayableOut
  supplierLabel: string
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const queryClient = useQueryClient()
  const paymentsQuery = useQuery({
    queryKey: paymentsKey(payable.id),
    queryFn: () => listPayablePayments(payable.id),
    // Sólo cuando el diálogo está abierto: una tabla por cuenta por pagar en
    // el listado serían N consultas para datos que nadie está mirando.
    enabled: open,
  })
  const payments = paymentsQuery.data ?? []

  function invalidate() {
    void queryClient.invalidateQueries({ queryKey: ["purchases", "payables"] })
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button variant="outline" size="sm" />}>Ver</DialogTrigger>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            Cuenta por pagar #{payable.id} · {supplierLabel}
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-3">
            <div>
              <p className="text-muted-foreground">Estado</p>
              <Badge variant={payable.status === "approved" ? "secondary" : "outline"}>{PAYABLE_STATUS_LABEL[payable.status]}</Badge>
            </div>
            <div>
              <p className="text-muted-foreground">Total original</p>
              <p className="tabular-nums">{formatCOP(payable.amount)}</p>
            </div>
            <div>
              <p className="text-muted-foreground">Saldo</p>
              <p className="tabular-nums font-semibold">{formatCOP(payable.balance)}</p>
            </div>
            <div>
              <p className="text-muted-foreground">Vencimiento</p>
              <p>
                {formatBusinessDate(payable.due_date)} {payable.overdue ? <Badge variant="destructive">Vencida</Badge> : null}
              </p>
            </div>
            {payable.approved_at ? (
              <div>
                <p className="text-muted-foreground">Aprobada</p>
                <p>
                  {formatInstant(payable.approved_at)} por {payable.approved_by_employee_name ?? "—"}
                </p>
              </div>
            ) : null}
          </div>

          {payable.status === "cancelled" ? (
            <p className="text-sm text-muted-foreground">
              Esta cuenta por pagar fue cancelada: la recepción que la originó se revirtió.
            </p>
          ) : null}

          {payable.status === "pending_review" ? <ApproveAction payable={payable} onApproved={invalidate} /> : null}

          {payable.status === "approved" && payable.balance > 0 ? (
            <RegisterPaymentForm
              payable={payable}
              onPaid={() => {
                invalidate()
              }}
            />
          ) : null}
          {payable.status === "approved" && payable.balance === 0 ? (
            <p className="text-sm text-muted-foreground">Cuenta saldada — no queda nada por pagar.</p>
          ) : null}

          <div className="space-y-2">
            <p className="text-sm font-medium">Pagos</p>
            {paymentsQuery.isPending ? (
              <p className="text-sm text-muted-foreground">Cargando los pagos…</p>
            ) : paymentsQuery.isError ? (
              <p role="alert" className="text-sm text-destructive">
                No se pudieron cargar los pagos de esta cuenta. Volvé a abrirla antes de registrar uno nuevo.
              </p>
            ) : payments.length === 0 ? (
              <p className="text-sm text-muted-foreground">Todavía no se registró ningún pago.</p>
            ) : (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Monto</TableHead>
                      <TableHead>Medio</TableHead>
                      <TableHead>Fecha</TableHead>
                      <TableHead>Cajón</TableHead>
                      <TableHead>Estado</TableHead>
                      <TableHead />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {payments.map((payment) => (
                      <TableRow key={payment.id}>
                        <TableCell className="tabular-nums">{formatCOP(payment.amount)}</TableCell>
                        <TableCell>{SUPPLIER_PAYMENT_METHOD_LABEL[payment.method]}</TableCell>
                        <TableCell>{formatInstant(payment.paid_at)}</TableCell>
                        <TableCell>{payment.from_cash_drawer ? "Sí" : "No"}</TableCell>
                        <TableCell>
                          {payment.voided_at ? (
                            <div className="space-y-0.5">
                              <Badge variant="destructive">Anulado</Badge>
                              <p className="text-xs text-muted-foreground">
                                {payment.voided_reason}
                                {payment.voided_by_employee_name ? ` · ${payment.voided_by_employee_name}` : ""}
                              </p>
                            </div>
                          ) : (
                            <Badge variant="secondary">Vigente</Badge>
                          )}
                        </TableCell>
                        <TableCell>
                          <VoidPaymentAction
                            payableId={payable.id}
                            payment={payment}
                            onVoided={() => {
                              invalidate()
                            }}
                          />
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

export default PayableDetailDialog
