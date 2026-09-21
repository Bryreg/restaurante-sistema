/**
 * Admin → Nómina y propinas → Tarifas y calendario.
 *
 * Las TRES PUERTAS DE ENTRADA de la nómina, que la fase 3 construyó y probó
 * en el backend y que ninguna pantalla consumía (hallazgo A-1 del cierre):
 *
 * - **Tarifa por hora** (`GET`/`POST /admin/payroll/wages`). Sin ella,
 *   `POST /admin/payroll/runs` liquida con `total_amount: null` y motivo, y
 *   —lo más caro— arrastra a `GET /admin/profit`, que es el objetivo textual
 *   de la fase: con `payroll` encendida, `compute_profit` corta con
 *   `available: false` si a alguien le falta tarifa.
 * - **Festivos** (`GET`/`POST /admin/payroll/holidays`). Sin ellos la columna
 *   «festivas» de las horas es siempre cero, en silencio.
 * - **Área por persona** (`GET`/`POST /admin/payroll/areas`). Sin ellas el
 *   reparto de propinas `by_area` —uno de los tres métodos de D-3— no tiene
 *   con qué agrupar.
 *
 * La tarifa lleva `valid_from` porque una nómina vieja tiene que poder
 * recalcularse con lo que regía ese mes, igual que las tablas de recargos.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useRef, useState } from "react"

import { newIdempotencyKey } from "@/api/client"
import { listEmployees } from "@/api/employees"
import {
  createHoliday,
  createWage,
  getAreas,
  getHolidays,
  getWages,
  setArea,
} from "@/api/payroll"
import { DenseTable, DenseTableBar, FormField, FormSection, ScopeDestinations } from "@/components/admin"
import { EmptyState } from "@/components/EmptyState"
import { MoneyInput } from "@/components/MoneyInput"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { formatBusinessDate } from "@/lib/businessDate"
import { errorMessage } from "@/lib/errors"
import { formatCOP } from "@/lib/money"

import { todayLocal } from "./lib"

function useStoreEmployees(storeId: number) {
  return useQuery({
    queryKey: ["employees", "admin", storeId],
    queryFn: () => listEmployees({ storeId, active: true }),
  })
}

// ---------------------------------------------------------------------------
// Tarifa por hora
// ---------------------------------------------------------------------------

function WagesSection({ storeId }: { storeId: number }): React.JSX.Element {
  const queryClient = useQueryClient()
  const employees = useStoreEmployees(storeId)
  const [employeeId, setEmployeeId] = useState<string>("")
  const [wage, setWage] = useState<number | null>(null)
  const [validFrom, setValidFrom] = useState(todayLocal())
  const idemRef = useRef(newIdempotencyKey())

  const query = useQuery({
    queryKey: ["payroll", "wages", storeId],
    queryFn: () => getWages(storeId),
  })

  const mutation = useMutation({
    mutationFn: () =>
      createWage(
        storeId,
        { employee_id: Number(employeeId), hourly_wage_pesos: wage ?? 0, valid_from: validFrom },
        idemRef.current,
      ),
    onSuccess: () => {
      idemRef.current = newIdempotencyKey()
      setWage(null)
      void queryClient.invalidateQueries({ queryKey: ["payroll", "wages", storeId] })
      // La liquidación y la utilidad dependen de esto.
      void queryClient.invalidateQueries({ queryKey: ["payroll", "runs"] })
      void queryClient.invalidateQueries({ queryKey: ["expenses", "profit"] })
    },
  })

  const canSubmit = employeeId !== "" && wage !== null && wage > 0 && validFrom.trim() !== ""

  return (
    <FormSection
      title="Tarifa por hora"
      governs="Con cuánto se paga cada hora de cada persona, desde la fecha que digas."
      reading={
        <>
          Una tarifa nueva <b>no reescribe el pasado</b>: cada liquidación se recalcula con la tarifa que regía ese
          mes. Si alguien no tiene tarifa vigente, su renglón dice «sin datos» con el motivo, y{" "}
          <b>la utilidad del período completo</b> responde lo mismo.
        </>
      }
      doesNotDo="Cargar una tarifa no paga nada ni genera una liquidación: sólo deja lista la cifra con la que se va a liquidar."
    >
      <FormField
        label="Persona"
        help="A quién se le aplica. Sólo aparecen las personas activas de esta sede."
      >
        {({ fieldId }) => (
          <Select value={employeeId} onValueChange={(v) => setEmployeeId(v ?? "")}>
            <SelectTrigger id={fieldId}>
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
        )}
      </FormField>
      <FormField
        label="Pesos por hora"
        help="La hora ordinaria. Los recargos se calculan sobre esto, con los porcentajes de la tabla vigente."
        scope={{ affects: [{ screen: "Nómina › Liquidaciones", verb: "Alimenta" }] }}
      >
        {({ fieldId }) => <MoneyInput id={fieldId} value={wage} onChange={setWage} />}
      </FormField>
      <FormField
        label="Rige desde"
        help="Desde qué día vale. Lo liquidado antes de esta fecha sigue usando la tarifa anterior."
      >
        {({ fieldId }) => (
          <Input id={fieldId} type="date" value={validFrom} onChange={(e) => setValidFrom(e.target.value)} />
        )}
      </FormField>
      <div className="flex items-end">
        <Button type="button" onClick={() => mutation.mutate()} disabled={!canSubmit || mutation.isPending}>
          {mutation.isPending ? "Guardando…" : "Guardar tarifa"}
        </Button>
      </div>

      {/* La lista y el error de guardado no son campos: ocupan la fila
          entera de la rejilla en vez de colarse como una tercera columna. */}
      <div className="space-y-3 sm:col-span-2">
      {mutation.isError ? (
        <p role="alert" className="text-sm text-destructive">
          {errorMessage(mutation.error)}
        </p>
      ) : null}

      {query.isLoading ? (
        <p className="text-sm text-muted-foreground">Cargando tarifas…</p>
      ) : query.isError ? (
        <EmptyState
          reason="error"
          title="No se pudieron cargar las tarifas"
          description={errorMessage(query.error)}
          action={{ label: "Reintentar", onClick: () => void query.refetch() }}
        />
      ) : (query.data ?? []).length === 0 ? (
        <EmptyState
          reason="dependency"
          title="Todavía no hay tarifas cargadas"
          description="Sin tarifa no se puede liquidar la nómina."
        />
      ) : (
        <DenseTable
          caption="Tarifas por hora cargadas, con la fecha desde la que rige cada una."
          columns={[
            { key: "person", header: "Persona", kind: "name", cell: (w) => w.employee_name },
            { key: "wage", header: "Pesos por hora", kind: "number", cell: (w) => formatCOP(w.hourly_wage_pesos) },
            { key: "from", header: "Rige desde", cell: (w) => formatBusinessDate(w.valid_from) },
          ]}
          rows={query.data ?? []}
          rowKey={(w) => String(w.id)}
          maxBodyHeightPx={300}
          bar={<DenseTableBar shown={(query.data ?? []).length} total={(query.data ?? []).length} noun="tarifas vigentes" />}
          legend={[
            {
              term: "Una persona, varias filas",
              meaning: "cada fila es una vigencia. La vieja no se borra: es la que recalcula los meses viejos.",
            },
          ]}
        />
      )}
      </div>
    </FormSection>
  )
}

