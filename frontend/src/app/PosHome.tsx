import { Navigate } from "react-router-dom";

import { useSession } from "./session";

/**
 * Ruta índice de `/pos` (CONTRATO-INTERNO-1b-1.md §6.2 y §7): con
 * `pos.tables` encendida el salón abre en el mapa de mesas; si no, directo
 * en una comanda nueva de mostrador (mostrador: crear → enviar si hay
 * cocina → cobrar en un solo flujo, SPEC-NEGOCIO §9.1).
 */
export default function PosHome(): React.JSX.Element {
  const { hasFeature } = useSession();
  return hasFeature("pos.tables") ? (
    <Navigate to="/pos/mesas" replace />
  ) : (
    <Navigate to="/pos/comanda/nueva" replace />
  );
}
