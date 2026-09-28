import type { Notification, NotificationLevel } from "@/api/notifications";
import { fichaInsumoHref, fichaTurnoHref } from "@/features/reports/fichas/rutas";

/**
 * **La vista de un aviso** (`/admin/avisos/:id`): a donde lleva tocar el aviso
 * en el celular (el servidor arma esa dirección en
 * `backend/app/notifications/push.py::admin_notice_url`) y a donde lleva
 * cada aviso de la campana.
 */
export function avisoHref(notificationId: number): string {
  return `/admin/avisos/${notificationId}`;
}

/** Lo que dice la gravedad, en palabras y con su tinta. */
export const NIVEL: Record<NotificationLevel, { palabra: string; tinta: string; franja: string }> = {
  critical: { palabra: "Crítico", tinta: "text-destructive", franja: "border-l-destructive" },
  warning: { palabra: "Atención", tinta: "text-warning", franja: "border-l-warning" },
  info: { palabra: "Informativo", tinta: "text-muted-foreground", franja: "border-l-border" },
};

/**
 * **Dónde se resuelve cada tipo de aviso**, nombrado en palabras (patrón 6:
 * «Caja › Dinero», nunca la consulta cruda). Es la acción primaria de la
 * vista del aviso: la vista no resuelve nada por su cuenta —marcarlo visto no
 * cierra un turno ni devuelve la base—, lleva a la pantalla donde cada acción
 * deja rastro y se reversa con motivo.
 *
 * Si el servidor mandó un `destino` más preciso (el `push_url` de quien
 * emitió el aviso), manda ése; esto es la red para los avisos que llegan
 * desde la campana o sin `push_url`.
 */
const DESTINO_POR_TIPO: Record<string, { to: string; donde: string }> = {
  shift_stale: { to: "/admin/dinero", donde: "Caja › Dinero" },
  cash_difference: { to: "/admin/dinero", donde: "Caja › Dinero" },
  cash_difference_critical: { to: "/admin/dinero", donde: "Caja › Dinero" },
  difference_streak: { to: "/admin/dinero", donde: "Caja › Dinero" },
  cash_over_threshold: { to: "/admin/dinero", donde: "Caja › Dinero" },
  reserve_loan_open: { to: "/admin/dinero", donde: "Caja › Dinero" },
  pending_refund: { to: "/admin/fiscal/devoluciones-pendientes", donde: "Caja › Devoluciones" },
  pin_locked: { to: "/admin/personal", donde: "Equipo › Turnos" },
  discount_rate_high: { to: "/admin/ventas", donde: "Informes › Ventas" },
  courtesy_limit: { to: "/admin/ventas", donde: "Informes › Ventas" },
  void_rate_high: { to: "/admin/ventas", donde: "Informes › Ventas" },
  order_unsent_too_long: { to: "/admin/pedidos", donde: "Hoy › Pedidos" },
  order_unpaid_too_long: { to: "/admin/pedidos", donde: "Hoy › Pedidos" },
  fiscal_rejected: { to: "/admin/fiscal/documentos", donde: "Informes › Documentos" },
  fiscal_contingency_overdue: { to: "/admin/fiscal/documentos", donde: "Informes › Documentos" },
  fiscal_range_low: { to: "/admin/fiscal/rangos", donde: "Ajustes › Rangos" },
  product_unavailable: { to: "/admin/carta", donde: "Carta" },
  product_discounts_nothing: { to: "/admin/carta", donde: "Carta" },
  prep_no_production: { to: "/admin/preparaciones", donde: "Carta › Preparaciones" },
  ingredient_below_min: { to: "/admin/inventario?tab=stock&below_min=1", donde: "Inventario › Stock" },
  ingredient_negative: { to: "/admin/inventario?tab=stock&negative=1", donde: "Inventario › Stock" },
  waste_spike: { to: "/admin/inventario?tab=movimientos", donde: "Inventario › Movimientos" },
  area_count_shortage: { to: "/admin/inventario?tab=por-area", donde: "Inventario › Conteo por área" },
};

