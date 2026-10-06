/**
 * Admin → Obligaciones y gastos → INC y nómina (c5): convertir en
 * obligaciones con fecha las dos salidas grandes que el sistema ya calcula.
 *
 * - **INC del bimestre** (`GET /admin/obligations/consumption-tax`): lo
 *   cobrado sale del informe del contador, no de una cuenta hecha acá. La
 *   fecha es el día que la sede eligió del mes siguiente al bimestre (por
 *   defecto el 8, comienzo de la segunda semana; la DIAN fija el día por el
 *   NIT). Se puede agendar con la cifra del contador.
 * - **Nómina** (`GET /admin/obligations/payroll-runs`): cada liquidación
 *   guardada, por su costo para la sede. Sólo con la función Nómina.
 *
 * Ninguna de las dos suma a los costos fijos: la nómina ya entra a la
 * utilidad por su lado y el INC no es gasto (la venta neta se mide sin él).
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useState } from "react"

import { newIdempotencyKey } from "@/api/client"
import {
  getConsumptionTax,
  getObligationSettings,
  getPayrollRunCandidates,
  putObligationSettings,
  scheduleConsumptionTax,
  schedulePayroll,
  type PayrollRunCandidate,
} from "@/api/expenses"
import { useSession } from "@/app/session"
import { DenseTable, DenseTableBar, type DenseColumn } from "@/components/admin"
import { EmptyState } from "@/components/EmptyState"
import { MoneyInput } from "@/components/MoneyInput"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { formatBusinessDate } from "@/lib/businessDate"
import { errorMessage } from "@/lib/errors"
import { formatCOP } from "@/lib/money"

const BIMESTERS = [
  { value: "1", label: "Enero – febrero" },
  { value: "2", label: "Marzo – abril" },
  { value: "3", label: "Mayo – junio" },
  { value: "4", label: "Julio – agosto" },
  { value: "5", label: "Septiembre – octubre" },
  { value: "6", label: "Noviembre – diciembre" },
] as const

function DueDaySetting({ storeId, onSaved }: { storeId: number; onSaved: () => void }): React.JSX.Element {
  const settings = useQuery({
    queryKey: ["expenses", "obligation-settings", storeId],
    queryFn: () => getObligationSettings(storeId),
  })
  const [draft, setDraft] = useState<string | null>(null)
  const mutation = useMutation({
    mutationFn: (value: number | null) =>
      putObligationSettings(storeId, { consumption_tax_due_day: value }, newIdempotencyKey()),
    onSuccess: () => {
      setDraft(null)
      void settings.refetch()
      onSaved()
    },
  })
  const data = settings.data
  const shown = draft ?? (data?.consumption_tax_due_day != null ? String(data.consumption_tax_due_day) : "")
  const parsed = shown.trim() === "" ? null : Number(shown)
  const valid = parsed === null || (Number.isInteger(parsed) && parsed >= 1 && parsed <= 28)

  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-end gap-2">
        <div className="space-y-1">
          <Label htmlFor="inc-due-day">Día del mes en que se paga el INC</Label>
          <Input
            id="inc-due-day"
            type="number"
            min={1}
            max={28}
            className="h-9 w-28"
            placeholder={data ? String(data.default_consumption_tax_due_day) : undefined}
            value={shown}
            onChange={(event) => setDraft(event.target.value)}
          />
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={!valid || draft === null || mutation.isPending}
          onClick={() => mutation.mutate(parsed)}
        >
          Guardar día
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        La DIAN fija el día según el último dígito del NIT. Vacío = el {data?.default_consumption_tax_due_day ?? 8} (la
        segunda semana del mes siguiente al bimestre); escribí el de tu calendario tributario.
      </p>
      {mutation.isError ? (
        <p role="alert" className="text-sm text-destructive">
          {errorMessage(mutation.error)}
        </p>
      ) : null}
    </div>
  )
}

function ConsumptionTaxSection({ storeId }: { storeId: number }): React.JSX.Element {
  const queryClient = useQueryClient()
  const [period, setPeriod] = useState<{ year: number; bimester: number } | null>(null)
  const [manualAmount, setManualAmount] = useState<number | null>(null)

  const query = useQuery({
    queryKey: ["expenses", "consumption-tax", storeId, period?.year, period?.bimester],
    queryFn: () => getConsumptionTax(storeId, period?.year, period?.bimester),
  })
  const mutation = useMutation({
    mutationFn: () => {
      const data = query.data!
      return scheduleConsumptionTax(
        storeId,
        { year: data.year, bimester: data.bimester, amount: manualAmount },
        newIdempotencyKey(),
      )
    },
    onSuccess: () => {
      setManualAmount(null)
      void query.refetch()
      void queryClient.invalidateQueries({ queryKey: ["expenses", "obligations"] })
    },
  })

  const data = query.data
  const year = data?.year ?? new Date().getFullYear()
  const years = [year - 1, year, year + 1].map(String)

  return (
    <section aria-labelledby="inc-title" className="space-y-3 rounded-lg border p-4">
      <h3 id="inc-title" className="font-medium">
        INC del bimestre
      </h3>
      <div className="flex flex-wrap items-end gap-2">
        <div className="space-y-1">
          <Label htmlFor="inc-bimester">Bimestre</Label>
          <Select
            value={data ? String(data.bimester) : undefined}
            onValueChange={(value) => setPeriod({ year, bimester: Number(value) })}
          >
            <SelectTrigger id="inc-bimester" className="h-9 w-52">
              <SelectValue placeholder="Bimestre" />
            </SelectTrigger>
            <SelectContent>
              {BIMESTERS.map((b) => (
                <SelectItem key={b.value} value={b.value}>
                  {b.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="inc-year">Año</Label>
          <Select
            value={String(year)}
            onValueChange={(value) => setPeriod({ year: Number(value), bimester: data?.bimester ?? 1 })}
          >
            <SelectTrigger id="inc-year" className="h-9 w-28">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {years.map((y) => (
                <SelectItem key={y} value={y}>
                  {y}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
      {query.isError ? (
        <p role="alert" className="text-sm text-destructive">
          {errorMessage(query.error)}
        </p>
      ) : null}
      {data ? (
        <div className="space-y-2 text-sm">
          <p>
            <b>{data.label}</b> · INC cobrado:{" "}
            <b>{data.tax_amount === null ? "sin dato" : formatCOP(data.tax_amount)}</b>
            {data.base !== null ? <span className="text-muted-foreground"> (base {formatCOP(data.base)})</span> : null}
          </p>
          {data.reason ? <p className="text-muted-foreground">{data.reason}</p> : null}
          <p>
            Se agenda para el <b>{formatBusinessDate(data.due_date)}</b>
            {data.due_day_is_default ? " (día por defecto: confirmalo con tu calendario DIAN)" : ""}.
          </p>
          {data.scheduled ? (
            <p role="status">
              Ya está agendado: {data.scheduled.description} · {formatCOP(data.scheduled.amount ?? null)} · vence el{" "}
              {formatBusinessDate(data.scheduled.due_date)}.
            </p>
          ) : !data.closed ? (
            <p className="text-muted-foreground">
              El bimestre todavía no cerró: lo que lleva cobrado no es lo que se va a declarar.
            </p>
          ) : (
            <div className="flex flex-wrap items-end gap-2">
              <div className="space-y-1">
                <Label htmlFor="inc-amount">Cifra del contador (opcional)</Label>
                <MoneyInput id="inc-amount" value={manualAmount} onChange={setManualAmount} />
              </div>
              <Button
                type="button"
                disabled={mutation.isPending || (data.tax_amount === null && manualAmount === null)}
                onClick={() => mutation.mutate()}
              >
                Agendar INC
              </Button>
            </div>
          )}
          {mutation.isError ? (
            <p role="alert" className="text-sm text-destructive">
              {errorMessage(mutation.error)}
            </p>
          ) : null}
        </div>
      ) : null}
      <DueDaySetting storeId={storeId} onSaved={() => void query.refetch()} />
    </section>
  )
}

function SchedulePayrollButton({ storeId, run, onDone }: { storeId: number; run: PayrollRunCandidate; onDone: () => void }): React.JSX.Element {
  const mutation = useMutation({
    mutationFn: () => schedulePayroll(storeId, { payroll_run_id: run.payroll_run_id }, newIdempotencyKey()),
    onSuccess: onDone,
  })
  return (
    <span className="inline-flex items-center gap-2">
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={run.amount === null || mutation.isPending}
        onClick={() => mutation.mutate()}
      >
        Agendar nómina
      </Button>
      {mutation.isError ? (
        <span role="alert" className="text-xs text-destructive">
          {errorMessage(mutation.error)}
        </span>
      ) : null}
    </span>
  )
}

function PayrollSection({ storeId }: { storeId: number }): React.JSX.Element {
  const queryClient = useQueryClient()
  const query = useQuery({
    queryKey: ["expenses", "payroll-runs", storeId],
    queryFn: () => getPayrollRunCandidates(storeId),
  })
  function invalidate() {
    void query.refetch()
    void queryClient.invalidateQueries({ queryKey: ["expenses", "obligations"] })
  }
  if (query.isError) {
    return (
      <EmptyState
        role="alert"
        title="No se pudieron cargar las liquidaciones"
        description={errorMessage(query.error)}
        action={{ label: "Reintentar", onClick: () => void query.refetch() }}
      />
    )
  }
  const rows = query.data ?? []
  const columns: readonly DenseColumn<PayrollRunCandidate>[] = [
    {
      key: "period",
      header: "Período",
      kind: "name",
      cell: (r) => `${formatBusinessDate(r.date_from)} – ${formatBusinessDate(r.date_to)}`,
    },
    {
      key: "amount",
      header: "Costo",
      kind: "number",
      cell: (r) => formatCOP(r.amount),
      cellTitle: (r) =>
        r.amount_source === "employer_total"
          ? "Lo que la nómina le cuesta a la sede (pagado + aportes + prestaciones)"
          : r.amount_source === "total"
            ? "Lo pagado (la liquidación no tiene el costo para la sede)"
            : "La liquidación no tiene total",
    },
    {
      key: "action",
      header: "",
      kind: "actions",
      cell: (r) =>
        r.scheduled_obligation_id !== null ? (
          <span className="text-sm text-muted-foreground">Agendada</span>
        ) : (
          <SchedulePayrollButton storeId={storeId} run={r} onDone={invalidate} />
        ),
    },
  ]
  return (
    <DenseTable
      caption="Liquidaciones de nómina"
      columns={columns}
      rows={rows}
      rowKey={(r) => String(r.payroll_run_id)}
      bar={<DenseTableBar shown={rows.length} total={rows.length} noun="liquidaciones" />}
      note="Se agenda para el último día del período liquidado. No suma a los costos fijos: la nómina ya está en la utilidad."
      empty={
        query.isLoading ? undefined : (
          <EmptyState
            title="No hay liquidaciones guardadas"
            description="Liquidá la nómina en Equipo → Nómina y volvé para agendarla."
          />
        )
      }
    />
  )
}

export function TaxPayrollTab({ storeId }: { storeId: number }): React.JSX.Element {
  const { hasFeature } = useSession()
  return (
    <div className="space-y-4">
      <ConsumptionTaxSection storeId={storeId} />
      {hasFeature("payroll") ? <PayrollSection storeId={storeId} /> : null}
    </div>
  )
}

export default TaxPayrollTab
