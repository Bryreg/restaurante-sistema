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
import { EmptyState } from "@/components/EmptyState"
import { MoneyInput } from "@/components/MoneyInput"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
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
    <section className="space-y-3 rounded-lg border p-4">
      <div>
        <h2 className="text-sm font-semibold">Tarifa por hora</h2>
        <p className="text-xs text-muted-foreground">
          Lleva fecha de vigencia: una liquidación vieja se recalcula con la tarifa que regía ese mes, nunca con la de
          hoy. Sin tarifa cargada, la liquidación y la utilidad del período responden «sin datos» con el motivo.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-4 sm:items-end">
        <div className="space-y-1.5">
          <Label htmlFor="wage-employee">Persona</Label>
          <Select value={employeeId} onValueChange={(v) => setEmployeeId(v ?? "")}>
            <SelectTrigger id="wage-employee">
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
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="wage-amount">Pesos por hora</Label>
          <MoneyInput id="wage-amount" value={wage} onChange={setWage} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="wage-valid-from">Rige desde</Label>
          <Input id="wage-valid-from" type="date" value={validFrom} onChange={(e) => setValidFrom(e.target.value)} />
        </div>
        <Button type="button" onClick={() => mutation.mutate()} disabled={!canSubmit || mutation.isPending}>
          {mutation.isPending ? "Guardando…" : "Guardar tarifa"}
        </Button>
      </div>

      {mutation.isError ? (
        <p role="alert" className="text-sm text-destructive">
          {errorMessage(mutation.error)}
        </p>
      ) : null}

      {query.isLoading ? (
        <p className="text-sm text-muted-foreground">Cargando tarifas…</p>
      ) : query.isError ? (
        <EmptyState
          role="alert"
          title="No se pudieron cargar las tarifas"
          description={errorMessage(query.error)}
          action={{ label: "Reintentar", onClick: () => void query.refetch() }}
        />
      ) : (query.data ?? []).length === 0 ? (
        <EmptyState title="Todavía no hay tarifas cargadas" description="Sin tarifa no se puede liquidar la nómina." />
      ) : (
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Persona</TableHead>
                <TableHead>Pesos por hora</TableHead>
                <TableHead>Rige desde</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(query.data ?? []).map((w) => (
                <TableRow key={w.id}>
                  <TableCell>{w.employee_name}</TableCell>
                  <TableCell className="tabular-nums">{formatCOP(w.hourly_wage_pesos)}</TableCell>
                  <TableCell>{formatBusinessDate(w.valid_from)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </section>
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
    <section className="space-y-3 rounded-lg border p-4">
      <div>
        <h2 className="text-sm font-semibold">Festivos</h2>
        <p className="text-xs text-muted-foreground">
          Sin festivos cargados, la columna «festivas» de las horas queda en cero y nadie se entera. El recargo que se
          les aplica sale de la tabla vigente, no de acá.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3 sm:items-end">
        <div className="space-y-1.5">
          <Label htmlFor="holiday-date">Fecha</Label>
          <Input id="holiday-date" type="date" value={holidayDate} onChange={(e) => setHolidayDate(e.target.value)} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="holiday-name">Nombre</Label>
          <Input
            id="holiday-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Día de la Independencia"
          />
        </div>
        <Button
          type="button"
          onClick={() => mutation.mutate()}
          disabled={name.trim() === "" || holidayDate.trim() === "" || mutation.isPending}
        >
          {mutation.isPending ? "Guardando…" : "Agregar festivo"}
        </Button>
      </div>

      {mutation.isError ? (
        <p role="alert" className="text-sm text-destructive">
          {errorMessage(mutation.error)}
        </p>
      ) : null}

      {query.isLoading ? (
        <p className="text-sm text-muted-foreground">Cargando festivos…</p>
      ) : query.isError ? (
        <EmptyState
          role="alert"
          title="No se pudieron cargar los festivos"
          description={errorMessage(query.error)}
          action={{ label: "Reintentar", onClick: () => void query.refetch() }}
        />
      ) : (query.data ?? []).length === 0 ? (
        <EmptyState title="Todavía no hay festivos cargados" />
      ) : (
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Fecha</TableHead>
                <TableHead>Nombre</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(query.data ?? []).map((h) => (
                <TableRow key={h.id}>
                  <TableCell>{formatBusinessDate(h.holiday_date)}</TableCell>
                  <TableCell>{h.name}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </section>
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
    <section className="space-y-3 rounded-lg border p-4">
      <div>
        <h2 className="text-sm font-semibold">Área por persona</h2>
        <p className="text-xs text-muted-foreground">
          Sólo la usa el reparto de propinas «por área», uno de los tres métodos. Si la sede reparte por horas o en
          partes iguales, esta sección se puede dejar vacía.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3 sm:items-end">
        <div className="space-y-1.5">
          <Label htmlFor="area-employee">Persona</Label>
          <Select value={employeeId} onValueChange={(v) => setEmployeeId(v ?? "")}>
            <SelectTrigger id="area-employee">
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
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="area-name">Área</Label>
          <Input id="area-name" value={area} onChange={(e) => setAreaText(e.target.value)} placeholder="Salón" />
        </div>
        <Button
          type="button"
          onClick={() => mutation.mutate()}
          disabled={employeeId === "" || area.trim() === "" || mutation.isPending}
        >
          {mutation.isPending ? "Guardando…" : "Asignar área"}
        </Button>
      </div>

      {mutation.isError ? (
        <p role="alert" className="text-sm text-destructive">
          {errorMessage(mutation.error)}
        </p>
      ) : null}

      {query.isLoading ? (
        <p className="text-sm text-muted-foreground">Cargando áreas…</p>
      ) : query.isError ? (
        <EmptyState
          role="alert"
          title="No se pudieron cargar las áreas"
          description={errorMessage(query.error)}
          action={{ label: "Reintentar", onClick: () => void query.refetch() }}
        />
      ) : (query.data ?? []).length === 0 ? (
        <EmptyState title="Todavía no hay áreas asignadas" />
      ) : (
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Persona</TableHead>
                <TableHead>Área</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(query.data ?? []).map((a) => (
                <TableRow key={a.employee_id}>
                  <TableCell>{a.employee_name}</TableCell>
                  <TableCell>{a.area}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </section>
  )
}

export function WagesCalendarTab({ storeId }: { storeId: number }): React.JSX.Element {
  return (
    <div className="space-y-4">
      <WagesSection storeId={storeId} />
      <HolidaysSection storeId={storeId} />
      <AreasSection storeId={storeId} />
    </div>
  )
}

export default WagesCalendarTab
