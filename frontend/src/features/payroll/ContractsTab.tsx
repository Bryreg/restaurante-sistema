/**
 * Admin → Nómina → Contratos y novedades (auditoría 2026-10-06, e2/e3).
 *
 * - **Contrato** de cada persona: tipo, sueldo fijo o por hora, inicio y
 *   fin, clase de riesgo ARL. Con contrato, la liquidación suma auxilio de
 *   transporte, aportes y provisión de prestaciones (`legal_costs.py`).
 * - **Novedades**: incapacidades, licencias, vacaciones y permisos; se
 *   anulan con motivo, nunca se borran.
 * - **Parámetros legales**: salario mínimo y auxilio de cada año. Vienen
 *   del decreto; el dueño o el contador los confirma.
 *
 * Toda la plata la calcula el servidor; esta pantalla sólo la muestra.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useRef, useState } from "react"

import { newIdempotencyKey } from "@/api/client"
import { listEmployees } from "@/api/employees"
import {
  confirmLegalParams,
  createAbsence,
  createContract,
  getAbsences,
  getContracts,
  getLegalParams,
  voidAbsence,
  type AbsenceKind,
  type AbsenceOut,
  type ContractKind,
  type LegalParamsOut,
  type SalaryType,
} from "@/api/payroll"
import { Cargando } from "@/components/Cargando"
import { DenseTable, DenseTableBar, FormField, FormSection } from "@/components/admin"
import { EmptyState } from "@/components/EmptyState"
import { MoneyInput } from "@/components/MoneyInput"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import { formatBusinessDate } from "@/lib/businessDate"
import { errorMessage } from "@/lib/errors"
import { formatCOP } from "@/lib/money"

import { todayLocal } from "./lib"

const CONTRACT_KIND_LABEL: Record<ContractKind, string> = {
  indefinite: "Término indefinido",
  fixed_term: "Término fijo",
  part_time: "Tiempo parcial",
  apprentice: "Aprendiz SENA",
  services: "Prestación de servicios",
}

const ABSENCE_KIND_LABEL: Record<AbsenceKind, string> = {
  sick_leave: "Incapacidad (enfermedad general)",
  work_accident: "Incapacidad laboral (ARL)",
  maternity: "Licencia de maternidad",
  paternity: "Licencia de paternidad",
  vacation: "Vacaciones",
  paid_leave: "Licencia o permiso remunerado",
  bereavement: "Luto o calamidad",
  unpaid_leave: "Licencia o permiso no remunerado",
  suspension: "Suspensión",
}

function useStoreEmployees(storeId: number) {
  return useQuery({
    queryKey: ["employees", "admin", storeId],
    queryFn: () => listEmployees({ storeId, active: true }),
  })
}

function PersonSelect({
  id,
  storeId,
  value,
  onChange,
}: {
  id: string
  storeId: number
  value: string
  onChange: (v: string) => void
}): React.JSX.Element {
  const employees = useStoreEmployees(storeId)
  return (
    <Select value={value} onValueChange={(v) => onChange(v ?? "")}>
      <SelectTrigger id={id}>
        <SelectValue placeholder="Elegí a quién" />
      </SelectTrigger>
      <SelectContent>
        {(employees.data ?? []).map((e) => (
          <SelectItem key={e.id} value={String(e.id)}>
            {e.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

function invalidateRuns(queryClient: ReturnType<typeof useQueryClient>): void {
  void queryClient.invalidateQueries({ queryKey: ["payroll", "runs"] })
  void queryClient.invalidateQueries({ queryKey: ["expenses", "profit"] })
}

// ---------------------------------------------------------------------------
// Contratos
// ---------------------------------------------------------------------------

function ContractsSection({ storeId }: { storeId: number }): React.JSX.Element {
  const queryClient = useQueryClient()
  const [employeeId, setEmployeeId] = useState("")
  const [kind, setKind] = useState<ContractKind>("indefinite")
  const [salaryType, setSalaryType] = useState<SalaryType>("monthly")
  const [salary, setSalary] = useState<number | null>(null)
  const [startDate, setStartDate] = useState(todayLocal())
  const [endDate, setEndDate] = useState("")
  const [arl, setArl] = useState("1")
  const idemRef = useRef(newIdempotencyKey())

  const query = useQuery({ queryKey: ["payroll", "contracts", storeId], queryFn: () => getContracts(storeId) })
  const mutation = useMutation({
    mutationFn: () =>
      createContract(
        storeId,
        {
          employee_id: Number(employeeId),
          kind,
          salary_type: salaryType,
          monthly_salary_pesos: salaryType === "monthly" ? salary : null,
          start_date: startDate,
          end_date: endDate.trim() === "" ? null : endDate,
          arl_risk_class: Number(arl),
        },
        idemRef.current,
      ),
    onSuccess: () => {
      idemRef.current = newIdempotencyKey()
      setSalary(null)
      void queryClient.invalidateQueries({ queryKey: ["payroll", "contracts", storeId] })
      invalidateRuns(queryClient)
    },
  })
  const canSubmit =
    employeeId !== "" && startDate !== "" && (salaryType === "hourly" || (salary !== null && salary > 0))

  return (
    <FormSection
      title="Contratos"
      governs="Qué contrato tiene cada persona: con eso la liquidación suma auxilio de transporte, aportes y prestaciones."
      reading={
        <>
          Un contrato nuevo <b>no reescribe el anterior</b>: un aumento o un cambio de tipo es una fila nueva desde
          su fecha. Quien no tiene contrato se liquida sólo por horas y su renglón lo dice.
        </>
      }
      doesNotDo="No hace retención en la fuente ni descuenta la salud y pensión del trabajador: es el costo de la sede, para control."
    >
      <FormField label="Persona" help="Sólo aparecen las personas activas de esta sede.">
        {({ fieldId }) => <PersonSelect id={fieldId} storeId={storeId} value={employeeId} onChange={setEmployeeId} />}
      </FormField>
      <FormField label="Tipo de contrato" help="Prestación de servicios no es laboral: no lleva aportes ni prestaciones.">
        {({ fieldId }) => (
          <Select value={kind} onValueChange={(v) => setKind((v ?? "indefinite") as ContractKind)}>
            <SelectTrigger id={fieldId}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(CONTRACT_KIND_LABEL) as ContractKind[]).map((k) => (
                <SelectItem key={k} value={k}>
                  {CONTRACT_KIND_LABEL[k]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </FormField>
      <FormField label="Cómo se paga" help="Sueldo fijo al mes, o por hora trabajada con la tarifa de «Tarifas».">
        {({ fieldId }) => (
          <Select value={salaryType} onValueChange={(v) => setSalaryType((v ?? "monthly") as SalaryType)}>
            <SelectTrigger id={fieldId}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="monthly">Sueldo fijo mensual</SelectItem>
              <SelectItem value="hourly">Por hora trabajada</SelectItem>
            </SelectContent>
          </Select>
        )}
      </FormField>
      {salaryType === "monthly" ? (
        <FormField label="Sueldo mensual" help="Sin auxilio de transporte: el sistema lo suma si corresponde.">
          {({ fieldId }) => <MoneyInput id={fieldId} value={salary} onChange={setSalary} />}
        </FormField>
      ) : null}
      <FormField label="Inicio" help="Desde qué día rige esta versión del contrato.">
        {({ fieldId }) => <Input id={fieldId} type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />}
      </FormField>
      <FormField label="Terminación" help="Vacío si es indefinido o sigue vigente.">
        {({ fieldId }) => <Input id={fieldId} type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} />}
      </FormField>
      <FormField label="Clase de riesgo ARL" help="Cocina y salón suelen ser clase 1.">
        {({ fieldId }) => (
          <Select value={arl} onValueChange={(v) => setArl(v ?? "1")}>
            <SelectTrigger id={fieldId}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {["1", "2", "3", "4", "5"].map((c) => (
                <SelectItem key={c} value={c}>
                  Clase {c}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </FormField>
      <div className="flex items-end">
        <Button type="button" onClick={() => mutation.mutate()} disabled={!canSubmit || mutation.isPending}>
          {mutation.isPending ? "Guardando…" : "Guardar contrato"}
        </Button>
      </div>
      <div className="space-y-3 sm:col-span-2">
        {mutation.isError ? (
          <p role="alert" className="text-sm text-destructive">
            {errorMessage(mutation.error)}
          </p>
        ) : null}
        {query.isLoading ? (
          <Cargando texto="Cargando contratos…" />
        ) : (query.data ?? []).length === 0 ? (
          <EmptyState
            reason="dependency"
            title="Todavía no hay contratos cargados"
            description="Sin contrato, la liquidación paga sólo horas: sin auxilio de transporte, aportes ni prestaciones."
          />
        ) : (
          <DenseTable
            caption="Contratos, cada versión desde su fecha."
            columns={[
              { key: "person", header: "Persona", kind: "name", cell: (c) => c.employee_name },
              { key: "kind", header: "Tipo", cell: (c) => CONTRACT_KIND_LABEL[c.kind] },
              {
                key: "pay",
                header: "Pago",
                kind: "number",
                cell: (c) => (c.salary_type === "monthly" ? `${formatCOP(c.monthly_salary_pesos)} al mes` : "Por hora"),
              },
              {
                key: "dates",
                header: "Vigencia",
                cell: (c) =>
                  `${formatBusinessDate(c.start_date)}${c.end_date ? ` – ${formatBusinessDate(c.end_date)}` : " en adelante"}`,
              },
              { key: "arl", header: "ARL", kind: "number", secondary: true, cell: (c) => `Clase ${c.arl_risk_class}` },
            ]}
            rows={query.data ?? []}
            rowKey={(c) => String(c.id)}
            maxBodyHeightPx={300}
            bar={<DenseTableBar shown={(query.data ?? []).length} total={(query.data ?? []).length} noun="contratos" />}
          />
        )}
      </div>
    </FormSection>
  )
}

// ---------------------------------------------------------------------------
// Novedades
// ---------------------------------------------------------------------------

function VoidAbsenceDialog({
  storeId,
  absence,
  onClose,
}: {
  storeId: number
  absence: AbsenceOut
  onClose: () => void
}): React.JSX.Element {
  const queryClient = useQueryClient()
  const [reason, setReason] = useState("")
  const idemRef = useRef(newIdempotencyKey())
  const mutation = useMutation({
    mutationFn: () => voidAbsence(storeId, absence.id, reason.trim(), idemRef.current),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["payroll", "absences", storeId] })
      invalidateRuns(queryClient)
      onClose()
    },
  })
  return (
    <Dialog open onOpenChange={(open) => (open ? null : onClose())}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Anular novedad</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          {ABSENCE_KIND_LABEL[absence.kind]} de {absence.employee_name}, {formatBusinessDate(absence.date_from)} a{" "}
          {formatBusinessDate(absence.date_to)}. No se borra: queda anulada con el motivo y deja de contar en las
          liquidaciones nuevas.
        </p>
        <label htmlFor="absence-void-reason" className="text-sm font-medium">
          Motivo
        </label>
        <Textarea id="absence-void-reason" value={reason} onChange={(e) => setReason(e.target.value)} />
        {mutation.isError ? (
          <p role="alert" className="text-sm text-destructive">
            {errorMessage(mutation.error)}
          </p>
        ) : null}
        <Button type="button" disabled={reason.trim().length < 5 || mutation.isPending} onClick={() => mutation.mutate()}>
          Anular novedad
        </Button>
      </DialogContent>
    </Dialog>
  )
}

function AbsencesSection({ storeId }: { storeId: number }): React.JSX.Element {
  const queryClient = useQueryClient()
  const [employeeId, setEmployeeId] = useState("")
  const [kind, setKind] = useState<AbsenceKind>("sick_leave")
  const [from, setFrom] = useState(todayLocal())
  const [to, setTo] = useState(todayLocal())
  const [note, setNote] = useState("")
  const [voiding, setVoiding] = useState<AbsenceOut | null>(null)
  const idemRef = useRef(newIdempotencyKey())

  const query = useQuery({ queryKey: ["payroll", "absences", storeId], queryFn: () => getAbsences(storeId) })
  const mutation = useMutation({
    mutationFn: () =>
      createAbsence(
        storeId,
        { employee_id: Number(employeeId), kind, date_from: from, date_to: to, note: note.trim() || null },
        idemRef.current,
      ),
    onSuccess: () => {
      idemRef.current = newIdempotencyKey()
      setNote("")
      void queryClient.invalidateQueries({ queryKey: ["payroll", "absences", storeId] })
      invalidateRuns(queryClient)
    },
  })
  const canSubmit = employeeId !== "" && from !== "" && to !== "" && from <= to

  return (
    <FormSection
      title="Novedades"
      governs="Incapacidades, licencias, vacaciones y permisos: cada una se paga (o se descuenta) como dice la ley."
      reading={
        <>
          Incapacidad general: los dos primeros días los paga la sede y desde el tercero la EPS (la sede los adelanta y
          los <b>recobra</b>). Vacaciones: por días hábiles. Licencia no remunerada y suspensión: no se pagan.
        </>
      }
      doesNotDo="No tramita el recobro ante la EPS ni la ARL: deja anotado cuánto hay que recobrar."
    >
      <FormField label="Persona" help="A quién le pasó.">
        {({ fieldId }) => <PersonSelect id={fieldId} storeId={storeId} value={employeeId} onChange={setEmployeeId} />}
      </FormField>
      <FormField label="Tipo de novedad" help="Cada tipo se paga como dice la ley.">
        {({ fieldId }) => (
          <Select value={kind} onValueChange={(v) => setKind((v ?? "sick_leave") as AbsenceKind)}>
            <SelectTrigger id={fieldId}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(ABSENCE_KIND_LABEL) as AbsenceKind[]).map((k) => (
                <SelectItem key={k} value={k}>
                  {ABSENCE_KIND_LABEL[k]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </FormField>
      <FormField label="Desde" help="Primer día de la novedad.">
        {({ fieldId }) => <Input id={fieldId} type="date" value={from} onChange={(e) => setFrom(e.target.value)} />}
      </FormField>
      <FormField label="Hasta" help="Inclusive.">
        {({ fieldId }) => <Input id={fieldId} type="date" value={to} onChange={(e) => setTo(e.target.value)} />}
      </FormField>
      <FormField label="Nota" help="Número de la incapacidad, quién la expidió, etc.">
        {({ fieldId }) => <Input id={fieldId} value={note} onChange={(e) => setNote(e.target.value)} />}
      </FormField>
      <div className="flex items-end">
        <Button type="button" onClick={() => mutation.mutate()} disabled={!canSubmit || mutation.isPending}>
          {mutation.isPending ? "Guardando…" : "Registrar novedad"}
        </Button>
      </div>
      <div className="space-y-3 sm:col-span-2">
        {mutation.isError ? (
          <p role="alert" className="text-sm text-destructive">
            {errorMessage(mutation.error)}
          </p>
        ) : null}
        {query.isLoading ? (
          <Cargando texto="Cargando novedades…" />
        ) : (query.data ?? []).length === 0 ? (
          <EmptyState reason="all-clear" title="Sin novedades registradas" description="Cuando alguien se incapacite o salga a vacaciones, se anota acá." />
        ) : (
          <DenseTable
            caption="Novedades, las más recientes primero."
            columns={[
              { key: "person", header: "Persona", kind: "name", cell: (a) => a.employee_name },
              { key: "kind", header: "Novedad", cell: (a) => ABSENCE_KIND_LABEL[a.kind] },
              {
                key: "dates",
                header: "Fechas",
                cell: (a) => `${formatBusinessDate(a.date_from)} – ${formatBusinessDate(a.date_to)}`,
              },
              { key: "days", header: "Días", kind: "number", cell: (a) => String(a.days) },
              {
                key: "status",
                header: "Estado",
                cell: (a) =>
                  a.voided_at ? (
                    <Badge variant="outline" title={a.void_reason ?? undefined}>
                      Anulada
                    </Badge>
                  ) : (
                    <Button type="button" variant="ghost" size="sm" onClick={() => setVoiding(a)}>
                      Anular
                    </Button>
                  ),
              },
            ]}
            rows={query.data ?? []}
            rowKey={(a) => String(a.id)}
            maxBodyHeightPx={320}
            bar={<DenseTableBar shown={(query.data ?? []).length} total={(query.data ?? []).length} noun="novedades" />}
          />
        )}
      </div>
      {voiding ? <VoidAbsenceDialog storeId={storeId} absence={voiding} onClose={() => setVoiding(null)} /> : null}
    </FormSection>
  )
}

// ---------------------------------------------------------------------------
// Parámetros legales
// ---------------------------------------------------------------------------

function pct(ppm: number): string {
  return `${(ppm / 10_000).toLocaleString("es-CO", { maximumFractionDigits: 3 })} %`
}

function LegalParamsSection(): React.JSX.Element {
  const queryClient = useQueryClient()
  const query = useQuery({ queryKey: ["payroll", "legal-params"], queryFn: getLegalParams })
  const idemRef = useRef(newIdempotencyKey())
  const mutation = useMutation({
    mutationFn: (row: LegalParamsOut) => {
      const { source: _s, confirmed_by_name: _c, ...data } = row
      return confirmLegalParams(data, idemRef.current)
    },
    onSuccess: () => {
      idemRef.current = newIdempotencyKey()
      void queryClient.invalidateQueries({ queryKey: ["payroll", "legal-params"] })
      invalidateRuns(queryClient)
    },
  })
  return (
    <FormSection
      title="Parámetros legales"
      governs="Salario mínimo, auxilio de transporte y tasas de aportes y prestaciones de cada año."
      reading={
        <>
          Vienen del decreto de cada año y el sistema ya los trae. Confirmarlos deja constancia de que alguien con la
          norma adelante (vos o tu contador) los revisó; hasta entonces cada liquidación lo avisa.
        </>
      }
      doesNotDo="No cambia liquidaciones ya hechas."
    >
      <div className="space-y-3 sm:col-span-2">
        {mutation.isError ? (
          <p role="alert" className="text-sm text-destructive">
            {errorMessage(mutation.error)}
          </p>
        ) : null}
        {query.isLoading ? (
          <Cargando texto="Cargando parámetros…" />
        ) : (
          <DenseTable
            caption="Parámetros legales por vigencia."
            columns={[
              { key: "from", header: "Desde", kind: "name", cell: (p) => formatBusinessDate(p.valid_from) },
              { key: "smmlv", header: "Salario mínimo", kind: "number", cell: (p) => formatCOP(p.smmlv_pesos) },
              { key: "aux", header: "Auxilio de transporte", kind: "number", cell: (p) => formatCOP(p.transport_allowance_pesos) },
              { key: "pension", header: "Pensión", kind: "number", secondary: true, cell: (p) => pct(p.pension_employer_ppm) },
              { key: "caja", header: "Caja", kind: "number", secondary: true, cell: (p) => pct(p.family_fund_ppm) },
              {
                key: "exo",
                header: "Exonerada 114-1",
                secondary: true,
                cell: (p) => (p.exonerated_114_1 ? "Sí" : "No"),
              },
              {
                key: "state",
                header: "Revisado",
                cell: (p) =>
                  p.source === "organizacion" ? (
                    <Badge variant="secondary">{p.confirmed_by_name ?? "Sí"}</Badge>
                  ) : (
                    <Button type="button" variant="outline" size="sm" disabled={mutation.isPending} onClick={() => mutation.mutate(p)}>
                      Confirmar
                    </Button>
                  ),
              },
            ]}
            rows={query.data ?? []}
            rowKey={(p) => p.valid_from}
            maxBodyHeightPx={260}
            bar={<DenseTableBar shown={(query.data ?? []).length} total={(query.data ?? []).length} noun="vigencias" />}
          />
        )}
      </div>
    </FormSection>
  )
}

export function ContractsTab({ storeId }: { storeId: number }): React.JSX.Element {
  return (
    <div className="space-y-6">
      <ContractsSection storeId={storeId} />
      <AbsencesSection storeId={storeId} />
      <LegalParamsSection />
    </div>
  )
}
