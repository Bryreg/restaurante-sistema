/**
 * Admin → Obligaciones y gastos → Recurrentes (c5): las obligaciones que se
 * repiten (mensual, bimestral o cada N meses) y «Armar el mes».
 *
 * Nada se crea solo: «Ver qué se crea» pide la vista previa al servidor
 * (`GET /admin/obligations/month-plan`) y «Armar el mes» la confirma
 * (`POST /admin/obligations/generate-month`). Armarlo dos veces no duplica
 * nada: el servidor es idempotente por recurrente y mes. Los totales vienen
 * del servidor.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useState } from "react"

import { newIdempotencyKey } from "@/api/client"
import {
  createObligationTemplate,
  deactivateObligationTemplate,
  generateMonth,
  getMonthPlan,
  getObligationTemplates,
  type GenerateMonthOut,
  type ObligationCategory,
  type ObligationTemplateOut,
} from "@/api/expenses"
import { DenseTable, DenseTableBar, type DenseColumn } from "@/components/admin"
import { EmptyState } from "@/components/EmptyState"
import { MoneyInput } from "@/components/MoneyInput"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { formatBusinessDate } from "@/lib/businessDate"
import { errorMessage } from "@/lib/errors"
import { formatCOP } from "@/lib/money"

import { intervalLabel, obligationCategoryLabel, OBLIGATION_CATEGORY_LABEL, todayLocal } from "./lib"

type Frequency = "1" | "2" | "n"

/** «YYYY-MM» del mes de hoy en Bogotá (el valor de un `<input type="month">`). */
function thisMonth(): string {
  return todayLocal().slice(0, 7)
}

