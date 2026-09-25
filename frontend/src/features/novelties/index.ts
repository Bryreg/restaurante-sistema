/**
 * Novedades del turno (`pos.novelties`). Este dominio no tiene pantallas
 * propias: aporta piezas que se montan en pantallas de otros.
 *
 * - `NoveltiesPanel` (sin props) — acción del panel del turno
 *   (`?accion=novedades`, flag `pos.novelties`). Funciona también sin turno
 *   abierto.
 * - `NoveltiesTray` ({ storeId }) — bandeja de abiertas para Hoy, urgentes
 *   primero, con «Resolver».
 * - `NoveltiesHistory` ({ storeId }) — histórico con filtros y CSV, para
 *   Equipo (o donde el admin revise el día a día de la sede).
 */
export { NoveltiesHistory } from "./NoveltiesHistory"
export { NoveltiesPanel } from "./NoveltiesPanel"
export { NoveltiesTray } from "./NoveltiesTray"

export const noveltiesFeature = {}
