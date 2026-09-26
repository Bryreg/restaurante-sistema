import { useQuery } from "@tanstack/react-query";
import { Navigate } from "react-router-dom";

import { getCurrentShift } from "@/api/shifts";

import { inicioParaPuesto, puedeManejarCaja } from "./puesto";
import { useSession } from "./session";

/**
 * Ruta índice de `/pos` (CONTRATO-INTERNO-1b-1.md §6.2 y §7). **Inicio por
 * rol** (`inicioParaPuesto`): la caja llega a Turno, el salón a Mesas, la
 * cocina a los tiquetes de cocina y el bar a los tiquetes de su estación.
 * Sin puesto (o supervisor / admin), lo de siempre: con `pos.tables`
 * encendida el salón abre en el mapa de mesas; si no, directo en una comanda
 * nueva de mostrador (SPEC-NEGOCIO §9.1).
 *
 * Quien puede manejar la caja y llega sin turno abierto va primero al cuadre
 * de apertura (Turno): por eso, sólo para esa persona, se pregunta al
 * servidor si hay turno (`GET /shifts/current`, la misma clave que usa
 * Turno). Si la consulta falla, manda el puesto, como siempre.
 */
export default function PosHome(): React.JSX.Element | null {
  const { me, hasFeature } = useSession();
  const persona = me?.employee;
  const conCaja = puedeManejarCaja(persona, null);
  const turno = useQuery({ queryKey: ["shifts", "current"], queryFn: getCurrentShift, enabled: conCaja });
  if (conCaja && turno.isLoading) return null;
  const turnoAbierto = conCaja && turno.isSuccess ? turno.data !== null : null;
  return <Navigate to={inicioParaPuesto(persona, hasFeature, turnoAbierto)} replace />;
}
