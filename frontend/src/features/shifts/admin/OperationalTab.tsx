import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { listAdminShifts, type AdminShiftListItem } from "@/api/shifts";
import {
  DenseTable,
  DenseTableBar,
  GroupLabel,
  type DenseColumn,
  type LegendEntry,
  type RowStatus,
} from "@/components/admin";
import { Cargando } from "@/components/Cargando";
import { EmptyState } from "@/components/EmptyState";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Diferencia } from "@/components/Diferencia";
import { errorMessage } from "@/lib/errors";
import { formatCOP } from "@/lib/money";

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

/**
 * § 8b · La franja de estado de la primera celda: la forma del problema sin
 * leer. Clasifica banderas que el servidor YA mandó (`is_stale`,
 * `reviewed_at`) — acá no se deriva ninguna diferencia.
 */
function shiftRowStatus(shift: AdminShiftListItem): RowStatus {
  if (shift.is_stale) return "critical";
  if (shift.status === "closed" && !shift.reviewed_at) return "warning";
  return "none";
}

function StatusCell({ shift }: { shift: AdminShiftListItem }): React.JSX.Element {
  return (
    <span className="flex items-center gap-1">
      <Badge variant={shift.status === "open" ? "default" : "secondary"}>
        {shift.status ? (STATUS_LABEL[shift.status] ?? shift.status) : "—"}
      </Badge>
      {shift.is_stale ? <Badge variant="destructive">Abandonado</Badge> : null}
    </span>
  );
}

/** La leyenda va **al pie y una sola vez** (§ 8d). */
export const SHIFT_LEGEND: readonly LegendEntry[] = [
  {
    term: "Abandonado",
    meaning: "pasó la hora de corte y el turno sigue abierto. No bloquea la venta, pero nadie lo cerró.",
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

export function shiftColumns(
  onOpenDetail: (shift: AdminShiftListItem) => void,
  extra: readonly DenseColumn<AdminShiftListItem>[] = [],
): readonly DenseColumn<AdminShiftListItem>[] {
  return [
    ...extra,
    { key: "status", header: "Estado", cell: (s) => <StatusCell shift={s} /> },
    { key: "who", header: "Responsable", cell: (s) => s.cash_responsible?.name ?? "—" },
    { key: "expected", header: "Esperado", kind: "number", cell: (s) => formatCOP(s.expected_cash) },
    { key: "counted", header: "Contado", kind: "number", cell: (s) => formatCOP(s.counted_cash) },
    {
      key: "difference",
      header: "Diferencia",
      kind: "number",
      cell: (s) => <Diferencia valor={s.difference} motivoSinDato="sin conteo de cierre" />,
    },
    {
      key: "reviewed",
      header: "Revisión",
      kind: "secondary",
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
        <Button type="button" variant="ghost" size="sm" onClick={() => onOpenDetail(s)}>
          Ver detalle
        </Button>
      ),
    },
  ];
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
    queryKey: ["admin-shifts", "operational", storeId, today],
    queryFn: () => listAdminShifts({ storeId, from: today, to: today }),
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
