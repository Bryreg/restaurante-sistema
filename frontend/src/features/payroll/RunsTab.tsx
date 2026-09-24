/**
 * Admin → Nómina y propinas → Liquidaciones (T3,
 * `GET`/`POST /admin/payroll/runs`): liquidación del período. La respuesta
 * nombra qué tabla(s) vigente(s) usó — esta pantalla lo muestra siempre,
 * nunca lo asume (spec.md § T3, contrato de API mínimo: "mostralo en
 * pantalla"). Campos verificados por lectura directa de `app/payroll/
 * schemas.py::PayrollRunOut` (`tables_used`/`lines`, no `surcharge_table_
 * used`/`rows` como asumía la primera versión de este archivo).
 *
 * **Hallazgo A-1 del cierre, corregido acá**: el detalle se pintaba con la
 * fila del LISTADO, y `GET /admin/payroll/runs` devuelve `PayrollRunSummaryOut`,
 * que no trae `lines` ni `tables_used`. Resultado: toda liquidación vieja
 * afirmaba «esta liquidación no informó qué tabla de recargos usó» cuando el
 * backend sí las informa. Una pantalla que dice algo falso es peor que una
 * pantalla que falta. Ahora el detalle se pide a `GET /admin/payroll/runs/{id}`,
 * y sólo cuando alguien lo despliega.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useState } from "react"

import {
  createPayrollRun,
  getPayrollRun,
  getPayrollRuns,
  type PayrollRunComparison,
  type PayrollRunLineOut,
} from "@/api/payroll"
import { Cargando } from "@/components/Cargando"
import { DenseTable, DenseTableBar, GroupLabel, type DenseColumn } from "@/components/admin"
import { DateRangeFilter } from "@/components/DateRangeFilter"
import { EmptyState } from "@/components/EmptyState"
import { SinDato } from "@/components/SinDato"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { formatBusinessDate } from "@/lib/businessDate"
import { errorMessage } from "@/lib/errors"
import { formatPct } from "@/lib/format"
import { formatCOP } from "@/lib/money"
import { formatDelta, formatRangoCorto } from "@/features/reports/lib"

import { formatBasisPoints } from "@/features/inventory/lib"

import { Explicacion } from "./Explicacion"
import { daysAgoLocal, runsHeadline, todayLocal } from "./lib"

const RUN_LINE_COLUMNS: readonly DenseColumn<PayrollRunLineOut>[] = [
  { key: "person", header: "Persona", kind: "name", cell: (l) => l.employee_name ?? `#${l.employee_id}` },
  { key: "base", header: "Base", kind: "number", cell: (l) => formatCOP(l.base_pay) },
  // Los dos recargos, detrás de «Más columnas» (regla 3): a la vista quedan
  // la base, la hora extra y el total de cada persona.
  { key: "night", header: "Recargo nocturno", kind: "number", secondary: true, cell: (l) => formatCOP(l.night_surcharge) },
  {
    key: "sunday",
    header: "Recargo dominical/festivo",
    kind: "number",
    secondary: true,
    cell: (l) => formatCOP(l.sunday_holiday_surcharge),
  },
  { key: "overtime", header: "Hora extra", kind: "number", cell: (l) => formatCOP(l.overtime_pay) },
  {
    // `null` NO es `$ 0`: el motivo que da el servidor va al `title` para que
    // la fila no crezca (§ 5 y § 8).
    key: "total",
    header: "Total",
    kind: "number",
    cell: (l) => (l.total === null ? <SinDato motivo={l.pay_reason} /> : formatCOP(l.total)),
    cellTitle: (l) => (l.total === null ? (l.pay_reason ?? undefined) : undefined),
  },
]

/**
 * La liquidación en contexto (informe de visualización #14): qué parte de la
 * venta del mismo período se lleva, y cómo quedó contra la liquidación
 * anterior. Las dos cifras las calcula el backend (`payroll_pct_of_sales_bp`,
 * `delta_bp`); sin dato, su motivo.
 */