// ---------------------------------------------------------------------------
// Festivos
// ---------------------------------------------------------------------------

function HolidaysSection({ storeId }: { storeId: number }): React.JSX.Element {
  const queryClient = useQueryClient()
  const [holidayDate, setHolidayDate] = useState(todayLocal())
  const [name, setName] = useState("")
  const idemRef = useRef(newIdempotencyKey())

  const query = useQuery({
    queryKey: ["payroll", "holidays", storeId],
    queryFn: () => getHolidays(storeId),
  })

  const mutation = useMutation({
    mutationFn: () => createHoliday(storeId, { holiday_date: holidayDate, name: name.trim() }, idemRef.current),
    onSuccess: () => {
      idemRef.current = newIdempotencyKey()
      setName("")
      void queryClient.invalidateQueries({ queryKey: ["payroll", "holidays", storeId] })
      void queryClient.invalidateQueries({ queryKey: ["payroll", "hours"] })
    },
  })

  return (
    <FormSection
      title="Festivos"
      governs="Qué días cuentan como festivo para la jornada de esta sede."
      reading={
        <>
          Cada día cargado acá hace que las horas de ese día se cuenten como <b>festivas</b> en «Horas». El{" "}
          <b>porcentaje</b> que se les aplica no sale de acá: sale de la tabla de recargos vigente ese día.
        </>
      }
      doesNotDo="Cargar un festivo no recalcula una liquidación ya hecha, y no le avisa a nadie del salón."
    >
      <FormField label="Fecha" help="El día exacto. Si falta, esas horas se cuentan como ordinarias y nadie se entera.">
        {({ fieldId }) => (
          <Input id={fieldId} type="date" value={holidayDate} onChange={(e) => setHolidayDate(e.target.value)} />
        )}
      </FormField>
      <FormField
        label="Nombre"
        help="Para reconocerlo en la lista. No cambia ningún cálculo."
        scope={{ affects: [{ screen: "Nómina › Horas", verb: "Cambia" }] }}
      >
        {({ fieldId }) => (
          <Input
            id={fieldId}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Día de la Independencia"
          />
        )}
      </FormField>
      <div className="flex items-end">
        <Button
          type="button"
          onClick={() => mutation.mutate()}
          disabled={name.trim() === "" || holidayDate.trim() === "" || mutation.isPending}
        >
          {mutation.isPending ? "Guardando…" : "Agregar festivo"}
        </Button>
      </div>

      {/* La lista y el error de guardado no son campos: ocupan la fila
          entera de la rejilla en vez de colarse como una tercera columna. */}
      <div className="space-y-3 sm:col-span-2">
      {mutation.isError ? (
        <p role="alert" className="text-sm text-destructive">
          {errorMessage(mutation.error)}
        </p>
      ) : null}

      {query.isLoading ? (
        <p className="text-sm text-muted-foreground">Cargando festivos…</p>
      ) : query.isError ? (
        <EmptyState
          reason="error"
          title="No se pudieron cargar los festivos"
          description={errorMessage(query.error)}
          action={{ label: "Reintentar", onClick: () => void query.refetch() }}
        />
      ) : (query.data ?? []).length === 0 ? (
        <EmptyState
          reason="dependency"
          title="Todavía no hay festivos cargados"
          description="Sin festivos, la columna «festivas» de las horas queda en cero y nadie se entera."
        />
      ) : (
        <DenseTable
          caption="Festivos cargados para esta sede."
          columns={[
            { key: "date", header: "Fecha", kind: "name", cell: (h) => formatBusinessDate(h.holiday_date) },
            { key: "name", header: "Nombre", cell: (h) => h.name },
          ]}
          rows={query.data ?? []}
          rowKey={(h) => String(h.id)}
          maxBodyHeightPx={300}
          bar={<DenseTableBar shown={(query.data ?? []).length} total={(query.data ?? []).length} noun="festivos cargados" />}
        />
      )}
      </div>
    </FormSection>
  )
}

