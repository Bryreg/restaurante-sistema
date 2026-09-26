import type { Puesto } from "@/api/auth";

import type { NavItem } from "./nav";

/**
 * **Inicio por rol**: el puesto de la persona identificada (`employees.puesto`,
 * migración 0027) decide a qué pantalla llega al teclear el PIN y qué
 * destinos ve en la barra del salón. Funciones puras, sin React, para que se
 * prueben solas (`__tests__/puesto.test.ts`).
 *
 * - `null` (o un supervisor) ve todo, como siempre. El supervisor llega a
 *   Turno; el administrador sólo autoriza (`soloAutoriza`).
 * - Una función apagada sigue sacando su entrada (`feature`): el puesto
 *   filtra DESPUÉS de los flags, nunca los reemplaza.
 * - Nada de esto es un permiso: la barra ordena la pantalla. Lo que no se
 *   puede hacer lo rechaza el backend (`403 CASH_PERMISSION_REQUIRED`).
 */
export type { Puesto };

export const PUESTO_LABEL: Record<Puesto, string> = {
  caja: "Caja",
  salon: "Salón",
  cocina: "Cocina",
  bar: "Bar",
};

/** Lo mínimo de la persona identificada que miran estas funciones. */
export interface PersonaPuesto {
  role?: string | null;
  puesto?: string | null;
  can_charge?: boolean | null;
}


/**
 * Los destinos de cada puesto, en el orden en que se dibujan (cinco como
 * máximo). «Cocina» (`/pos/cocina`, la vista de sólo lectura) aparece en el
 * de cocina como respaldo del KDS: si `kitchen.kds` está apagada, esa es la
 * pantalla de la cocina.
 */
const DESTINOS: Record<Puesto, readonly string[]> = {
  salon: ["/pos/mesas", "/pos/mostrador", "/pos/comanda/nueva", "/pos/turno"],
  caja: ["/pos/mesas", "/pos/mostrador", "/pos/comanda/nueva", "/pos/turno", "/pos/cocina"],
  cocina: ["/pos/kds", "/pos/conteo", "/pos/cocina", "/pos/produccion", "/pos/merma", "/pos/turno"],
  bar: ["/pos/kds", "/pos/conteo", "/pos/cocina", "/pos/produccion", "/pos/merma", "/pos/turno"],
};

function esPuesto(value: string | null | undefined): value is Puesto {
  return value === "caja" || value === "salon" || value === "cocina" || value === "bar";
}

/**
 * **El administrador en la tablet sólo autoriza** (decisión del dueño): no
 * opera el salón, no suma horas ni propina. Si teclea su PIN en «Quién
 * opera» llega a «Modo autorización» (`/pos/autorizar`) y la barra queda
 * vacía; autoriza desde la pantalla de quien opera, cuando ésta le pide el
 * PIN. El backend no lo mete al roster ni a la asistencia.
 */
export const RUTA_AUTORIZAR = "/pos/autorizar";

export function soloAutoriza(persona: PersonaPuesto | null | undefined): boolean {
  return persona?.role === "admin";
}

/** El puesto que manda, o `null` si la persona ve todo (sin puesto, supervisor o admin). */
export function puestoEfectivo(persona: PersonaPuesto | null | undefined): Puesto | null {
  if (!persona) return null;
  if (persona.role === "supervisor" || persona.role === "admin") return null;
  return esPuesto(persona.puesto) ? persona.puesto : null;
}

/**
 * La barra del salón para esta persona. `items` llega ya filtrado por flags
 * y ordenado; con un puesto se queda sólo con sus destinos, en el orden del
 * puesto. Cocina y bar llegan al mismo KDS: la estación la recuerda el
 * KDS por su cuenta (cada tablet la suya).
 */
export function navParaPuesto(items: readonly NavItem[], persona: PersonaPuesto | null | undefined): NavItem[] {
  const puesto = puestoEfectivo(persona);
  if (puesto === null) return [...items];
  const destinos = DESTINOS[puesto];
  return items
    .filter((item) => destinos.includes(item.to))
    .sort((a, b) => destinos.indexOf(a.to) - destinos.indexOf(b.to));
}

/**
 * A dónde llega la persona al identificarse, cuando no venía de ninguna
 * pantalla. Sin puesto, lo de siempre: Mesas con `pos.tables`, si no una
 * comanda de mostrador.
 *
 * Cocina y bar pasan primero por **Conteo** cuando el conteo por área está
 * encendido (decisión 5: la apertura del área es obligatoria). La pantalla
 * de conteo (`?inicio=1`) pregunta al servidor si a esta persona le falta la
 * apertura y, si no, sigue sola al KDS: la función es sincrónica y no sabe
 * si ya se contó. `sinConteo` es ese «siguiente» (lo usa la pantalla de
 * conteo para saber a dónde seguir).
 */