function RunContext({ run }: { run: PayrollRunComparison }): React.JSX.Element {
  const pct = run.payroll_pct_of_sales_bp ?? null
  const delta = formatDelta(run.delta_bp)
  const anterior =
    run.previous_date_from && run.previous_date_to ? formatRangoCorto(run.previous_date_from, run.previous_date_to) : null
  return (
    <dl className="mt-2 grid grid-cols-1 gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
      <div className="min-w-0">
        <dt className="text-xs text-muted-foreground">De la venta del período</dt>
        <dd data-testid="payroll-pct">
          {pct === null ? (
            <SinDato motivo={run.payroll_pct_reason ?? null} />
          ) : (
            <>
              <span className="font-semibold">{formatPct(pct)}</span>
              {run.net_sales !== null && run.net_sales !== undefined ? (
                <span className="text-muted-foreground"> de {formatCOP(run.net_sales)} vendidos</span>
              ) : null}
            </>
          )}
        </dd>
      </div>
      <div className="min-w-0">
        <dt className="text-xs text-muted-foreground">Contra la liquidación anterior</dt>
        <dd data-testid="payroll-delta">
          {delta === null ? (
            <SinDato motivo={run.previous_reason ?? null} />
          ) : (
            <>
              <span className="font-semibold">{delta}</span>
              <span className="text-muted-foreground">
                {" "}
                · antes {formatCOP(run.previous_total ?? null)}
                {anterior ? ` (${anterior})` : ""}
              </span>
            </>
          )}
        </dd>
      </div>
    </dl>
  )
}

function RunDetail({ runId }: { runId: number }): React.JSX.Element {
  // El detalle vive en su propia ruta y se pide sólo al desplegarlo: el
  // listado no lo trae, y asumir que sí era la mentira que corrigió A-1.
  const query = useQuery({
    queryKey: ["payroll", "run", runId],
    queryFn: () => getPayrollRun(runId),
  })

  if (query.isLoading) return <Cargando texto="Cargando el detalle…" />
  if (query.isError) {
    return (
      <EmptyState
        reason="error"
        title="No se pudo cargar el detalle de la liquidación"
        description={errorMessage(query.error)}
        action={{ label: "Reintentar", onClick: () => void query.refetch() }}
      />
    )
  }

  const run = query.data
  const tables = run?.tables_used ?? []
  const lines = run?.lines ?? []
  return (
    <div className="space-y-3">
      {tables.some((t) => t.confirmed_by_person === false) ? (
        <p role="status" className="text-sm text-muted-foreground">
          <strong>Esta liquidación se calculó con una tabla de recargos sin revisar.</strong> Los valores los cargó la
          instalación del sistema; hasta que alguien con la norma adelante los confirme en «Tablas de recargos», esta
          nómina descansa sobre un supuesto.
        </p>
      ) : null}
      {tables.length > 0 ? (
        <div className="flex flex-wrap gap-2">
          {tables.map((table, index) => (
            <Badge key={`${table.valid_from}-${index}`} variant="secondary">
              Tabla vigente desde {formatBusinessDate(table.valid_from)}: nocturno {formatBasisPoints(table.night_surcharge_bp)}, dominical/festivo{" "}
              {formatBasisPoints(table.sunday_holiday_surcharge_bp)}, extra {formatBasisPoints(table.overtime_surcharge_bp)}
            </Badge>
          ))}
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">Esta liquidación no informó qué tabla de recargos usó.</p>
      )}
      {lines.length === 0 ? (
        <p className="text-sm text-muted-foreground">Sin renglones por persona en esta liquidación.</p>
      ) : (
        <DenseTable
          caption="Renglones de la liquidación, por persona: base y cada recargo por separado."
          columns={RUN_LINE_COLUMNS}
          rows={lines}
          rowKey={(line) => String(line.employee_id)}
          maxBodyHeightPx={360}
          bar={<DenseTableBar shown={lines.length} total={lines.length} noun="personas liquidadas" />}
          legend={[
            {
              term: "Base y recargos por separado",
              meaning: "así se puede auditar renglón por renglón. La fórmula legal los combina distinto.",
            },
            {
              term: "«Sin datos»",
              meaning: "no es $ 0: esa persona no tenía tarifa vigente, así que no hay con qué liquidarla.",
            },
          ]}
        />
      )}
    </div>
  )
}

