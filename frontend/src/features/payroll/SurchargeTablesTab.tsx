/**
 * Admin → Nómina y propinas → Tablas de recargos (T3,
 * `GET`/`POST /admin/payroll/surcharge-tables`): siempre con `valid_from`,
 * nunca quemadas en código (§7) — una tabla vieja tiene que poder recalcular
 * un período viejo con las tablas que regían ese mes.
 *
 * Campos verificados por lectura directa de `app/payroll/schemas.py::
 * SurchargeTableIn/Out` (no adivinados desde el contrato mínimo, que sólo
 * exige "con `valid_from`"): `night_start_hour`/`night_end_hour` delimitan
 * la franja nocturna, `night_surcharge_bp` es su recargo; `sunday_holiday_
 * surcharge_bp` es UN SOLO recargo para dominical y festivo (Ley 2466 de
 * 2025); `overtime_surcharge_bp` la hora extra; `weekly_ordinary_hours` la
 * jornada semanal ordinaria (42 h desde jul-2026, Ley 2101 de 2021).
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useState } from "react"

import { createSurchargeTable, getSurchargeTables } from "@/api/payroll"
import { EmptyState } from "@/components/EmptyState"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { formatBusinessDate } from "@/lib/businessDate"
import { errorMessage } from "@/lib/errors"

import { formatBasisPoints } from "@/features/inventory/lib"

function PercentInput({ id, label, value, onChange }: { id: string; label: string; value: string; onChange: (v: string) => void }): React.JSX.Element {
  return (
    <div className="space-y-1">
      <Label htmlFor={id}>{label} (%)</Label>
      <Input id={id} type="text" inputMode="decimal" className="h-11" value={value} onChange={(event) => onChange(event.target.value)} placeholder="35" />
    </div>
  )
}

/** "35" (o "35,5") tecleado por la persona → puntos básicos enteros ("3500"). Ayuda de tecleo, no autoridad: el servidor valida de nuevo. */
function pctToBp(text: string): number | null {
  const normalized = text.trim().replace(",", ".")
  if (normalized === "") return null
  const value = Number(normalized)
  if (Number.isNaN(value)) return null
  return Math.round(value * 100)
}

function HourInput({ id, label, value, onChange }: { id: string; label: string; value: string; onChange: (v: string) => void }): React.JSX.Element {
  return (
    <div className="space-y-1">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        type="number"
        inputMode="numeric"
        min={0}
        max={23}
        className="h-11"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  )
}

function CreateSurchargeTableDialog({ storeId, onCreated }: { storeId: number; onCreated: () => void }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [validFrom, setValidFrom] = useState("")
  const [nightStart, setNightStart] = useState("19")
  const [nightEnd, setNightEnd] = useState("6")
  const [night, setNight] = useState("")
  const [sundayHoliday, setSundayHoliday] = useState("")
  const [overtime, setOvertime] = useState("")
  const [weeklyHours, setWeeklyHours] = useState("46")

  const mutation = useMutation({
    mutationFn: () =>
      createSurchargeTable(storeId, {
        valid_from: validFrom,
        night_start_hour: Number(nightStart),
        night_end_hour: Number(nightEnd),
        night_surcharge_bp: pctToBp(night) as number,
        sunday_holiday_surcharge_bp: pctToBp(sundayHoliday) as number,
        overtime_surcharge_bp: pctToBp(overtime) as number,
        weekly_ordinary_hours: Number(weeklyHours),
      }),
    onSuccess: () => {
      setOpen(false)
      onCreated()
    },
  })

  const canSubmit =
    validFrom.trim() !== "" &&
    nightStart.trim() !== "" &&
    nightEnd.trim() !== "" &&
    weeklyHours.trim() !== "" &&
    pctToBp(night) !== null &&
    pctToBp(sundayHoliday) !== null &&
    pctToBp(overtime) !== null

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button className="h-11 gap-2" />}>Nueva tabla de recargos</DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Nueva tabla de recargos</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="surcharge-valid-from">Vigente desde</Label>
            <Input id="surcharge-valid-from" type="date" className="h-11" value={validFrom} onChange={(event) => setValidFrom(event.target.value)} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <HourInput id="surcharge-night-start" label="Nocturno desde (hora)" value={nightStart} onChange={setNightStart} />
            <HourInput id="surcharge-night-end" label="Nocturno hasta (hora)" value={nightEnd} onChange={setNightEnd} />
            <PercentInput id="surcharge-night" label="Recargo nocturno" value={night} onChange={setNight} />
            <PercentInput id="surcharge-sunday-holiday" label="Recargo dominical y festivo" value={sundayHoliday} onChange={setSundayHoliday} />
            <PercentInput id="surcharge-overtime" label="Hora extra" value={overtime} onChange={setOvertime} />
            <div className="space-y-1">
              <Label htmlFor="surcharge-weekly-hours">Jornada semanal ordinaria (h)</Label>
              <Input id="surcharge-weekly-hours" type="number" inputMode="numeric" min={1} className="h-11" value={weeklyHours} onChange={(event) => setWeeklyHours(event.target.value)} />
            </div>
          </div>
          {mutation.isError ? (
            <p role="alert" className="text-sm text-destructive">
              {errorMessage(mutation.error)}
            </p>
          ) : null}
          <Button type="button" className="w-full" disabled={!canSubmit || mutation.isPending} onClick={() => mutation.mutate()}>
            Guardar tabla
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