export function inicioParaPuesto(
  persona: PersonaPuesto | null | undefined,
  hasFeature: (key: string) => boolean,
  opciones: { sinConteo?: boolean } = {},
): string {
  const venta = hasFeature("pos.tables") ? "/pos/mesas" : "/pos/comanda/nueva";
  if (soloAutoriza(persona)) return RUTA_AUTORIZAR;
  // Modo supervisor: llega a Turno, donde están sus herramientas (abrir,
  // base, retiros, salidas de otros). Mesas sigue en su barra.
  if (persona?.role === "supervisor") return "/pos/turno";
  const puesto = puestoEfectivo(persona);
  switch (puesto) {
    case "caja":
      return "/pos/turno";
    case "salon":
      return venta;
    case "cocina":
    case "bar":
      if (!opciones.sinConteo && hasFeature("inventory.perpetual") && hasFeature("inventory.shift_counts")) {
        return "/pos/conteo?inicio=1";
      }
      if (hasFeature("kitchen.kds")) return "/pos/kds";
      if (hasFeature("kitchen.view")) return "/pos/cocina";
      return "/pos/turno";
    default:
      return venta;
  }
}

/**
 * La ruta a la que se vuelve después de identificarse (`?next=`): sólo una
 * pantalla del salón, nunca la de identificarse ni una dirección de afuera.
 */
export function destinoSeguro(next: string | null | undefined): string | null {
  if (!next) return null;
  if (!next.startsWith("/pos/") || next.startsWith("//")) return null;
  if (next.startsWith("/pos/identify") || next.startsWith("/pos/activate")) return null;
  return next;
}

/** La ruta de identificarse que vuelve a `desde` (ruta + búsqueda) después del PIN. */
export function rutaIdentificarse(desde: string | null | undefined): string {
  const seguro = destinoSeguro(desde);
  return seguro ? `/pos/identify?next=${encodeURIComponent(seguro)}` : "/pos/identify";
}

/** Quién puede tocar la caja: la misma regla que `app.shifts.hooks.can_handle_cash`. */
export function puedeManejarCaja(
  persona: (PersonaPuesto & { id?: number | null }) | null | undefined,
  responsableId: number | null | undefined,
): boolean {
  if (!persona) return false;
  if (persona.role === "supervisor" || persona.role === "admin") return true;
  if (persona.can_charge) return true;
  return persona.id != null && responsableId != null && persona.id === responsableId;
}

const GROUP_RANK: Record<NonNullable<NavItem["posGroup"]>, number> = { venta: 0, caja: 1, cocina: 2 };

/**
 * La barra del salón completa para quien se identificó: sin persona no hay
 * entradas; una función apagada no deja hueco; sin puesto se ordena venta →
 * caja → cocina (cada tramo en el orden de los manifiestos) y con puesto
 * quedan sólo sus destinos (`navParaPuesto`).
 */
export function barraDelSalon(
  all: readonly NavItem[],
  hasFeature: (key: string) => boolean,
  persona: PersonaPuesto | null | undefined,
): NavItem[] {
  if (!persona) return [];
  if (soloAutoriza(persona)) return [];
  const conFlags = all
    .filter((item) => !item.feature || hasFeature(item.feature))
    .filter((item) => !item.hiddenWithFeature || !hasFeature(item.hiddenWithFeature))
    .map((item, index) => ({ item, index }))
    .sort((a, b) => GROUP_RANK[a.item.posGroup ?? "venta"] - GROUP_RANK[b.item.posGroup ?? "venta"] || a.index - b.index)
    .map(({ item }) => item);
  return navParaPuesto(conFlags, persona);
}

/**
 * Cuántas entradas caben a la vista; las demás van a «Más». `anchos` son los
 * anchos medidos de cada entrada; `disponible`, el ancho de la barra; `mas`,
 * el del botón «Más». Si no se pudo medir (`disponible <= 0`, p. ej. en un
 * test sin layout) se ven todas: esconder sin saber es peor que desbordar.
 */
export function cuantasCaben(anchos: readonly number[], disponible: number, mas: number, gap = 8): number {
  if (disponible <= 0 || anchos.length === 0) return anchos.length;
  const total = anchos.reduce((acc, w) => acc + w, 0) + gap * Math.max(0, anchos.length - 1);
  if (total <= disponible) return anchos.length;
  let usado = mas;
  let caben = 0;
  for (const ancho of anchos) {
    const siguiente = usado + gap + ancho;
    if (siguiente > disponible) break;
    usado = siguiente;
    caben += 1;
  }
  return caben;
}
