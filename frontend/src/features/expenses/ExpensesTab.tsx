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
import { DenseTable, DenseTableBar, type DenseColumn } from "@/components/admin"
import { EmptyState } from "@/components/EmptyState"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { MoneyInput } from "@/components/MoneyInput"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { formatBusinessDate } from "@/lib/businessDate"
import { errorMessage } from "@/lib/errors"
import { formatCOP } from "@/lib/money"

import { daysAgoLocal, EXPENSE_CATEGORY_LABEL, expenseCategoryLabel, todayLocal } from "./lib"

function CreateExpenseDialog({
  storeId,
  onCreated,
}: {
  storeId: number
  onCreated: () => void
}): React.JSX.Element {
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
              <Input
                id="expense-date"
                type="date"
                className="h-11"
                value={businessDate}
                onChange={(event) => setBusinessDate(event.target.value)}
              />
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
            <Input
              id="expense-description"
              className="h-11"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
            />
          </div>
          {mutation.isError ? (
            <p role="alert" className="text-sm text-destructive">
              {errorMessage(mutation.error)}
            </p>
          ) : null}
          <Button
            type="button"
            className="w-full"
            disabled={!canSubmit || mutation.isPending}
            onClick={() => mutation.mutate()}
          >
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

  // Sin total del período acá, y no por el auditor sino por la regla que el
  // auditor defiende (AGENTS.md § «Una sola matemática, en el backend»): el
  // frontend no deriva cifras de plata. Además el que había sumaba SÓLO las
  // filas traídas por el filtro de fechas y se rotulaba «Total del período»,
  // que es una promesa más grande de la que podía cumplir. Cuando
  // `GET /admin/expenses` publique el total, se pinta ese.
  const rows = query.data ?? []

  const columns: readonly DenseColumn<(typeof rows)[number]>[] = [
    {
      key: "date",
      header: "Fecha",
      kind: "secondary",
      cell: (e) => formatBusinessDate(e.business_date),
    },
    // La palabra del negocio, nunca el enum: la categoría es tipada y se
    // escribe como la lee el dueño.
    { key: "category", header: "Categoría", cell: (e) => expenseCategoryLabel(e.category) },
    {
      key: "description",
      header: "Descripción",
      kind: "name",
      widthPx: 320,
      cell: (e) => <span className="block truncate">{e.description || "—"}</span>,
      cellTitle: (e) => e.description || undefined,
    },
    { key: "amount", header: "Monto", kind: "number", cell: (e) => formatCOP(e.amount) },
  ]

  if (query.isError) {
    return (
      <EmptyState
        role="alert"
        title="No se pudieron cargar los gastos"
        description={errorMessage(query.error)}
        action={{ label: "Reintentar", onClick: () => void query.refetch() }}
      />
    )
  }

  return (
    <DenseTable
      caption="Gastos del período"
      columns={columns}
      rows={rows}
      rowKey={(e) => String(e.id)}
      bar={
        <DenseTableBar
          shown={rows.length}
          total={rows.length}
          noun="gastos en el período"
          hidden={query.isLoading ? "contando…" : undefined}
        >
          <DateRangeFilter
            idPrefix="expenses"
            from={from}
            to={to}
            onChange={(r) => {
              setFrom(r.from)
              setTo(r.to)
            }}
          />
          <CreateExpenseDialog
            storeId={storeId}
            onCreated={() => void queryClient.invalidateQueries({ queryKey: ["expenses", "list"] })}
          />
        </DenseTableBar>
      }
      note="Un gasto es plata que ya salió. Lo que todavía no salió pero vence, va en «Obligaciones»: son dos cosas distintas y por eso viven en pestañas distintas."
      empty={
        query.isLoading ? undefined : (
          <EmptyState
            title="No hay gastos registrados en este período"
            description="Probá otro rango de fechas, o registrá el primero con «Registrar gasto»."
          />
        )
      }
    />
  )
}
