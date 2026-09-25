/**
 * Solicitudes del salón al administrador (`pos.requests`). Este dominio no
 * tiene pantallas propias: aporta piezas que se montan en pantallas de otros.
 *
 * - `RequestsPanel` ({ shiftId }) — acción del panel del turno
 *   (`?accion=solicitudes`, flag `pos.requests`).
 * - `RequestsTray` ({ storeId }) — bandeja para Hoy.
 * - `ApprovedSuppliesPanel` ({ storeId }) — lo aprobado por comprar, para
 *   Inventario › Compras.
 */
export { ApprovedSuppliesPanel } from "./ApprovedSuppliesPanel";
export { RequestsPanel } from "./RequestsPanel";
export { RequestsTray } from "./RequestsTray";

export const requestsFeature = {};