export function SurchargeTablesTab({ storeId }: { storeId: number }): React.JSX.Element {
  const queryClient = useQueryClient()
  const query = useQuery({
    queryKey: ["payroll", "surcharge-tables", storeId],
    queryFn: () => getSurchargeTables(storeId),
  })

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <CreateSurchargeTableDialog storeId={storeId} onCreated={() => void queryClient.invalidateQueries({ queryKey: ["payroll", "surcharge-tables"] })} />
      </div>

      {query.isLoading ? (
        <p className="text-sm text-muted-foreground">Cargando tablas de recargos…</p>
      ) : query.isError ? (
        <EmptyState role="alert" title="No se pudieron cargar las tablas de recargos" description={errorMessage(query.error)} action={{ label: "Reintentar", onClick: () => void query.refetch() }} />
      ) : (query.data ?? []).length === 0 ? (
        <EmptyState title="Todavía no hay ninguna tabla de recargos cargada" />
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Vigente desde</TableHead>
                <TableHead>Franja nocturna</TableHead>
                <TableHead>Recargo nocturno</TableHead>
                <TableHead>Recargo dominical y festivo</TableHead>
                <TableHead>Hora extra</TableHead>
                <TableHead>Jornada semanal</TableHead>
                <TableHead>Revisada</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(query.data ?? []).map((table) => (
                <TableRow key={table.id}>
                  <TableCell>{formatBusinessDate(table.valid_from)}</TableCell>
                  <TableCell className="tabular-nums">
                    {table.night_start_hour}:00 – {table.night_end_hour}:00
                  </TableCell>
                  <TableCell className="tabular-nums">{formatBasisPoints(table.night_surcharge_bp)}</TableCell>
                  <TableCell className="tabular-nums">{formatBasisPoints(table.sunday_holiday_surcharge_bp)}</TableCell>
                  <TableCell className="tabular-nums">{formatBasisPoints(table.overtime_surcharge_bp)}</TableCell>
                  <TableCell className="tabular-nums">{table.weekly_ordinary_hours} h</TableCell>
                  <TableCell>
                    {table.confirmed_by_person ? (
                      <Badge variant="secondary">{table.confirmed_by_name ?? "Sí"}</Badge>
                    ) : (
                      <Badge variant="outline">Sin revisar</Badge>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {(query.data ?? []).some((t) => t.confirmed_by_person === false) ? (
            <p role="status" className="mt-3 text-sm text-muted-foreground">
              <strong>Hay vigencias sin revisar.</strong> Las cargó la instalación del sistema con los valores de la
              ley que estaban a mano; son editables desde acá, pero hasta que alguien con la norma adelante las
              confirme, las liquidaciones que las usen descansan sobre un supuesto. Para confirmarlas, cargá la
              vigencia de nuevo con los valores correctos: queda a tu nombre.
            </p>
          ) : null}
        </div>
      )}
    </div>
  )
}

export default SurchargeTablesTab
