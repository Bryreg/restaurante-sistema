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
  DenseTable,
  DenseTableBar,
  FormField,
  FormSection,
  type DenseColumn,
  type LegendEntry,
} from "@/components/admin"
import { DesdeHacia } from "@/components/DesdeHacia"
import { EmptyState } from "@/components/EmptyState"
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

/**
 * **La leyenda del pie** (patrón 8 d). Los términos están elegidos para no
 * repetir el texto de ninguna celda —«Vigente» y «Anulado» viven en la
 * columna Estado— porque una leyenda que duplica una celda deja de aclarar y
 * pasa a confundir dos cosas que están en lugares distintos.
 */
const PAYMENTS_LEGEND: readonly LegendEntry[] = [
  {
    term: "Pago anulado",
    meaning: (
      <>
        no se borra: queda con su motivo y quién lo anuló, y <b>el saldo vuelve a subir</b>. Anular no es lo
        mismo que no haber pagado nunca.
      </>
    ),
  },
  {
    term: "Cajón",
    meaning: (
      <>
        «Sí» quiere decir que además del pago quedó un <b>egreso en el turno abierto</b>. «No» es plata que
        salió por banco y nunca pasó por el cajón del salón.
      </>
    ),
  },
  {
    term: "Saldo",
    meaning: "lo lleva el servidor, no esta tabla: sumar los pagos de acá no es el saldo, porque los anulados no descuentan.",
  },
]

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
  supplierLabel,
  onPaid,
}: {
  payable: PayableOut
  supplierLabel: string
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
    <FormSection
      title="Registrar un pago"
      governs="Lo que efectivamente sale a pagarle a este proveedor. El saldo lo lleva el servidor: acá se declara una salida, no se recalcula la cuenta."
      reading={
        fromCashDrawer ? (
          <>
            Este pago va a salir <b>del cajón</b>: además del pago queda un <b>egreso en el turno abierto</b> de
            esta sede, en la misma operación. <b>Sin turno abierto el pago no se registra</b> — no queda a
            medias, no se registra.
          </>
        ) : (
          <>
            Este pago sale <b>por fuera del cajón</b> (banco, transferencia, cheque): no toca el turno ni el
            arqueo. Si la plata salió del cajón del salón, prendé «Desde el cajón» o el cierre va a sobrar.
          </>
        )
      }
      doesNotDo="Registrar un pago no aprueba la cuenta ni cambia lo que el proveedor facturó: sólo declara que esta plata salió."
    >
      {/* Del servidor, textual: el frontend nunca deriva un saldo. */}
      <p className="text-sm text-muted-foreground sm:col-span-2">Saldo pendiente: {formatCOP(payable.balance)}</p>

      <FormField
        label="Monto"
        help="Lo que sale ahora. Puede ser menos que el saldo: una cuenta se paga en partes y el saldo baja con cada pago."
      >
        {({ fieldId, describedBy }) => (
          <MoneyInput id={fieldId} aria-describedby={describedBy} value={amount} onChange={setAmount} />
        )}
      </FormField>

      <FormField label="Medio" help="Por dónde sale. Es lo que después permite cruzar este pago con el extracto del banco.">
        {({ fieldId, describedBy }) => (
          <Select value={method} onValueChange={(value) => setMethod(value as SupplierPaymentMethod)}>
            <SelectTrigger id={fieldId} aria-describedby={describedBy} className="w-full">
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
        )}
      </FormField>

      <FormField
        label="Fecha real de salida"
        help="Cuándo salió la plata de verdad, no cuándo se carga acá. De esto depende en qué mes cae el gasto."
      >
        {({ fieldId, describedBy }) => (
          <Input
            id={fieldId}
            aria-describedby={describedBy}
            type="datetime-local"
            value={paidAt}
            onChange={(event) => setPaidAt(event.target.value)}
          />
        )}
      </FormField>

      <FormField
        label="Comprobante (opcional)"
        help="Número de transferencia, cheque o recibo. Es lo que se busca cuando el proveedor dice que no le llegó."
      >
        {({ fieldId, describedBy }) => (
          <Input
            id={fieldId}
            aria-describedby={describedBy}
            value={reference}
            onChange={(event) => setReference(event.target.value)}
          />
        )}
      </FormField>

      <FormField
        label="Desde el cajón"
        help="Prendelo sólo si la plata salió del efectivo del salón. Crea el egreso en el turno abierto; sin turno abierto, el pago no se registra."
        scope={{ affects: [{ screen: "Salón › Turno › Movimientos" }], requires: "PIN de administrador" }}
      >
        {({ fieldId, describedBy }) => (
          <span className="flex h-8 items-center">
            <Switch
              id={fieldId}
              aria-describedby={describedBy}
              checked={fromCashDrawer}
              onCheckedChange={setFromCashDrawer}
            />
          </span>
        )}
      </FormField>

      <div className="sm:col-span-2">
        {mutation.isError ? (
          <p role="alert" className="mb-2 text-sm font-medium text-destructive">
            {errorMessage(mutation.error)}
          </p>
        ) : null}
        {/* De dónde sale y a quién va. El saldo que queda no se muestra
            restado acá: lo recalcula el servidor con el pago vivo. */}
        {amountValid ? (
          <DesdeHacia
            className="mb-3"
            desde={fromCashDrawer ? "El cajón del turno abierto" : SUPPLIER_PAYMENT_METHOD_LABEL[method]}
            hacia={supplierLabel}
            monto={amount}
            verbo="Se paga"
            autoriza="PIN de administrador"
          />
        ) : null}
        <PinPad
          length={4}
          label="PIN de administrador para pagar"
          disabled={!amountValid || mutation.isPending}
          onSubmit={(pin) => mutation.mutate(pin)}
        />
      </div>
    </FormSection>
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
  const vivos = payments.filter((payment) => payment.voided_at === null).length

  const paymentColumns: readonly DenseColumn<PaymentOut>[] = [
    { key: "amount", header: "Monto", kind: "number", cell: (payment) => formatCOP(payment.amount) },
    {
      key: "method",
      // La palabra del negocio, no el enum (`cash`, `transfer`).
      header: "Medio",
      cell: (payment) => SUPPLIER_PAYMENT_METHOD_LABEL[payment.method],
    },
    { key: "paid", header: "Fecha", kind: "secondary", cell: (payment) => formatInstant(payment.paid_at) },
    { key: "drawer", header: "Cajón", cell: (payment) => (payment.from_cash_drawer ? "Sí" : "No") },
    {
      key: "state",
      header: "Estado",
      cell: (payment) =>
        payment.voided_at ? (
          <span className="inline-flex items-center gap-1.5">
            <Badge variant="destructive">Anulado</Badge>
            <span className="text-xs text-muted-foreground">
              {payment.voided_reason}
              {payment.voided_by_employee_name ? ` · ${payment.voided_by_employee_name}` : ""}
            </span>
          </span>
        ) : (
          <Badge variant="secondary">Vigente</Badge>
        ),
    },
    {
      key: "actions",
      header: "",
      kind: "actions",
      cell: (payment) => (
        <VoidPaymentAction
          payableId={payable.id}
          payment={payment}
          onVoided={() => {
            invalidate()
          }}
        />
      ),
    },
  ]

  function invalidate() {
    void queryClient.invalidateQueries({ queryKey: ["purchases", "payables"] })
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button variant="outline" size="sm" />}>Ver</DialogTrigger>
      <DialogContent className="sm:max-w-2xl">
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
              supplierLabel={supplierLabel}
              onPaid={() => {
                invalidate()
              }}
            />
          ) : null}
          {payable.status === "approved" && payable.balance === 0 ? (
            <p className="text-sm text-muted-foreground">Cuenta saldada — no queda nada por pagar.</p>
          ) : null}

          {paymentsQuery.isError ? (
            <EmptyState
              role="alert"
              reason="error"
              title="No se pudieron cargar los pagos"
              description="No se pudieron cargar los pagos de esta cuenta. Volvé a abrirla antes de registrar uno nuevo."
              action={{ label: "Reintentar", onClick: () => void paymentsQuery.refetch() }}
            />
          ) : (
            <DenseTable
              caption={`Pagos de la cuenta por pagar #${payable.id}`}
              columns={paymentColumns}
              rows={payments}
              rowKey={(payment) => String(payment.id)}
              // Un pago anulado se sigue viendo —es parte del rastro— pero
              // apagado: ya no mueve plata.
              rowInactive={(payment) => payment.voided_at !== null}
              rowStatus={(payment) => (payment.voided_at ? "none" : "ok")}
              legend={PAYMENTS_LEGEND}
              maxBodyHeightPx={260}
              className="min-w-0"
              bar={
                <DenseTableBar
                  shown={payments.length}
                  total={payments.length}
                  noun="pagos registrados"
                  hidden={
                    paymentsQuery.isPending
                      ? "cargando los pagos…"
                      : vivos < payments.length
                        ? `${payments.length - vivos} anulados, que ya no descuentan`
                        : undefined
                  }
                />
              }
              note="Un pago no se borra: se anula con motivo y PIN de administrador, y el motivo queda a la vista en su fila."
              empty={
                paymentsQuery.isPending ? undefined : (
                  <EmptyState
                    title="Todavía no se registró ningún pago"
                    description="El saldo sigue entero. Cuando salga la plata, registrala acá para que la cuenta baje."
                  />
                )
              }
            />
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}

export default PayableDetailDialog
