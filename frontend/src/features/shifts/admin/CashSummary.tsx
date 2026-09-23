import { useQuery } from "@tanstack/react-query";

import { getAdminShiftsSummary, type AdminShiftFilters, type ShiftCashSummary } from "@/api/shifts";
import { ChartFrame, DivergingBars } from "@/components/charts";
import { errorMessage } from "@/lib/errors";
import { formatFechaCorta } from "@/lib/format";
import { formatCOP } from "@/lib/money";

import { cashSummaryHeadline, cierres, conSigno } from "./lib";

/** Selecciona el día con el faltante más grande (elegir, no calcular). */
function peorDia(s: ShiftCashSummary): ShiftCashSummary["by_day"][number] | null {
  let peor: ShiftCashSummary["by_day"][number] | null = null;
  for (const d of s.by_day) if (d.diff_total < 0 && (peor === null || d.diff_total < peor.diff_total)) peor = d;
  return peor;
}

function rango(s: ShiftCashSummary): string | undefined {
  if (!s.date_from && !s.date_to) return "todo el historial";
  return `${s.date_from ? formatFechaCorta(s.date_from) : "el inicio"} a ${s.date_to ? formatFechaCorta(s.date_to) : "hoy"}`;
}

/**
 * La cabecera de Dinero › Historial: el titular, las diferencias por día y
 * por responsable como barras divergentes (faltante rojo, sobrante ámbar,
 * cero al centro), con su tabla gemela. Mismos filtros que la tabla.
 */
export function CashSummary({ filters }: { filters: AdminShiftFilters }): React.JSX.Element | null {
  const query = useQuery({
    queryKey: ["admin-shifts", "summary", filters],
    queryFn: () => getAdminShiftsSummary(filters),
  });

  if (query.isLoading) return <p className="text-sm text-muted-foreground">Sumando las diferencias…</p>;
  if (query.isError) {
    return (
      <p role="alert" className="text-sm text-muted-foreground">
        No se pudo cargar el resumen de caja: {errorMessage(query.error)}
      </p>
    );
  }
  const s = query.data;
  if (!s) return null;

  const detalle: string[] = [`Diferencia neta ${conSigno(s.diff_total)}`];
  if (s.overage_count > 0 && s.shortage_count > 0) detalle.push(`${s.overage_count} con sobrante (${conSigno(s.overage_total)})`);
  detalle.push(`${s.exact_count} ${s.exact_count === 1 ? "cuadró" : "cuadraron"}`);
  detalle.push(
    s.beyond_tolerance_count === 0
      ? `ninguno pasa la tolerancia de ${formatCOP(s.tolerance)}`
      : `${s.beyond_tolerance_count} ${s.beyond_tolerance_count === 1 ? "pasa" : "pasan"} la tolerancia de ${formatCOP(s.tolerance)}`,
  );

  const peor = peorDia(s);
  const diaTitular = peor
    ? `El faltante más grande fue el ${formatFechaCorta(peor.business_date)}: ${conSigno(peor.diff_total)}`
    : "Ningún día cerró con faltante";

  const enRacha = s.by_person.filter((p) => p.current_streak >= 2).sort((a, b) => b.current_streak - a.current_streak);
  const primeraPersona = s.by_person[0];
  const personaTitular =
    enRacha.length > 0
      ? `${enRacha[0].name} lleva ${enRacha[0].current_streak} cierres seguidos fuera de tolerancia`
      : primeraPersona && primeraPersona.diff_total < 0
        ? `${primeraPersona.name} acumula ${conSigno(primeraPersona.diff_total)} en ${cierres(primeraPersona.closes)}`
        : "Nadie acumula faltante en el período";

  // Las diferencias son sumas exactas de cierres contados, no una estimación
  // sobre una muestra: se dice la base (n y ventana) pero no se marca
  // «muestra chica» — un solo cierre con faltante es un faltante real.
  const base = { n: s.counted_count, unidad: "cierres contados", ventana: rango(s), minimo: 1 };

  return (
    <section aria-label="Resumen de caja del período" className="space-y-4">
      <div className="space-y-1">
        <h3
          data-testid="cash-summary-headline"
          className={s.shortage_count > 0 ? "text-lg leading-snug font-semibold text-destructive" : "text-lg leading-snug font-semibold"}
        >
          {s.shortage_count > 0 ? <span aria-hidden="true">▼ </span> : null}
          {cashSummaryHeadline(s)}
        </h3>
        {s.counted_count > 0 ? <p className="text-sm text-muted-foreground">{detalle.join(" · ")}.</p> : null}
        {s.uncounted_count > 0 ? (
          <p className="sin-dato px-2 py-1 text-xs">
            <span className="font-medium not-italic">Sin contar: </span>
            {cierres(s.uncounted_count)} no se contaron y no entran en ninguna cifra: no son $ 0, es que nadie contó.
          </p>
        ) : null}
      </div>

      {s.counted_count > 0 ? (
        <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-2">
          <div className="rounded-lg border bg-card p-4">
            <ChartFrame
              titular={diaTitular}
              detalle="Diferencia de caja por día (contado − esperado), en pesos."
              muestra={base}
              tabla={{
                columnas: [
                  { key: "dia", header: "Día" },
                  { key: "closes", header: "Cierres", align: "right" },
                  { key: "diff", header: "Diferencia", align: "right" },
                ],
                filas: s.by_day.map((d) => ({
                  dia: formatFechaCorta(d.business_date),
                  closes: String(d.closes),
                  diff: conSigno(d.diff_total),
                })),
              }}
            >
              <DivergingBars
                datos={s.by_day.map((d) => ({
                  key: d.business_date,
                  etiqueta: formatFechaCorta(d.business_date),
                  valor: d.diff_total,
                }))}
                formato={formatCOP}
              />
            </ChartFrame>
          </div>
          <div className="rounded-lg border bg-card p-4">
            <ChartFrame
              titular={personaTitular}
              detalle="Diferencia acumulada por responsable de caja; la racha son cierres seguidos fuera de la tolerancia."
              muestra={base}
              tabla={{
                columnas: [
                  { key: "name", header: "Responsable" },
                  { key: "closes", header: "Cierres", align: "right" },
                  { key: "short", header: "Con faltante", align: "right" },
                  { key: "over", header: "Con sobrante", align: "right" },
                  { key: "diff", header: "Diferencia", align: "right" },
                  { key: "streak", header: "Racha", align: "right" },
                ],
                filas: s.by_person.map((p) => ({
                  name: p.name,
                  closes: String(p.closes),
                  short: String(p.shortage_count),
                  over: String(p.overage_count),
                  diff: conSigno(p.diff_total),
                  streak: String(p.current_streak),
                })),
              }}
            >
              <DivergingBars
                datos={s.by_person.map((p) => ({
                  key: String(p.employee_id),
                  etiqueta: `${p.name} · ${cierres(p.closes)}${p.current_streak >= 2 ? ` · racha de ${p.current_streak}` : ""}`,
                  valor: p.diff_total,
                }))}
                formato={formatCOP}
              />
            </ChartFrame>
          </div>
        </div>
      ) : null}
    </section>
  );
}

export default CashSummary;