function CreateTemplateDialog({ storeId, onCreated }: { storeId: number; onCreated: () => void }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [description, setDescription] = useState("")
  const [category, setCategory] = useState<ObligationCategory>("rent")
  const [amount, setAmount] = useState<number | null>(null)
  const [frequency, setFrequency] = useState<Frequency>("1")
  const [everyN, setEveryN] = useState("3")
  const [dueDay, setDueDay] = useState("5")
  const [startMonth, setStartMonth] = useState(thisMonth())

  const interval = frequency === "n" ? Number(everyN) : Number(frequency)
  const day = Number(dueDay)
  const canSubmit =
    description.trim() !== "" &&
    amount !== null &&
    amount > 0 &&
    Number.isInteger(interval) &&
    interval >= 1 &&
    interval <= 12 &&
    Number.isInteger(day) &&
    day >= 1 &&
    day <= 31 &&
    /^\d{4}-\d{2}$/.test(startMonth)

  const mutation = useMutation({
    mutationFn: () =>
      createObligationTemplate(
        storeId,
        {
          description: description.trim(),
          category,
          amount: amount as number,
          interval_months: interval,
          due_day: day,
          start_month: `${startMonth}-01`,
        },
        newIdempotencyKey(),
      ),
    onSuccess: () => {
      setOpen(false)
      setDescription("")
      setAmount(null)
      onCreated()
    },
  })

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button className="h-9 gap-2" />}>Nueva recurrente</DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Nueva obligación recurrente</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="template-description">Descripción</Label>
            <Input
              id="template-description"
              className="h-11"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
            />
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="template-category">Categoría</Label>
              <Select value={category} onValueChange={(value) => setCategory(value as ObligationCategory)}>
                <SelectTrigger id="template-category" className="w-full">
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
              <Label htmlFor="template-amount">Monto</Label>
              <MoneyInput id="template-amount" value={amount} onChange={setAmount} />
            </div>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="template-frequency">Frecuencia</Label>
              <Select value={frequency} onValueChange={(value) => setFrequency(value as Frequency)}>
                <SelectTrigger id="template-frequency" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="1">Mensual</SelectItem>
                  <SelectItem value="2">Bimestral</SelectItem>
                  <SelectItem value="n">Cada N meses</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {frequency === "n" ? (
              <div className="space-y-1">
                <Label htmlFor="template-every-n">Cada cuántos meses</Label>
                <Input
                  id="template-every-n"
                  type="number"
                  min={1}
                  max={12}
                  className="h-11"
                  value={everyN}
                  onChange={(event) => setEveryN(event.target.value)}
                />
              </div>
            ) : null}
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="template-due-day">Día de vencimiento</Label>
              <Input
                id="template-due-day"
                type="number"
                min={1}
                max={31}
                className="h-11"
                value={dueDay}
                onChange={(event) => setDueDay(event.target.value)}
              />
              <p className="text-xs text-muted-foreground">En un mes más corto, el último día del mes.</p>
            </div>
            <div className="space-y-1">
              <Label htmlFor="template-start">Primer mes</Label>
              <Input
                id="template-start"
                type="month"
                className="h-11"
                value={startMonth}
                onChange={(event) => setStartMonth(event.target.value)}
              />
            </div>
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
            Guardar recurrente
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function DeactivateTemplateDialog({
  template,
  onDone,
}: {
  template: ObligationTemplateOut
  onDone: () => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState("")
  const mutation = useMutation({
    mutationFn: () => deactivateObligationTemplate(template.id, reason.trim(), newIdempotencyKey()),
    onSuccess: () => {
      setOpen(false)
      setReason("")
      onDone()
    },
  })
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button type="button" variant="outline" size="sm" />}>Dejar de repetir</DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Dejar de repetir «{template.description}»</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Las obligaciones ya armadas siguen con su plata y sus abonos: se deben igual. Sólo deja de armarse en los
            meses que vienen.
          </p>
          <div className="space-y-1">
            <Label htmlFor={`deactivate-reason-${template.id}`}>Motivo</Label>
            <Input
              id={`deactivate-reason-${template.id}`}
              className="h-11"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
            />
          </div>
          {mutation.isError ? (
            <p role="alert" className="text-sm text-destructive">
              {errorMessage(mutation.error)}
            </p>
          ) : null}
          <Button
            type="button"
            variant="destructive"
            className="w-full"
            disabled={reason.trim() === "" || mutation.isPending}
            onClick={() => mutation.mutate()}
          >
            Confirmar
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function BuildMonth({ storeId, onBuilt }: { storeId: number; onBuilt: () => void }): React.JSX.Element {
  const [month, setMonth] = useState(thisMonth())
  const [asked, setAsked] = useState<string | null>(null)
  const [result, setResult] = useState<GenerateMonthOut | null>(null)
  const [year, monthNumber] = (asked ?? "").split("-").map(Number)

  const plan = useQuery({
    queryKey: ["expenses", "obligations", "month-plan", storeId, asked],
    queryFn: () => getMonthPlan(storeId, year as number, monthNumber as number),
    enabled: asked !== null,
  })

  const mutation = useMutation({
    mutationFn: () => generateMonth(storeId, year as number, monthNumber as number, newIdempotencyKey()),
    onSuccess: (out) => {
      setResult(out)
      void plan.refetch()
      onBuilt()
    },
  })

  const data = plan.data
  return (
    <section aria-labelledby="build-month-title" className="space-y-3 rounded-lg border p-4">
      <h3 id="build-month-title" className="font-medium">
        Armar el mes
      </h3>
      <div className="flex flex-wrap items-end gap-2">
        <div className="space-y-1">
          <Label htmlFor="build-month">Mes</Label>
          <Input
            id="build-month"
            type="month"
            className="h-9 w-44"
            value={month}
            onChange={(event) => {
              setMonth(event.target.value)
              setAsked(null)
              setResult(null)
            }}
          />
        </div>
        <Button
          type="button"
          variant="outline"
          disabled={!/^\d{4}-\d{2}$/.test(month)}
          onClick={() => {
            setResult(null)
            setAsked(month)
          }}
        >
          Ver qué se crea
        </Button>
      </div>
      {plan.isError ? (
        <p role="alert" className="text-sm text-destructive">
          {errorMessage(plan.error)}
        </p>
      ) : null}
      {data ? (
        data.active_templates === 0 ? (
          <p className="text-sm text-muted-foreground">
            No hay obligaciones recurrentes: creá la primera con «Nueva recurrente».
          </p>
        ) : (
          <div className="space-y-2">
            {data.to_create.length === 0 ? (
              <p className="text-sm">El mes ya está armado: todas las recurrentes que vencen tienen su obligación.</p>
            ) : (
              <>
                <p className="text-sm">
                  Se van a crear {data.to_create.length} obligaciones por <b>{formatCOP(data.to_create_total)}</b>:
                </p>
                <ul className="space-y-1 text-sm">
                  {data.to_create.map((line) => (
                    <li key={line.template_id}>
                      {formatBusinessDate(line.due_date)} · {line.description} · {formatCOP(line.amount)}
                    </li>
                  ))}
                </ul>
                <Button type="button" disabled={mutation.isPending} onClick={() => mutation.mutate()}>
                  Armar el mes
                </Button>
              </>
            )}
            {data.already_generated.length > 0 ? (
              <p className="text-xs text-muted-foreground">
                Ya estaban: {data.already_generated.map((l) => `${l.description}${l.cancelled ? " (cancelada)" : ""}`).join(", ")}.
              </p>
            ) : null}
          </div>
        )
      ) : null}
      {mutation.isError ? (
        <p role="alert" className="text-sm text-destructive">
          {errorMessage(mutation.error)}
        </p>
      ) : null}
      {result ? (
        <p role="status" className="text-sm">
          Listo: {result.created.length === 1 ? "se creó 1 obligación" : `se crearon ${result.created.length} obligaciones`}.
          Están en la Agenda y en Obligaciones.
        </p>
      ) : null}
    </section>
  )
}

export function RecurringTab({ storeId }: { storeId: number }): React.JSX.Element {
  const queryClient = useQueryClient()
  const query = useQuery({
    queryKey: ["expenses", "obligation-templates", storeId],
    queryFn: () => getObligationTemplates(storeId),
  })

  function invalidate() {
    void queryClient.invalidateQueries({ queryKey: ["expenses", "obligation-templates"] })
    void queryClient.invalidateQueries({ queryKey: ["expenses", "obligations"] })
  }

  if (query.isError) {
    return (
      <EmptyState
        role="alert"
        title="No se pudieron cargar las obligaciones recurrentes"
        description={errorMessage(query.error)}
        action={{ label: "Reintentar", onClick: () => void query.refetch() }}
      />
    )
  }

  const rows = query.data ?? []
  const columns: readonly DenseColumn<ObligationTemplateOut>[] = [
    {
      key: "description",
      header: "Descripción",
      kind: "name",
      widthPx: 240,
      cell: (t) => <span className="block truncate">{t.description}</span>,
      cellTitle: (t) => `${t.description} · ${obligationCategoryLabel(t.category)}`,
    },
    { key: "frequency", header: "Frecuencia", cell: (t) => intervalLabel(t.interval_months) },
    { key: "due_day", header: "Vence", cell: (t) => `día ${t.due_day}` },
    { key: "amount", header: "Monto", kind: "number", cell: (t) => formatCOP(t.amount) },
    { key: "start", header: "Desde", secondary: true, cell: (t) => formatBusinessDate(t.start_month) },
    {
      key: "action",
      header: "",
      kind: "actions",
      cell: (t) => <DeactivateTemplateDialog template={t} onDone={invalidate} />,
    },
  ]

  return (
    <div className="space-y-4">
      <BuildMonth storeId={storeId} onBuilt={invalidate} />
      <DenseTable
        caption="Obligaciones recurrentes"
        columns={columns}
        rows={rows}
        rowKey={(t) => String(t.id)}
        bar={
          <DenseTableBar shown={rows.length} total={rows.length} noun="recurrentes">
            <CreateTemplateDialog storeId={storeId} onCreated={invalidate} />
          </DenseTableBar>
        }
        note="Cambiar o dejar de repetir una recurrente no toca las obligaciones ya armadas."
        empty={
          query.isLoading ? undefined : (
            <EmptyState
              title="No hay obligaciones recurrentes"
              description="El arriendo, los servicios, lo que se paga todos los meses: cargalo una vez con «Nueva recurrente» y armá cada mes con un botón."
            />
          )
        }
      />
    </div>
  )
}

export default RecurringTab
