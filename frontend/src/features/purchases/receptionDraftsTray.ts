/**
 * La tarjeta de la bandeja de Hoy para las recepciones registradas en el POS
 * que esperan precios. El número lo da el backend
 * (`app.purchases.hooks.pending_drafts_count`); acá sólo se arma el texto.
 * Misma forma que los demás avisos de `TodayPage` (`key`, `title`, `body`,
 * `why`, `to`, `ctaLabel`, `tone`, `screen`, `tab`), para empujarla tal cual
 * a su lista. `null` cuando no hay ninguna, o cuando el dato no llegó (la
 * función apagada no es «cero pendientes», pero tampoco hay nada que avisar).
 */
export interface ReceptionDraftsTrayItem {
  key: "reception-drafts-pending"
  title: string
  body: string
  why: { term: string; text: string }
  to: string
  ctaLabel: string
  tone: "warning"
  screen: string
  tab: string
}

export function receptionDraftsTrayItem(count: number | null | undefined): ReceptionDraftsTrayItem | null {
  if (count === null || count === undefined || count <= 0) return null
  return {
    key: "reception-drafts-pending",
    title: `${count} recepci${count === 1 ? "ón" : "ones"} del POS por completar`,
    body: "Llegó mercancía y falta ponerle precios; hasta entonces no suma al inventario.",
    why: {
      term: "Recepciones por completar",
      text: `El cajero registra lo que llegó con foto y sin precios; el administrador pone los costos y recién ahí entra el stock y nace la cuenta por pagar. Mientras tanto, el food cost no ve esa compra.`,
    },
    to: "/admin/compras?tab=recepciones",
    ctaLabel: "Completar en Compras",
    tone: "warning",
    screen: "Compras",
    tab: "Recepciones",
  }
}
