import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, Camera, ChevronDown, ChevronRight, Download } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router-dom";

import { useStoreSelection } from "@/app/storeContext";
import {
  cuadresCsvUrl,
  listCuadres,
  type Cuadre,
  type CuadreDesglose,
  type CuadreMovement,
  type CuadrePerformance,
  type CuadreShift,
  type CuadresFilters,
  type CuadresStatus,
} from "@/api/shifts";
import { Cargando } from "@/components/Cargando";
import { EmptyState } from "@/components/EmptyState";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { fichaPersonaHref, fichaTurnoHref } from "@/features/reports/fichas/rutas";
import { formatBusinessDate, formatClockTime } from "@/lib/businessDate";
import { errorMessage } from "@/lib/errors";
import { formatCOP } from "@/lib/money";
import { cn } from "@/lib/utils";

import { CashSummary } from "./CashSummary";
import { conSigno, monthStartInBogota, todayInBogota } from "./lib";
import { ReserveCard } from "./ReserveCard";
import { AdjustOpeningButton, CancelButton, CloseAdministrativeButton, ReopenButton } from "./rescates";
import { ShiftTimeline } from "./ShiftTimeline";

const STATUS_CHIPS: { value: CuadresStatus; label: string }[] = [
  { value: "all", label: "Todos" },
  { value: "closed", label: "Cerrados" },
  { value: "open", label: "Abiertos" },
];

const CUADRES_QUERY_KEY = ["admin-cuadres"] as const;

/**
 * **Cuadres** (Caja › Dinero, como el café — decisión del dueño, 2026-09-29):
 * la ÚNICA pantalla de turnos del administrador. Reemplaza a Operacional,
 * Historial y el detalle del turno. Una tarjeta por turno con sus cuadres
 * (Inicial, Relevo, Arqueo, Cierre) «contó / debía», el desglose de cada
 * uno, quién estuvo, los movimientos de caja y los rescates; al pie, el
 * desempeño por responsable; arriba, la base de respaldo (`ReserveCard`) y
 * en cada tarjeta la cronología del turno, plegada. Todas las cifras las manda el servidor
 * (`GET /admin/cuadres`): acá no se suma ni se resta plata.
 */
export function CuadresScreen({
  storeId,
  initialStatus = "all",
}: {
  storeId: number;
  initialStatus?: CuadresStatus;
}): React.JSX.Element {
  const { stores, setActiveStoreId } = useStoreSelection();
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<CuadresStatus>(initialStatus);
  const [from, setFrom] = useState(monthStartInBogota);
  const [to, setTo] = useState(todayInBogota);

  const filters: CuadresFilters = { storeId, status, from: from || undefined, to: to || undefined };
  const query = useQuery({
    queryKey: [...CUADRES_QUERY_KEY, filters],
    queryFn: () => listCuadres(filters),
  });
  const refrescar = () => void queryClient.invalidateQueries({ queryKey: CUADRES_QUERY_KEY });
  const shifts = query.data?.shifts ?? [];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <div role="group" aria-label="Estado" className="flex gap-1.5">
          {STATUS_CHIPS.map((chip) => (
            <Button
              key={chip.value}
              type="button"
              size="sm"
              variant={status === chip.value ? "default" : "outline"}
              aria-pressed={status === chip.value}
              onClick={() => setStatus(chip.value)}
            >
              {chip.label}
            </Button>
          ))}
        </div>
        <div className="space-y-1">
          <Label htmlFor="cuadres-from">Desde</Label>
          <Input id="cuadres-from" type="date" className="h-9" value={from} onChange={(e) => setFrom(e.target.value)} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="cuadres-to">Hasta</Label>
          <Input id="cuadres-to" type="date" className="h-9" value={to} onChange={(e) => setTo(e.target.value)} />
        </div>
        <div className="ml-auto flex flex-wrap gap-2">
          <DownloadLink href={cuadresCsvUrl(filters, "cuadres")} label="Descargar cuadres" />
          <DownloadLink href={cuadresCsvUrl(filters, "movements")} label="Descargar movimientos" />
        </div>
      </div>

      {stores.length > 1 ? (
        <div role="group" aria-label="Sede" className="flex flex-wrap gap-1.5">
          {stores.map((s) => (
            <Button
              key={s.id}
              type="button"
              size="sm"
              variant={s.id === storeId ? "secondary" : "ghost"}
              aria-pressed={s.id === storeId}
              onClick={() => setActiveStoreId(s.id)}
            >
              {s.name}
            </Button>
          ))}
        </div>
      ) : null}

      <ReserveCard storeId={storeId} />

      <details className="rounded-[12px] border bg-card p-3">
        <summary className="cursor-pointer text-sm font-bold">¿La caja cuadra en el período?</summary>
        <div className="mt-2">
          <CashSummary filters={{ storeId, from: from || undefined, to: to || undefined }} />
        </div>
      </details>

      {query.isLoading ? (
        <Cargando texto="Cargando cuadres…" />
      ) : query.isError ? (
        <EmptyState
          reason="error"
          title="No se pudieron cargar los cuadres"
          description={errorMessage(query.error)}
          action={{ label: "Reintentar", onClick: () => void query.refetch() }}
        />
      ) : shifts.length === 0 ? (
        <EmptyState reason="filter" title="Sin turnos para estos filtros" description="Cambiá el estado o las fechas." />
      ) : (
        <ul className="space-y-3">
          {shifts.map((shift) => (
            <li key={shift.shift_id}>
              <CuadreCard shift={shift} onChanged={refrescar} />
            </li>
          ))}
        </ul>
      )}

      {query.data ? <Performance rows={query.data.performance} href={cuadresCsvUrl(filters, "performance")} /> : null}
    </div>
  );
}

