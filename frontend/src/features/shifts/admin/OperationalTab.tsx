import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router-dom";

import { listAdminShifts, type AdminShiftListItem } from "@/api/shifts";
import {
  DenseTable,
  DenseTableBar,
  GroupLabel,
  type DenseColumn,
  type LegendEntry,
} from "@/components/admin";
import { Cargando } from "@/components/Cargando";
import { EmptyState } from "@/components/EmptyState";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Diferencia } from "@/components/Diferencia";
import { errorMessage } from "@/lib/errors";
import { formatCOP } from "@/lib/money";
import { formatFechaCorta } from "@/lib/format";
import { fichaPersonaHref, fichaTurnoHref } from "@/features/reports/fichas/rutas";

import { shiftRowStatus } from "./lib";
import { ShiftDetailDialog } from "./ShiftDetailDialog";

/**
 * "Hoy" en la zona de la sede, sólo como valor inicial de un filtro de
 * pantalla (nunca como fecha operativa de un registro: esa la sella el
 * servidor con la hora de corte de la sede — `core/tz.py`). Usar
 * `Intl.DateTimeFormat` acá es intencional y distinto de las trampas
 * prohibidas en `lib/businessDate.ts` (`new Date("YYYY-MM-DD")` o
 * `toISOString().slice(0, 10)`): esto parte de "ahora", no de un
 * `business_date` ya guardado.
 */
function todayInBogota(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Bogota" }).format(new Date());
}

const STATUS_LABEL: Record<string, string> = { open: "Abierto", closed: "Cerrado" };

function StatusCell({ shift }: { shift: AdminShiftListItem }): React.JSX.Element {
  return (
    <span className="flex items-center gap-1">
      <Badge variant={shift.status === "open" ? "default" : "secondary"}>
        {shift.status ? (STATUS_LABEL[shift.status] ?? shift.status) : "—"}
      </Badge>
      {shift.is_stale ? (
        <Badge variant="destructive" title={`Abierto desde el día operativo ${shift.business_date ?? "—"}`}>
          Abandonado{shift.business_date ? ` · ${formatFechaCorta(shift.business_date)}` : ""}
        </Badge>
      ) : null}
    </span>
  );
}

/**
 * El responsable, con enlace a su ficha. El nombre es el congelado del
 * turno; si la persona ya no está activa, lo dice: una caja a nombre de
 * alguien que ya no trabaja acá no puede verse igual que las demás.
 */
function ResponsibleCell({ shift }: { shift: AdminShiftListItem }): React.JSX.Element {
  const who = shift.cash_responsible;
  if (!who) return <span>—</span>;
  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap">
      <Link to={fichaPersonaHref(who.id)} className="text-primary hover:underline">
        {who.name}
      </Link>
      {shift.cash_responsible_active === false ? <Badge variant="destructive">inactivo</Badge> : null}
    </span>
  );
}

/** La leyenda va **al pie y una sola vez** (§ 8d). */
export const SHIFT_LEGEND: readonly LegendEntry[] = [
  {
    term: "Abandonado",
    meaning:
      "pasó la hora de corte y el turno sigue abierto. No bloquea la venta, pero nadie lo cerró. Aparece en Operacional aunque sea de otro día.",
  },
  {
    term: "Sin revisar",
    meaning: "el cierre existe y quedó en pie; lo que falta es que vos lo mires. No es un error de caja.",
  },
  {
    term: "«—» no es $ 0",
    meaning: "un turno abierto todavía no tiene contado ni diferencia: no se contó, no es que diera cero.",
  },
];

/**
 * Las columnas de una tabla de turnos. `secundarias` nombra las que quedan
 * detrás de «Más columnas» (mapa de pantallas, regla 3: cinco a la vista):
 * Historial suma el día operativo y manda «Estado» atrás, porque ahí casi
 * todo está cerrado y el abandonado ya lo dice la franja de la fila.
 */
