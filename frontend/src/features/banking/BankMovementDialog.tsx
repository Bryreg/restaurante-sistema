/**
 * Registrar un movimiento que el sistema no conoce por otro lado
 * (`POST /admin/bank/movements`): la nómina pagada por transferencia, la
 * cuota de manejo, un aporte o un retiro del dueño, un traslado entre
 * cuentas. Causa tipada, nunca texto libre; lo que el sistema ya registra
 * (consignaciones, gastos y obligaciones pagados del banco, pagos a
 * proveedores) entra solo y no se teclea acá.
 */
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { useRef, useState } from "react"

import { createBankMovement, type BankAccountOut, type BankDirection, type BankMovementCause } from "@/api/banking"
import { newIdempotencyKey } from "@/api/client"
import { MoneyInput } from "@/components/MoneyInput"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { errorMessage } from "@/lib/errors"
import { formatCOP } from "@/lib/money"

import { CAUSES_BY_DIRECTION, MOVEMENT_CAUSE_LABEL, todayLocal } from "./lib"

export function BankMovementDialog({ storeId, accounts }: { storeId: number; accounts: BankAccountOut[] }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [direction, setDirection] = useState<BankDirection>("out")
  const [cause, setCause] = useState<BankMovementCause>("payroll")
  const [accountId, setAccountId] = useState("")
  const [counterId, setCounterId] = useState("")
  const [businessDate, setBusinessDate] = useState(todayLocal())
  const [amount, setAmount] = useState<number | null>(null)
  const [description, setDescription] = useState("")
  const keyRef = useRef(newIdempotencyKey())
  const queryClient = useQueryClient()
  const reales = accounts.filter((a) => a.id !== null && a.active)
  const esTraslado = cause === "account_transfer"

  const mutation = useMutation({
    mutationFn: () =>
      createBankMovement(
        storeId,
        {
          account_id: accountId === "" ? null : Number(accountId),
          counter_account_id: esTraslado && counterId !== "" ? Number(counterId) : null,
          direction,
          cause,
          business_date: businessDate,
          amount: amount as number,
          description: description.trim(),
        },
        keyRef.current,
      ),
    onSuccess: () => {
      keyRef.current = newIdempotencyKey()
      void queryClient.invalidateQueries({ queryKey: ["banking"] })
      setAmount(null)
      setDescription("")
      setOpen(false)
    },
  })

  function cambiarSentido(value: BankDirection) {
    setDirection(value)
    setCause(CAUSES_BY_DIRECTION[value][0])
  }

  const canSubmit =
    amount !== null && amount > 0 && description.trim() !== "" && businessDate !== "" && (!esTraslado || counterId !== "")

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button variant="outline" className="h-11" />}>Registrar movimiento</DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Registrar movimiento del banco</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Sólo lo que el sistema no sabe: consignaciones, gastos y obligaciones pagados del banco y pagos a proveedores
            ya entran solos. El 4×1000 lo calcula el sistema; no lo teclees.
          </p>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label htmlFor="movement-direction">Sentido</Label>
              <select
                id="movement-direction"
                className="h-11 w-full rounded-md border border-input bg-card px-2"
                value={direction}
                onChange={(e) => cambiarSentido(e.target.value as BankDirection)}
              >
                <option value="out">Sale</option>
                <option value="in">Entra</option>
              </select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="movement-cause">Causa</Label>
              <select
                id="movement-cause"
                className="h-11 w-full rounded-md border border-input bg-card px-2"
                value={cause}
                onChange={(e) => setCause(e.target.value as BankMovementCause)}
              >
                {CAUSES_BY_DIRECTION[direction].map((c) => (
                  <option key={c} value={c}>
                    {MOVEMENT_CAUSE_LABEL[c]}
                  </option>
                ))}
              </select>
            </div>
          </div>
          {reales.length > 1 ? (
            <div className="space-y-1">
              <Label htmlFor="movement-account">{esTraslado ? "Sale de la cuenta" : "Cuenta"}</Label>
              <select
                id="movement-account"
                className="h-11 w-full rounded-md border border-input bg-card px-2"
                value={accountId}
                onChange={(e) => setAccountId(e.target.value)}
              >
                <option value="">La principal</option>
                {reales.map((a) => (
                  <option key={a.id} value={String(a.id)}>
                    {a.name}
                  </option>
                ))}
              </select>
            </div>
          ) : null}
          {esTraslado ? (
            <div className="space-y-1">
              <Label htmlFor="movement-counter">Entra a la cuenta</Label>
              <select
                id="movement-counter"
                className="h-11 w-full rounded-md border border-input bg-card px-2"
                value={counterId}
                onChange={(e) => setCounterId(e.target.value)}
              >
                <option value="">Elegí la cuenta</option>
                {reales.map((a) => (
                  <option key={a.id} value={String(a.id)}>
                    {a.name}
                  </option>
                ))}
              </select>
            </div>
          ) : null}
          <div className="space-y-1">
            <Label htmlFor="movement-date">Fecha</Label>
            <Input id="movement-date" type="date" className="h-11" max={todayLocal()} value={businessDate} onChange={(e) => setBusinessDate(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="movement-amount">Monto</Label>
            <MoneyInput id="movement-amount" value={amount} onChange={setAmount} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="movement-description">Concepto</Label>
            <Input id="movement-description" className="h-11" maxLength={200} value={description} onChange={(e) => setDescription(e.target.value)} />
          </div>
          {mutation.isError ? (
            <p role="alert" className="text-sm text-destructive">
              {errorMessage(mutation.error)}
            </p>
          ) : null}
          <Button type="button" className="w-full" disabled={!canSubmit || mutation.isPending} onClick={() => mutation.mutate()}>
            {amount !== null && amount > 0 ? `Registrar ${formatCOP(amount)}` : "Registrar movimiento"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

export default BankMovementDialog
