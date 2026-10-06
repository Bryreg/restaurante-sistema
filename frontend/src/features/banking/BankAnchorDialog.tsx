/**
 * Teclear el saldo del extracto (`POST /admin/bank/anchors`): con cuánto
 * cerró una cuenta un día. El libro corre desde ahí. Si la sede todavía no
 * tiene cuentas, el servidor crea la principal con esta primera escritura.
 */
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { useRef, useState } from "react"

import { createBankAnchor, type BankAccountOut } from "@/api/banking"
import { newIdempotencyKey } from "@/api/client"
import { MoneyInput } from "@/components/MoneyInput"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { errorMessage } from "@/lib/errors"
import { formatCOP } from "@/lib/money"

import { todayLocal } from "./lib"

export function BankAnchorDialog({ storeId, accounts }: { storeId: number; accounts: BankAccountOut[] }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [accountId, setAccountId] = useState<string>("")
  const [balanceDate, setBalanceDate] = useState(todayLocal())
  const [balance, setBalance] = useState<number | null>(null)
  const [note, setNote] = useState("")
  const keyRef = useRef(newIdempotencyKey())
  const queryClient = useQueryClient()
  const reales = accounts.filter((a) => a.id !== null && a.active)

  const mutation = useMutation({
    mutationFn: () =>
      createBankAnchor(
        storeId,
        {
          account_id: accountId === "" ? null : Number(accountId),
          balance_date: balanceDate,
          balance: balance as number,
          note: note.trim() === "" ? null : note.trim(),
        },
        keyRef.current,
      ),
    onSuccess: () => {
      keyRef.current = newIdempotencyKey()
      void queryClient.invalidateQueries({ queryKey: ["banking"] })
      setBalance(null)
      setNote("")
      setOpen(false)
    },
  })

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button className="h-11" />}>Teclear saldo del extracto</DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Teclear saldo del extracto</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Mirá el banco y escribí con cuánto <strong>cerró</strong> la cuenta ese día. Lo que pase desde el día
            siguiente lo suma el libro.
          </p>
          {reales.length > 1 ? (
            <div className="space-y-1">
              <Label htmlFor="anchor-account">Cuenta</Label>
              <select
                id="anchor-account"
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
          <div className="space-y-1">
            <Label htmlFor="anchor-date">Día del extracto</Label>
            <Input id="anchor-date" type="date" className="h-11" max={todayLocal()} value={balanceDate} onChange={(e) => setBalanceDate(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="anchor-balance">Saldo al cierre de ese día</Label>
            <MoneyInput id="anchor-balance" value={balance} onChange={setBalance} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="anchor-note">Nota (opcional)</Label>
            <Input id="anchor-note" className="h-11" value={note} onChange={(e) => setNote(e.target.value)} />
          </div>
          {mutation.isError ? (
            <p role="alert" className="text-sm text-destructive">
              {errorMessage(mutation.error)}
            </p>
          ) : null}
          <Button
            type="button"
            className="w-full"
            disabled={balance === null || balanceDate === "" || mutation.isPending}
            onClick={() => mutation.mutate()}
          >
            {balance === null ? "Guardar saldo" : `Guardar saldo de ${formatCOP(balance)}`}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

export default BankAnchorDialog
