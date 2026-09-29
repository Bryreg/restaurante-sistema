import { useSearchParams } from "react-router-dom";

import { useStoreSelection } from "@/app/storeContext";
import { Cargando } from "@/components/Cargando";
import { PageHeader } from "@/components/admin";

import { CuadresScreen } from "./CuadresScreen";
import { cuadresStatusFromParams } from "./lib";

/**
 * Admin → Caja › Dinero: **Cuadres**, la pantalla de turnos como la del café
 * (decisión del dueño, 2026-09-29). Reemplaza las pestañas Operacional e
 * Historial y el detalle del turno: una sola lista de tarjetas, filtrable
 * por estado y fechas, con los rescates en cada tarjeta. La ruta sigue
 * siendo `/admin/dinero`; `?tab=historial` abre los cerrados.
 */
export function MoneyAdminPage(): React.JSX.Element {
  const { activeStoreId, loading } = useStoreSelection();
  const [searchParams] = useSearchParams();

  if (loading) {
    return <Cargando texto="Cargando sedes…" className="p-4" />;
  }
  if (activeStoreId === null) {
    return <p className="p-4 text-sm text-muted-foreground">Todavía no hay sedes creadas.</p>;
  }

  return (
    <div className="space-y-4">
      <PageHeader
        name="Cuadres"
        question="Cuánto debería haber en el cajón en cada cuadre del turno —al abrir, en cada relevo y al cerrar—, cuánto había de verdad y quién respondió por la diferencia. Cada tarjeta trae el desglose, los movimientos de caja y los rescates de administrador: reabrir un cierre, cerrar un turno pendiente y ajustar la apertura."
      >
        <CuadresScreen
          key={activeStoreId}
          storeId={activeStoreId}
          initialStatus={cuadresStatusFromParams(searchParams)}
        />
      </PageHeader>
    </div>
  );
}