// ---------------------------------------------------------------------------
// Área por persona
// ---------------------------------------------------------------------------

function AreasSection({ storeId }: { storeId: number }): React.JSX.Element {
  const queryClient = useQueryClient()
  const employees = useStoreEmployees(storeId)
  const [employeeId, setEmployeeId] = useState<string>("")
  const [area, setAreaText] = useState("")
  const idemRef = useRef(newIdempotencyKey())

  const query = useQuery({
    queryKey: ["payroll", "areas", storeId],
    queryFn: () => getAreas(storeId),
  })

  const mutation = useMutation({
    mutationFn: () => setArea(storeId, { employee_id: Number(employeeId), area: area.trim() }, idemRef.current),
    onSuccess: () => {
      idemRef.current = newIdempotencyKey()
      setAreaText("")
      void queryClient.invalidateQueries({ queryKey: ["payroll", "areas", storeId] })
      void queryClient.invalidateQueries({ queryKey: ["payroll", "tips"] })
    },
  })

  return (
    <FormSection
      title="Área por persona"
      governs="En qué área trabaja cada persona, para el reparto de propinas «por área»."
      reading={
        <>
          Estas áreas sólo las lee <b>uno de los tres métodos</b> de reparto. Si esta sede reparte por horas o en
          partes iguales, dejar esto vacío no rompe nada.
        </>
      }
      doesNotDo="Asignar un área no reparte propina ni cambia un reparto ya confirmado: sólo cambia cómo se agrupa la próxima propuesta."
    >
      <FormField label="Persona" help="Sólo aparecen las personas activas de esta sede.">
        {({ fieldId }) => (
          <Select value={employeeId} onValueChange={(v) => setEmployeeId(v ?? "")}>
            <SelectTrigger id={fieldId}>
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
        )}
      </FormField>
      <FormField
        label="Área"
        help="El texto agrupa: dos personas con el área escrita igual reparten juntas."
        scope={{ flag: "pos.tips", affects: [{ screen: "Nómina › Propinas", verb: "Agrupa en" }] }}
      >
        {({ fieldId }) => (
          <Input id={fieldId} value={area} onChange={(e) => setAreaText(e.target.value)} placeholder="Salón" />
        )}
      </FormField>
      <div className="flex items-end">
        <Button
          type="button"
          onClick={() => mutation.mutate()}
          disabled={employeeId === "" || area.trim() === "" || mutation.isPending}
        >
          {mutation.isPending ? "Guardando…" : "Asignar área"}
        </Button>
      </div>

      {/* La lista y el error de guardado no son campos: ocupan la fila
          entera de la rejilla en vez de colarse como una tercera columna. */}
      <div className="space-y-3 sm:col-span-2">
      {mutation.isError ? (
        <p role="alert" className="text-sm text-destructive">
          {errorMessage(mutation.error)}
        </p>
      ) : null}

      {query.isLoading ? (
        <p className="text-sm text-muted-foreground">Cargando áreas…</p>
      ) : query.isError ? (
        <EmptyState
          reason="error"
          title="No se pudieron cargar las áreas"
          description={errorMessage(query.error)}
          action={{ label: "Reintentar", onClick: () => void query.refetch() }}
        />
      ) : (query.data ?? []).length === 0 ? (
        <EmptyState
          reason="dependency"
          title="Todavía no hay áreas asignadas"
          description="Sólo hacen falta si esta sede reparte la propina «por área»."
        />
      ) : (
        <DenseTable
          caption="Área asignada a cada persona de esta sede."
          columns={[
            { key: "person", header: "Persona", kind: "name", cell: (a) => a.employee_name },
            { key: "area", header: "Área", cell: (a) => a.area },
          ]}
          rows={query.data ?? []}
          rowKey={(a) => String(a.employee_id)}
          maxBodyHeightPx={300}
          bar={<DenseTableBar shown={(query.data ?? []).length} total={(query.data ?? []).length} noun="personas con área" />}
        />
      )}
      </div>
    </FormSection>
  )
}

