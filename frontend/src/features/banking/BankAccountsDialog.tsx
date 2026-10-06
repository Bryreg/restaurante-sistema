/**
 * Las cuentas del banco de la sede (`GET`/`POST`/`PATCH /admin/bank/accounts`):
 * la principal más las que el dueño agregue (Bancolombia, Nequi…), cada una
 * con su 4×1000 exento o no. Nada se borra: una cuenta se desactiva y su
 * historia sigue en el libro.
 */
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { useRef, useState } from "react"

import { createBankAccount, updateBankAccount, type BankAccountOut, type BankAccountPatchIn } from "@/api/banking"
import { newIdempotencyKey } from "@/api/client"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { errorMessage } from "@/lib/errors"

function FilaDeCuenta({ storeId, account }: { storeId: number; account: BankAccountOut }): React.JSX.Element {
  const keyRef = useRef(newIdempotencyKey())
  const queryClient = useQueryClient()
  const mutation = useMutation({
    mutationFn: (patch: BankAccountPatchIn) => updateBankAccount(storeId, account.id as number, patch, keyRef.current),
    onSuccess: () => {
      keyRef.current = newIdempotencyKey()
      void queryClient.invalidateQueries({ queryKey: ["banking"] })
    },
  })
  const id = account.id ?? "principal"
  return (
    <li className="space-y-2 rounded-lg border p-3 text-sm">
      <p className="font-medium">
        {account.name}
        {account.is_default ? <span className="ml-2 text-xs text-muted-foreground">principal</span> : null}
        {!account.active ? <span className="ml-2 text-xs text-muted-foreground">desactivada</span> : null}
      </p>
      {account.id === null ? (
        <p className="text-xs text-muted-foreground">
          Todavía no existe: nace cuando teclees el primer saldo o movimiento, o cuando crees tu primera cuenta.
        </p>
      ) : (
        <div className="flex flex-wrap gap-x-4 gap-y-2">
          <label htmlFor={`gmf-${id}`} className="inline-flex items-center gap-2">
            <input
              id={`gmf-${id}`}
              type="checkbox"
              className="size-4"
              checked={account.gmf_exempt}
              disabled={mutation.isPending}
              onChange={(e) => mutation.mutate({ gmf_exempt: e.target.checked })}
            />
            Exenta del 4×1000
          </label>
          <label htmlFor={`transfers-${id}`} className="inline-flex items-center gap-2">
            <input
              id={`transfers-${id}`}
              type="checkbox"
              className="size-4"
              checked={account.receives_transfers}
              disabled={mutation.isPending}
              onChange={(e) => mutation.mutate({ receives_transfers: e.target.checked })}
            />
            Recibe las transferencias de clientes
          </label>
          {!account.is_default && account.active ? (
            <Button type="button" variant="outline" size="sm" disabled={mutation.isPending} onClick={() => mutation.mutate({ is_default: true })}>
              Hacer principal
            </Button>
          ) : null}
          {!account.is_default ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={mutation.isPending}
              onClick={() => mutation.mutate({ active: !account.active })}
            >
              {account.active ? "Desactivar" : "Activar"}
            </Button>
          ) : null}
        </div>
      )}
      {mutation.isError ? (
        <p role="alert" className="text-xs text-destructive">
          {errorMessage(mutation.error)}
        </p>
      ) : null}
    </li>
  )
}

export function BankAccountsDialog({ storeId, accounts }: { storeId: number; accounts: BankAccountOut[] }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState("")
  const [gmfExempt, setGmfExempt] = useState(false)
  const keyRef = useRef(newIdempotencyKey())
  const queryClient = useQueryClient()
  const create = useMutation({
    mutationFn: () => createBankAccount(storeId, { name: name.trim(), gmf_exempt: gmfExempt }, keyRef.current),
    onSuccess: () => {
      keyRef.current = newIdempotencyKey()
      void queryClient.invalidateQueries({ queryKey: ["banking"] })
      setName("")
      setGmfExempt(false)
    },
  })

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button variant="outline" className="h-11" />}>Cuentas</DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Cuentas del banco</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <ul className="space-y-2">
            {accounts.map((a) => (
              <FilaDeCuenta key={a.id ?? "principal"} storeId={storeId} account={a} />
            ))}
          </ul>
          <form
            className="space-y-2 rounded-lg border p-3"
            onSubmit={(e) => {
              e.preventDefault()
              if (name.trim() !== "") create.mutate()
            }}
          >
            <Label htmlFor="new-account-name">Agregar una cuenta</Label>
            <Input
              id="new-account-name"
              className="h-11"
              placeholder="Bancolombia, Nequi…"
              maxLength={80}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <label htmlFor="new-account-gmf" className="inline-flex items-center gap-2 text-sm">
              <input
                id="new-account-gmf"
                type="checkbox"
                className="size-4"
                checked={gmfExempt}
                onChange={(e) => setGmfExempt(e.target.checked)}
              />
              Exenta del 4×1000
            </label>
            {create.isError ? (
              <p role="alert" className="text-sm text-destructive">
                {errorMessage(create.error)}
              </p>
            ) : null}
            <Button type="submit" className="w-full" disabled={name.trim() === "" || create.isPending}>
              Agregar cuenta
            </Button>
          </form>
        </div>
      </DialogContent>
    </Dialog>
  )
}

export default BankAccountsDialog
