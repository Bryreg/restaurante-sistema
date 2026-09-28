import type { SectionKey } from "@/api/panel"

/**
 * Caja, Equipo e Informes en el celular (handoff, `MovilSecciones`, variante
 * A). Son pantallas propias del celular, no una versión angosta de las del
 * escritorio: cuatro preguntas por sección, cada una con su tarjeta. La barra
 * inferior del celular (`app/AdminLayout.tsx`) lleva acá; en el escritorio
 * estas rutas mandan a la primera pantalla de la sección.
 */
export const RUTA_CELULAR: Record<SectionKey, string> = {
  caja: "/admin/celular/caja",
  equipo: "/admin/celular/equipo",
  informes: "/admin/celular/informes",
}
