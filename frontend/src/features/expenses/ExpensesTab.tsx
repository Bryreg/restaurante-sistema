/**
 * Admin → Obligaciones y gastos → Gastos (T2, `GET`/`POST /admin/expenses`):
 * plata que **no** pasa por el cajón (una transferencia de arriendo, por
 * ejemplo) — spec.md § T2. Un gasto que SÍ sale del cajón entra por
 * `shifts.hooks.register_*_expense` (territorio de `app/shifts/`, ya
 * existía antes de esta fase) y no tiene pantalla acá.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useState } from "react"

import { createExpense, getExpenses, type ExpenseCategory } from "@/api/expenses"
import { DateRangeFilter } from "@/components/DateRangeFilter"
import { EmptyState } from "@/components/EmptyState"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { MoneyInput } from "@/components/MoneyInput"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { formatBusinessDate } from "@/lib/businessDate"
import { errorMessage } from "@/lib/errors"
import { formatCOP } from "@/lib/money"

import { daysAgoLocal, EXPENSE_CATEGORY_LABEL, expenseCategoryLabel, todayLocal } from "./lib"

function CreateExpenseDialog({ storeId, onCreated }: { storeId: number; onCreated: () => void }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [businessDate, setBusinessDate] = useState(todayLocal())
  const [category, setCategory] = useState<ExpenseCategory>("other")
  const [description, setDescription] = useState("")
  const [amount, setAmount] = useState<number | null>(null)

  const mutation = useMutation({
    mutationFn: () =>
      createExpense(storeId, {
        business_date: businessDate,
        category,
        description: description.trim(),
        amount: amount as number,
      }),
    onSuccess: () => {
      setDescription("")
      setAmount(null)
      setOpen(false)
      onCreated()
    },
  })

  const canSubmit = description.trim() !== "" && amount !== null && amount > 0

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button className="h-11 gap-2" />}>Registrar gasto</DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Registrar gasto</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="expense-date">Fecha de negocio</Label>
              <Input id="expense-date" type="date" className="h-11" value={businessDate} onChange={(event) => setBusinessDate(event.target.value)} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="expense-amount">Monto</Label>
              <MoneyInput id="expense-amount" value={amount} onChange={setAmount} />
            </div>
          </div>
          <div className="space-y-1">
            <Label htmlFor="expense-category">Categoría</Label>
            <Select value={category} onValueChange={(value) => setCategory(value as ExpenseCategory)}>
              <SelectTrigger id="expense-category" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(Object.keys(EXPENSE_CATEGORY_LABEL) as ExpenseCategory[]).map((key) => (
                  <SelectItem key={key} value={key}>
                    {EXPENSE_CATEGORY_LABEL[key]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="expense-description">Descripción</Label>
            <Input id="expense-description" className="h-11" value={description} onChange={(event) => setDescription(event.target.value)} />
          </div>
          {mutation.isError ? (
            <p role="alert" className="text-sm text-destructive">
              {errorMessage(mutation.error)}
            </p>
          ) : null}
          <Button type="button" className="w-full" disabled={!canSubmit || mutation.isPending} onClick={() => mutation.mutate()}>
            Guardar gasto
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

export function ExpensesTab({ storeId }: { storeId: number }): React.JSX.Element {
  const [from, setFrom] = useState(daysAgoLocal(30))
  const [to, setTo] = useState(todayLocal())
  const queryClient = useQueryClient()

  const query = useQuery({
    queryKey: ["expenses", "list", storeId, from, to],
    queryFn: () => getExpenses({ storeId, from, to }),
  })

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <DateRangeFilter idPrefix="expenses" from={from} to={to} onChange={(r) => { setFrom(r.from); setTo(r.to) }} />
        <CreateExpenseDialog storeId={storeId} onCreated={() => void queryClient.invalidateQueries({ queryKey: ["expenses", "list"] })} />
      </div>

      {query.isLoading ? (
        <p className="text-sm text-muted-foreground">Cargando gastos…</p>
      ) : query.isError ? (
        <EmptyState role="alert" title="No se pudieron cargar los gastos" description={errorMessage(query.error)} action={{ label: "Reintentar", onClick: () => void query.refetch() }} />
      ) : (query.data ?? []).length === 0 ? (
        <EmptyState title="No hay gastos registrados en este período" />
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Fecha</TableHead>
                <TableHead>Categoría</TableHead>
                <TableHead>Descripción</TableHead>
                <TableHead>Monto</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(query.data ?? []).map((expense) => (
                <TableRow key={expense.id}>
                  <TableCell>{formatBusinessDate(expense.business_date)}</TableCell>
                  <TableCell>{expenseCategoryLabel(expense.category)}</TableCell>
                  <TableCell>{expense.description ?? "—"}</TableCell>
                  <TableCell className="tabular-nums font-medium">{formatCOP(expense.amount ?? null)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  )
}

export default ExpensesTab