const HOY = { to: "/admin/hoy", donde: "Hoy" };

/**
 * `destino` viene en la URL (lo arma el servidor, pero una URL la puede
 * escribir cualquiera): sólo se acepta un camino **del admin, en este mismo
 * origen**. Cualquier otra cosa —otro dominio, `//evil`, `javascript:`— se
 * ignora y manda el destino del tipo.
 */
export function destinoSeguro(raw: string | null): string | null {
  if (!raw) return null;
  if (!raw.startsWith("/admin/") && raw !== "/admin") return null;
  if (raw.startsWith("//") || raw.includes("\\")) return null;
  return raw;
}

/** La sección del aviso, que es lo primero de «Crítico · Caja». */
export function seccionDelAviso(type: string): string {
  const donde = (DESTINO_POR_TIPO[type] ?? HOY).donde;
  return donde.split(" › ")[0];
}

/** A dónde lleva «Resolver en…», y cómo se llama ese lugar. */
export function destinoDelAviso(
  notification: Pick<Notification, "type" | "payload">,
  destinoDeLaUrl: string | null,
): { to: string; donde: string } {
  const porTipo = DESTINO_POR_TIPO[notification.type] ?? HOY;
  const payload = notification.payload ?? {};
  // El conteo exacto, si el aviso lo trae: `?conteo=ID` abre su detalle.
  if (notification.type === "area_count_shortage" && typeof payload.count_id === "number") {
    return { to: `/admin/inventario?tab=por-area&conteo=${payload.count_id}`, donde: porTipo.donde };
  }
  const seguro = destinoSeguro(destinoDeLaUrl);
  return seguro ? { to: seguro, donde: porTipo.donde } : porTipo;
}

/**
 * Las fichas que el aviso nombra en su `payload` (el turno, el insumo): van
 * como enlaces al pie del detalle, igual que «Ficha del turno vie 26 sep» del
 * diseño. Sólo ids que el servidor mandó; nada se infiere del texto.
 */
export function fichasDelAviso(payload: Notification["payload"]): { to: string; label: string }[] {
  const fichas: { to: string; label: string }[] = [];
  if (!payload) return fichas;
  if (typeof payload.shift_id === "number") {
    fichas.push({ to: fichaTurnoHref(payload.shift_id), label: `Ficha del turno #${payload.shift_id}` });
  }
  if (typeof payload.ingredient_id === "number") {
    fichas.push({ to: fichaInsumoHref(payload.ingredient_id), label: "Ficha del insumo" });
  }
  return fichas;
}

/**
 * **La cifra del aviso, si el servidor la mandó.** Algunos avisos llevan en
 * su `payload` el monto que los disparó —lo que se debe a la base, la
 * diferencia del cierre, la devolución—. Se muestra tal cual llegó, con su
 * rótulo; el cliente no suma ni resta nada (AGENTS.md, «una sola matemática»).
 */
export function cifraDelAviso(payload: Notification["payload"]): { rotulo: string; valor: number } | null {
  if (!payload) return null;
  const candidatos: [string, string][] = [
    ["amount", "Monto"],
    ["owed", "Sin devolver a la base"],
    ["difference", "Diferencia"],
  ];
  for (const [clave, rotulo] of candidatos) {
    const crudo = payload[clave];
    const valor = typeof crudo === "number" ? crudo : typeof crudo === "string" ? Number(crudo) : Number.NaN;
    if (Number.isFinite(valor)) return { rotulo, valor };
  }
  return null;
}

/** La foto del comprobante, si el aviso la trae (`payload.photo_url`). */
export function fotoDelAviso(payload: Notification["payload"]): string | null {
  const url = payload?.photo_url;
  if (typeof url !== "string") return null;
  return url.startsWith("/") && !url.startsWith("//") ? url : null;
}