export function shiftColumns(
  onOpenDetail: (shift: AdminShiftListItem) => void,
  extra: readonly DenseColumn<AdminShiftListItem>[] = [],
  secundarias: readonly string[] = [],
): readonly DenseColumn<AdminShiftListItem>[] {
  const columns: DenseColumn<AdminShiftListItem>[] = [
    ...extra,
    { key: "status", header: "Estado", cell: (s) => <StatusCell shift={s} /> },
    { key: "who", header: "Responsable", cell: (s) => <ResponsibleCell shift={s} /> },
    { key: "expected", header: "Esperado", kind: "number", cell: (s) => formatCOP(s.expected_cash) },
    { key: "counted", header: "Contado", kind: "number", cell: (s) => formatCOP(s.counted_cash) },
    {
      key: "difference",
      header: "Diferencia",
      kind: "number",
      cell: (s) => (
        <span className="inline-flex flex-col items-end gap-0.5">
          <Diferencia valor={s.difference} motivoSinDato="sin conteo de cierre" />
          {s.recounted_after_review ? (
            <span className="text-xs font-medium text-destructive">Recontado después de ver el esperado</span>
          ) : null}
        </span>
      ),
    },
    {
      key: "reviewed",
      header: "Revisión",
      kind: "secondary",
      secondary: true,
      cell: (s) => (s.reviewed_at ? "Revisado" : "Sin revisar"),
    },
    {
      // Acciones como columna de ancho fijo, para que el borde derecho no se
      // mueva de fila a fila (§ 8). Es un botón y no una fila clicable: así
      // se opera con teclado, que una fila sola no permite.
      key: "actions",
      header: "Acciones",
      kind: "actions",
      cell: (s) => (
        <span className="inline-flex items-center gap-1">
          <Button type="button" variant="ghost" size="sm" onClick={() => onOpenDetail(s)}>
            Ver detalle
          </Button>
          <Link to={fichaTurnoHref(s.id)} className="text-sm text-primary hover:underline" title="Ficha del turno">
            Ficha
          </Link>
        </span>
      ),
    },
  ];
  return columns.map((column) => (secundarias.includes(column.key) ? { ...column, secondary: true } : column));
}

/**
 * Dinero → Operacional: turnos abiertos y de hoy, por sede.
 *
 * § 3 · El rótulo de grupo parte la pantalla en dos: **«Ahora mismo»** (el
 * turno vivo, que todavía puede cambiar o salir mal) y **«Del día»** (los
 * que ya cerraron y no cambian). Antes eran una sola tabla ordenada a mano
 * por «abierto primero», que es la misma información sin decir por qué.
 */
export function OperationalTab({ storeId }: { storeId: number }): React.JSX.Element {
  const [detailShift, setDetailShift] = useState<AdminShiftListItem | null>(null);
  const today = todayInBogota();

  const query = useQuery({
    // `includeOpen`: los turnos de hoy MÁS los abiertos de cualquier día. Un
    // turno abandonado del 16 que Hoy mostraba no aparecía acá porque su
    // fecha no es hoy; ahora va arriba, en «Ahora mismo», marcado.
    queryKey: ["admin-shifts", "operational", storeId, today],
    queryFn: () => listAdminShifts({ storeId, from: today, to: today, includeOpen: true }),
  });

  if (query.isLoading) {
    return <Cargando texto="Cargando turnos de hoy…" />;
  }
  if (query.isError) {
    return (
      <EmptyState
        reason="error"
        title="No se pudieron cargar los turnos"
        description={errorMessage(query.error)}
        action={{ label: "Reintentar", onClick: () => void query.refetch() }}
      />
    );
  }

  const rows = query.data ?? [];
  const live = rows.filter((s) => s.status === "open");
  const done = rows.filter((s) => s.status !== "open");
  const columns = shiftColumns(setDetailShift);

  return (
    <div className="space-y-5">
      {rows.length === 0 ? (
        <EmptyState
          reason="dependency"
          title="Sin turnos hoy en esta sede"
          description="Todavía no se abrió ningún turno. Sin turno abierto no se puede vender."
        />
      ) : (
        <>
          <GroupLabel label="Ahora mismo" says="vivo — todavía puede cambiar o salir mal">
            {live.length === 0 ? (
              <p className="rounded-lg border border-dashed px-3 py-2 text-sm text-muted-foreground">
                Ningún turno abierto en este momento. Sin turno abierto no se puede vender.
              </p>
            ) : (
              <DenseTable
                caption="Turnos abiertos ahora mismo en esta sede."
                columns={columns}
                rows={live}
                rowKey={(s) => String(s.id)}
                rowStatus={shiftRowStatus}
                bar={<DenseTableBar shown={live.length} total={rows.length} noun="turnos abiertos" hidden={`${done.length} ya cerrados, abajo`} />}
                legend={SHIFT_LEGEND}
              />
            )}
          </GroupLabel>

          <GroupLabel label="Del día" says="cerrado, ya no cambia">
            {done.length === 0 ? (
              <p className="rounded-lg border border-dashed px-3 py-2 text-sm text-muted-foreground">
                Todavía no cerró ningún turno hoy.
              </p>
            ) : (
              <DenseTable
                caption="Turnos ya cerrados hoy en esta sede."
                columns={columns}
                rows={done}
                rowKey={(s) => String(s.id)}
                rowStatus={shiftRowStatus}
                maxBodyHeightPx={340}
                bar={<DenseTableBar shown={done.length} total={rows.length} noun="turnos cerrados hoy" />}
              />
            )}
          </GroupLabel>
        </>
      )}

      {detailShift ? (
        <ShiftDetailDialog
          shift={detailShift}
          open
          onOpenChange={(open) => {
            if (!open) setDetailShift(null);
          }}
          onChanged={() => void query.refetch()}
        />
      ) : null}
    </div>
  );
}
