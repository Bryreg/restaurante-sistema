import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { toast } from "sonner";

import { getAdminReserve, reverseReserveMovement, type AdminReserveMovement } from "@/api/shifts";
import { useSession } from "@/app/session";
import { Cargando } from "@/components/Cargando";
import { EmptyState } from "@/components/EmptyState";
import { fichaTurnoHref } from "@/features/reports/fichas/rutas";
import { formatInstant } from "@/lib/businessDate";
import { errorMessage } from "@/lib/errors";
import { formatCOP } from "@/lib/money";

import { conSigno } from "./lib";
import { ReasonRescueButton } from "./rescates";

const ADMIN_RESERVE_QUERY_KEY = ["admin-reserve"] as const;

const KIND_LABEL: Record<string, string> = { take: "Tomó de la base", return: "Devolvió a la base" };

/**
 * **La base de respaldo** en Caja › Dinero (`GET /admin/stores/{id}/reserve`):
 * la plata aparte del cajón con la que abre el estilo del café. Sólo
 * lectura —monto fijo, lo prestado sin devolver, los movimientos recientes y
 * las verificaciones del custodio— más una sola acción: **reversar** un
 * movimiento equivocado mientras su turno sigue abierto. Todas las cifras
 * vienen del servidor. Con `cash.reserve` apagada no se dibuja.
 */
export function ReserveCard({ storeId }: { storeId: number }): React.JSX.Element | null {
  const { hasFeature } = useSession();
  const enabled = hasFeature("cash.reserve");
  const query = useQuery({
    queryKey: [...ADMIN_RESERVE_QUERY_KEY, storeId],
    queryFn: () => getAdminReserve(storeId),
    enabled,
  });

  if (!enabled) return null;
  if (query.isLoading) return <Cargando texto="Cargando la base de respaldo…" />;
  if (query.isError || !query.data) {
    return (
      <EmptyState
        reason="error"
        title="No se pudo cargar la base de respaldo"
        description={errorMessage(query.error)}
        action={{ label: "Reintentar", onClick: () => void query.refetch() }}
      />
    );
  }

  const r = query.data;
  const ultima = r.checks[0];
  return (
    <section aria-labelledby="base-respaldo-titulo" className="rounded-[12px] border bg-card p-3">
      <h2 id="base-respaldo-titulo" className="text-sm font-bold">
        Base de respaldo
      </h2>
      <p className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-sm">
        <span>
          Monto fijo <b className="tabular-nums">{formatCOP(r.amount)}</b>
        </span>
        <span>
          Prestado sin devolver{" "}
          <b className={r.loans_outstanding > 0 ? "text-destructive tabular-nums" : "tabular-nums"}>
            {formatCOP(r.loans_outstanding)}
          </b>
        </span>
        <span className="text-muted-foreground">
          {ultima
            ? `Última verificación: ${ultima.employee_name ?? "—"}, ${formatInstant(ultima.at)} · ${
                ultima.difference === 0 ? "cuadró" : `diferencia ${conSigno(ultima.difference ?? 0)}`
              }`
            : "Nadie la ha verificado todavía."}
        </span>
      </p>
      {r.amount <= 0 ? (
        <p className="mt-1 text-xs text-muted-foreground">Sin monto: se define en Ajustes › Caja.</p>
      ) : null}

      {r.open_loans.length > 0 ? (
        <ul className="mt-2 flex flex-wrap gap-1.5 text-xs">
          {r.open_loans.map((loan) => (
            <li key={loan.shift_id} className="rounded-full bg-destructive/10 px-2.5 py-1">
              <Link to={fichaTurnoHref(loan.shift_id)} className="text-primary hover:underline">
                Turno #{loan.shift_id}
              </Link>{" "}
              debe <b className="tabular-nums">{formatCOP(loan.amount)}</b>
              {loan.shift_open ? "" : " (turno cerrado)"}
            </li>
          ))}
        </ul>
      ) : null}

      <details className="mt-2">
        <summary className="cursor-pointer text-sm">Movimientos recientes ({r.movements.length})</summary>
        {r.movements.length === 0 ? (
          <p className="mt-1 text-sm text-muted-foreground">Nadie ha tomado ni devuelto plata de la base.</p>
        ) : (
          <ul className="mt-2 space-y-1.5">
            {r.movements.map((m) => (
              <MovementRow key={m.id} storeId={storeId} movement={m} />
            ))}
          </ul>
        )}
      </details>
    </section>
  );
}

function MovementRow({ storeId, movement: m }: { storeId: number; movement: AdminReserveMovement }): React.JSX.Element {
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: (reason: string) => reverseReserveMovement(storeId, m.id, { reason }),
    onSuccess: () => {
      toast.success("Movimiento reversado. Los dos quedan en el libro de la base.");
      void queryClient.invalidateQueries({ queryKey: ADMIN_RESERVE_QUERY_KEY });
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  const reversado = Boolean(m.reversed_at);
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
      <span className="text-muted-foreground tabular-nums">{formatInstant(m.at)}</span>
      <span className={reversado ? "line-through" : undefined}>
        {KIND_LABEL[m.kind ?? ""] ?? m.kind} <b className="tabular-nums">{formatCOP(m.amount ?? null)}</b>
      </span>
      <span>{m.employee_name}</span>
      {m.authorized_by_employee_name ? (
        <span className="text-muted-foreground">autorizó {m.authorized_by_employee_name}</span>
      ) : null}
      {m.shift_id ? (
        <Link to={fichaTurnoHref(m.shift_id)} className="text-primary hover:underline">
          Turno #{m.shift_id}
        </Link>
      ) : null}
      {reversado ? (
        <span className="text-muted-foreground">Reversado: {m.reversed_reason}</span>
      ) : m.shift_open ? (
        <ReasonRescueButton
          label="Reversar"
          title="Reversar este movimiento de la base"
          description="El movimiento no se borra: queda reversado con tu nombre y el motivo, al lado del original."
          disabled={mutation.isPending}
          onConfirm={(reason) => mutation.mutate(reason)}
        />
      ) : null}
    </li>
  );
}