export function RunsTab({ storeId }: { storeId: number }): React.JSX.Element {
  const [from, setFrom] = useState(daysAgoLocal(15))
  const [to, setTo] = useState(todayLocal())
  const [expandedId, setExpandedId] = useState<number | null>(null)
  const queryClient = useQueryClient()

  const query = useQuery({
    queryKey: ["payroll", "runs", storeId, from, to],
    queryFn: () => getPayrollRuns({ storeId, from, to }),
  })

  const mutation = useMutation({
    mutationFn: () => createPayrollRun(storeId, { date_from: from, date_to: to }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["payroll", "runs"] })
      void queryClient.invalidateQueries({ queryKey: ["payroll", "run"] })
    },
  })

  return (
    <div className="space-y-4">
      {/* A-5. Va ACÁ y no dentro del detalle de una liquidación: el primer
          intento lo puso adentro, y el recorrido en navegador mostró que con
          cero liquidaciones no se veía nunca — justo cuando más importa, que
          es antes de apretar «Liquidar» por primera vez. */}
      {/* Regla 2 · El aviso queda a la vista en una línea; el porqué, plegado. */}
      <div className="rounded-md border border-l-[3px] border-l-warning bg-muted px-3 py-2 text-xs text-muted-foreground">
        <p>
          <strong>Esta cifra es para control interno, no es la liquidación legal.</strong> Antes de pagarle a alguien
          con este número, revisalo con tu contador.
        </p>
        <Explicacion resumen="¿Por qué?">
          <p>
            Paga la base más cada recargo (nocturno, dominical y festivo, hora extra) por separado, que es lo que la
            hace auditable renglón por renglón. La fórmula del Código Sustantivo del Trabajo los combina en ocho
            categorías, y esa todavía no está implementada.
          </p>
        </Explicacion>
      </div>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <DateRangeFilter idPrefix="payroll-runs" from={from} to={to} onChange={(r) => { setFrom(r.from); setTo(r.to) }} />
        <Button type="button" className="h-11" disabled={mutation.isPending} onClick={() => mutation.mutate()}>
          Liquidar este período
        </Button>
      </div>
      {mutation.isError ? (
        <p role="alert" className="text-sm text-destructive">
          {errorMessage(mutation.error)}
        </p>
      ) : null}
      {mutation.isSuccess && !mutation.data.available ? (
        <p role="alert" className="text-sm text-destructive">
          No se pudo liquidar: {mutation.data.reason ?? "faltan datos del período."}
        </p>
      ) : null}

      {query.isLoading ? (
        <Cargando texto="Cargando liquidaciones…" />
      ) : query.isError ? (
        <EmptyState reason="error" title="No se pudieron cargar las liquidaciones" description={errorMessage(query.error)} action={{ label: "Reintentar", onClick: () => void query.refetch() }} />
      ) : (query.data ?? []).length === 0 ? (
        <EmptyState
          reason="filter"
          title="No hay liquidaciones en este período"
          description={`El filtro puesto es el período: ${from} a ${to}. Todavía no se liquidó nada en ese rango.`}
        />
      ) : (
        <GroupLabel label="Liquidado" says="ya calculado y guardado: queda como constancia de con qué tabla se hizo">
        <div className="space-y-3">
          {runsHeadline(query.data ?? []) ? (
            <h3 data-testid="runs-headline" className="text-lg leading-snug font-semibold">
              {runsHeadline(query.data ?? [])}
            </h3>
          ) : null}
          {(query.data ?? []).map((run) => (
            <div key={run.id} className="rounded-lg border p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <p className="text-sm font-semibold">
                    Liquidación #{run.id} ·{" "}
                    {run.available ? (
                      formatCOP(run.total_amount)
                    ) : (
                      <SinDato motivo={run.reason} />
                    )}
                  </p>
                  <p className="text-xs text-muted-foreground">{formatBusinessDate(run.date_from)} – {formatBusinessDate(run.date_to)}</p>
                  {run.available ? <RunContext run={run} /> : null}
                </div>
                <Button type="button" variant="outline" size="sm" onClick={() => setExpandedId(expandedId === run.id ? null : run.id)}>
                  {expandedId === run.id ? "Ocultar detalle" : "Ver detalle"}
                </Button>
              </div>
              {expandedId === run.id ? (
                <div className="mt-3 overflow-x-auto">
                  <RunDetail runId={run.id} />
                </div>
              ) : null}
            </div>
          ))}
        </div>
        </GroupLabel>
      )}
    </div>
  )
}

export default RunsTab
