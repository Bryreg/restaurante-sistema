import { useQuery } from "@tanstack/react-query";

import { getOpeningInfo } from "@/api/shifts";
import { EmptyState } from "@/components/EmptyState";
import { errorMessage } from "@/lib/errors";

import { CashOpeningForm } from "./CashOpeningForm";
import { OPENING_INFO_QUERY_KEY } from "./hooks";
import { OpenShiftForm } from "./OpenShiftForm";

/**
 * Lo que ve quien puede manejar la caja cuando no hay turno abierto: el
 * cuadre de apertura. La regla la decide la SEDE en el servidor
 * (`GET /shifts/opening`): con `envelopes` el cajón abre con los días por
 * consignar que están en él, «igual al café» (decisión del dueño,
 * 2026-09-29: ve cuánto debería haber, cuenta el cajón entero y ve la
 * diferencia en vivo — `CashOpeningForm`); con `fixed_base`, la base fija
 * de siempre (`OpenShiftForm`).
 */
export function OpeningScreen(): React.JSX.Element {
  const query = useQuery({ queryKey: OPENING_INFO_QUERY_KEY, queryFn: getOpeningInfo });

  if (query.data?.mode === "envelopes") return <CashOpeningForm info={query.data} />;
  if (query.data) return <OpenShiftForm />;

  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <h1 className="text-lg font-semibold">Abrir turno</h1>
      {query.isError ? (
        <EmptyState
          role="alert"
          title="No se pudo consultar cómo abre la caja"
          description={errorMessage(query.error)}
          action={{ label: "Reintentar", onClick: () => void query.refetch() }}
        />
      ) : (
        <p className="text-sm text-muted-foreground">Consultando los días por consignar…</p>
      )}
    </div>
  );
}