export function WagesCalendarTab({ storeId }: { storeId: number }): React.JSX.Element {
  return (
    <div className="space-y-4">
      <WagesSection storeId={storeId} />
      <HolidaysSection storeId={storeId} />
      <AreasSection storeId={storeId} />
      {/* § 10, el reverso: los chips contestan «este campo a dónde va»; esto
          contesta «esta pestaña a dónde llega». */}
      <ScopeDestinations
        destinations={[
          {
            screen: "Nómina › Liquidaciones",
            what: "La tarifa por hora de cada persona. Sin ella, su renglón dice «sin datos».",
            to: "/admin/nomina?tab=liquidaciones",
          },
          {
            screen: "Nómina › Horas",
            what: "Los festivos: son los que hacen que esas horas se cuenten como festivas.",
            to: "/admin/nomina?tab=horas",
          },
          {
            screen: "Nómina › Propinas",
            what: "Las áreas, cuando la sede reparte «por área».",
            to: "/admin/nomina?tab=propinas",
          },
          {
            screen: "Gastos › Utilidad",
            what: "Con «Nómina» encendida, la utilidad del período no se calcula si a alguien le falta tarifa.",
            to: "/admin/gastos",
          },
        ]}
      />
    </div>
  )
}

export default WagesCalendarTab
