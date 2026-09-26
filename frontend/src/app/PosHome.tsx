import { Navigate } from "react-router-dom";

import { inicioParaPuesto } from "./puesto";
import { useSession } from "./session";

/**
 * Ruta índice de `/pos` (CONTRATO-INTERNO-1b-1.md §6.2 y §7). **Inicio por
 * rol** (`inicioParaPuesto`): la caja llega a Turno, el salón a Mesas, la
 * cocina a los tiquetes de cocina y el bar a los tiquetes de su estación.
 * Sin puesto (o supervisor / admin), lo de siempre: con `pos.tables`
 * encendida el salón abre en el mapa de mesas; si no, directo en una comanda
 * nueva de mostrador (SPEC-NEGOCIO §9.1).
 */
export default function PosHome(): React.JSX.Element {
  const { me, hasFeature } = useSession();
  return <Navigate to={inicioParaPuesto(me?.employee, hasFeature)} replace />;
}