function DownloadLink({ href, label }: { href: string; label: string }): React.JSX.Element {
  return (
    <Button render={<a href={href} target="_blank" rel="noreferrer" />} variant="outline" size="sm" className="gap-1.5">
      <Download className="size-4" aria-hidden="true" />
      {label}
    </Button>
  );
}

const STATUS_LABEL: Record<string, string> = { open: "Abierto", closed: "Cerrado", cancelled: "Cancelado" };

/** Una tarjeta por turno, como la del café. */
export function CuadreCard({ shift, onChanged }: { shift: CuadreShift; onChanged: () => void }): React.JSX.Element {
  const [abierto, setAbierto] = useState<number | null>(null);
  const cierre = shift.cuadres.find((c) => c.kind === "close");
  const who = shift.cash_responsible;

  return (
    <article
      aria-label={`Turno del ${formatBusinessDate(shift.business_date)}`}
      className="rounded-[12px] border bg-card p-4"
    >
      <header className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <h3 className="text-base font-bold capitalize">{formatBusinessDate(shift.business_date)}</h3>
        <span className="text-sm text-muted-foreground">
          Abrió {formatClockTime(shift.opened_at)} → {shift.closed_at ? `cerró ${formatClockTime(shift.closed_at)}` : "sigue abierto"}
        </span>
        <Badge variant={shift.status === "open" ? "default" : "secondary"}>
          {STATUS_LABEL[shift.status] ?? shift.status}
        </Badge>
        {shift.is_stale ? (
          <Badge variant="destructive">Abandonado · {formatBusinessDate(shift.business_date)}</Badge>
        ) : null}
        {who?.name ? (
          <Link to={fichaPersonaHref(who.id)} className="text-sm text-primary hover:underline">
            {who.name}
          </Link>
        ) : null}
        <Link to={fichaTurnoHref(shift.shift_id)} className="text-sm text-primary hover:underline">
          Ficha
        </Link>
        <div className="ml-auto flex flex-wrap gap-2">
          {shift.status === "closed" ? <ReopenButton shiftId={shift.shift_id} onDone={onChanged} /> : null}
          {shift.status === "open" && shift.is_stale ? (
            <CloseAdministrativeButton shiftId={shift.shift_id} onDone={onChanged} />
          ) : null}
          {shift.status === "open" ? <CancelButton shiftId={shift.shift_id} onDone={onChanged} /> : null}
          {shift.status !== "cancelled" ? <AdjustOpeningButton shiftId={shift.shift_id} onDone={onChanged} /> : null}
        </div>
      </header>

      <p data-testid="cuadre-numeros" className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-sm">
        <span>
          Base <b className="tabular-nums">{formatCOP(shift.opening_cash_total)}</b>
        </span>
        <span>
          Ventas <b className="tabular-nums">{formatCOP(shift.sales_total)}</b>
        </span>
        <span>
          Efectivo <b className="tabular-nums">{formatCOP(shift.sales_cash)}</b>
        </span>
        <span>
          Tarjeta <b className="tabular-nums">{formatCOP(shift.sales_card)}</b>
        </span>
        {cierre ? (
          <span>
            Cierre{" "}
            {cierre.without_count ? (
              <b>sin conteo</b>
            ) : cierre.difference === 0 ? (
              <b className="text-success">✓ cuadró</b>
            ) : (
              <b className={cierre.difference && cierre.difference < 0 ? "text-destructive" : "text-primary"}>
                {conSigno(cierre.difference ?? 0)}
              </b>
            )}
          </span>
        ) : null}
        {shift.close_photo ? <PhotoLink href={shift.close_photo} label="Foto del cierre" /> : null}
      </p>

      <div className="mt-3 grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]">
        <div className="space-y-3">
          <div>
            <p className="mb-1.5 text-xs font-bold tracking-wide text-muted-foreground uppercase">Cuadres</p>
            <ul className="flex flex-wrap gap-2">
              {shift.cuadres.map((c, i) => (
                <li key={`${c.kind}-${i}`}>
                  <CuadreChip cuadre={c} expanded={abierto === i} onToggle={() => setAbierto(abierto === i ? null : i)} />
                </li>
              ))}
            </ul>
            {abierto !== null && shift.cuadres[abierto] ? <Desglose cuadre={shift.cuadres[abierto]} /> : null}
          </div>

          {shift.people.length > 0 ? (
            <div>
              <p className="mb-1.5 text-xs font-bold tracking-wide text-muted-foreground uppercase">Quién estuvo</p>
              <ul className="flex flex-wrap gap-1.5">
                {shift.people.map((p, i) => (
                  <li key={`${p.employee_id}-${i}`} className="rounded-full bg-muted px-2.5 py-1 text-xs">
                    <b>{p.name}</b> {formatClockTime(p.in_at)} → {p.out_at ? formatClockTime(p.out_at) : "sigue"}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>

        <Movements rows={shift.movements} />
      </div>

      <ShiftTimeline shiftId={shift.shift_id} />
    </article>
  );
}

/** Verde si cuadró, azul si sobra, rojo si falta — con palabra, no sólo color. */
function DiferenciaChip({ value }: { value: number | null | undefined }): React.JSX.Element | null {
  if (value === null || value === undefined) return null;
  if (value === 0) {
    return <span className="rounded-full bg-success/15 px-2 py-0.5 text-xs font-bold text-success">✓ $ 0</span>;
  }
  const falta = value < 0;
  return (
    <span
      className={cn(
        "rounded-full px-2 py-0.5 text-xs font-bold tabular-nums",
        falta ? "bg-destructive/15 text-destructive" : "bg-primary/15 text-primary",
      )}
    >
      {falta ? "Falta " : "Sobra "}
      {conSigno(value)}
    </span>
  );
}

function CuadreChip({
  cuadre,
  expanded,
  onToggle,
}: {
  cuadre: Cuadre;
  expanded: boolean;
  onToggle: () => void;
}): React.JSX.Element {
  const Icon = expanded ? ChevronDown : ChevronRight;
  return (
    <span className="inline-flex items-center gap-1.5 rounded-[10px] border bg-background px-2.5 py-1.5 text-sm">
      <button
        type="button"
        aria-expanded={expanded}
        onClick={onToggle}
        className="inline-flex items-center gap-1 text-left hover:underline"
      >
        <Icon aria-hidden="true" className="size-4" />
        <b>{cuadre.label}</b>{" "}
        {cuadre.without_count ? (
          <span className="text-muted-foreground">sin conteo</span>
        ) : (
          <span className="text-muted-foreground tabular-nums">
            contó {formatCOP(cuadre.counted ?? null)} / debía {formatCOP(cuadre.expected ?? null)}
          </span>
        )}
      </button>
      <DiferenciaChip value={cuadre.without_count ? null : cuadre.difference} />
      {cuadre.photo ? <PhotoLink href={cuadre.photo} label={`Foto del cuadre ${cuadre.label}`} /> : null}
    </span>
  );
}

function PhotoLink({ href, label }: { href: string; label: string }): React.JSX.Element {
  return (
    <a href={href} target="_blank" rel="noreferrer" aria-label={label} title={label} className="text-primary">
      <Camera aria-hidden="true" className="inline size-4" />
    </a>
  );
}

function Linea({ label, value, signo }: { label: string; value: number | null | undefined; signo?: "+" | "−" }) {
  if (value === null || value === undefined) return null;
  return (
    <div className="flex justify-between gap-4">
      <dt>
        {signo ? <span aria-hidden="true">{signo} </span> : null}
        {label}
      </dt>
      <dd className="tabular-nums">{formatCOP(value)}</dd>
    </div>
  );
}

/**
 * El desglose de un cuadre, tal cual lo manda el servidor: «Con lo que
 * empezó + Ventas en efectivo + Otros ingresos − Salidas (una por una) −
 * Retiros − Consignado = Debería haber; Contó; Diferencia; Base de respaldo
 * aparte (no cuenta)». Para el Inicial, qué días debía haber en el cajón.
 */
export function Desglose({ cuadre }: { cuadre: Cuadre }): React.JSX.Element {
  const d: CuadreDesglose = cuadre.desglose;
  return (
    <section
      aria-label={`Desglose del cuadre ${cuadre.label}`}
      className="mt-2 max-w-md rounded-[10px] border bg-muted/30 p-3 text-sm"
    >
      <dl className="space-y-1">
        {cuadre.kind === "opening" ? (
          <>
            {(d.carried_days ?? []).map((day) => (
              <div key={day.shift_id} className="flex justify-between gap-4">
                <dt className="capitalize">Plata del {formatBusinessDate(day.business_date ?? null)}</dt>
                <dd className="tabular-nums">{formatCOP(day.amount)}</dd>
              </div>
            ))}
            {d.fixed_base ? <Linea label="Base fija" value={d.fixed_base} /> : null}
          </>
        ) : (
          <>
            <Linea label="Con lo que empezó (base)" value={d.base} />
            <Linea label="Ventas en efectivo" value={d.cash_sales} signo="+" />
            <Linea label="Otros ingresos" value={d.incomes} signo="+" />
            <Linea label="Salidas de efectivo" value={d.expenses} signo="−" />
            {(d.expense_lines ?? []).length > 0 ? (
              <ul className="ml-4 space-y-0.5 text-xs text-muted-foreground">
                {(d.expense_lines ?? []).map((line, i) => (
                  <li key={i} className="flex justify-between gap-4">
                    <span>
                      {formatClockTime(line.at)} · {line.concept}
                      {line.note ? ` — ${line.note}` : ""}
                    </span>
                    <span className="tabular-nums">{formatCOP(line.amount)}</span>
                  </li>
                ))}
              </ul>
            ) : null}
            <Linea label="Retiros" value={d.pickups} signo="−" />
            <Linea label="Consignado" value={d.deposits} signo="−" />
            {d.reserve_loan ? <Linea label="Prestado por la base de respaldo" value={d.reserve_loan} signo="+" /> : null}
          </>
        )}
        <div className="flex justify-between gap-4 border-t pt-1 font-semibold">
          <dt>= Debería haber</dt>
          <dd className="tabular-nums">{formatCOP(d.expected ?? null)}</dd>
        </div>
        <Linea label="Contó" value={d.counted} />
        {d.difference !== null && d.difference !== undefined ? (
          <div className="flex justify-between gap-4">
            <dt>Diferencia</dt>
            <dd>
              <DiferenciaChip value={d.difference} />
            </dd>
          </div>
        ) : null}
        {cuadre.kind === "opening" && d.surplus_consignable ? (
          <p className="text-xs text-muted-foreground">El sobrante se consigna con este turno.</p>
        ) : null}
        {cuadre.kind === "opening" && d.shortage ? (
          <p className="text-xs text-muted-foreground">El faltante quedó como novedad justificada.</p>
        ) : null}
        {cuadre.note ? <p className="text-xs">Motivo: {cuadre.note}</p> : null}
        {d.reserve_apart ? (
          <p className="border-t pt-1 text-xs text-muted-foreground">
            Base de respaldo aparte (no cuenta): {formatCOP(d.reserve_apart)}
          </p>
        ) : null}
      </dl>
    </section>
  );
}

/** «Movimientos de caja»: cada entrada (↑) y salida (↓) del cajón, con concepto, proveedor, hora, foto y nota. */
function Movements({ rows }: { rows: CuadreMovement[] }): React.JSX.Element {
  return (
    <section aria-label="Movimientos de caja" className="rounded-[10px] border p-3">
      <p className="mb-1.5 text-xs font-bold tracking-wide text-muted-foreground uppercase">Movimientos de caja</p>
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">Sin movimientos.</p>
      ) : (
        <ul className="space-y-1.5">
          {rows.map((m, i) => {
            const entra = m.direction === "in";
            const Icon = entra ? ArrowUp : ArrowDown;
            return (
              <li key={i} className="flex items-start gap-2 text-sm">
                <Icon
                  aria-label={entra ? "Entrada" : "Salida"}
                  className={cn("mt-0.5 size-4 shrink-0", entra ? "text-success" : "text-destructive")}
                />
                <span className="min-w-0 flex-1">
                  <span className="font-medium">{m.concept}</span>
                  {m.supplier_name ? <span> · {m.supplier_name}</span> : null}
                  <span className="block text-xs text-muted-foreground">
                    {formatClockTime(m.at)}
                    {m.employee_name ? ` · ${m.employee_name}` : ""}
                    {m.note ? ` · ${m.note}` : ""}
                  </span>
                </span>
                {m.photo ? <PhotoLink href={m.photo} label={`Foto de ${m.concept}`} /> : null}
                <span className={cn("font-semibold tabular-nums", entra ? "text-success" : "text-destructive")}>
                  {conSigno(m.amount)}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/** El pie plegable: «Desempeño por responsable», con su descarga. */
function Performance({ rows, href }: { rows: CuadrePerformance[]; href: string }): React.JSX.Element {
  return (
    <details className="rounded-[12px] border bg-card p-3">
      <summary className="cursor-pointer text-sm font-bold">Desempeño por responsable</summary>
      {rows.length === 0 ? (
        <p className="mt-2 text-sm text-muted-foreground">Sin cuadres contados en el período.</p>
      ) : (
        <table className="mt-2 w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-muted-foreground">
              <th className="py-1 font-medium">Responsable</th>
              <th className="py-1 text-right font-medium">Cuadres</th>
              <th className="py-1 text-right font-medium">Con diferencia</th>
              <th className="py-1 text-right font-medium">Diferencia total</th>
              <th className="py-1 text-right font-medium">Peor diferencia</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => (
              <tr key={`${p.employee_id ?? p.name}`} className="border-t">
                <td className="py-1">{p.name}</td>
                <td className="py-1 text-right tabular-nums">{p.cuadres}</td>
                <td className="py-1 text-right tabular-nums">{p.with_difference}</td>
                <td className="py-1 text-right tabular-nums">{conSigno(p.diff_total)}</td>
                <td className="py-1 text-right tabular-nums">{conSigno(p.worst_difference)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="mt-2">
        <DownloadLink href={href} label="Descargar desempeño" />
      </div>
    </details>
  );
}
