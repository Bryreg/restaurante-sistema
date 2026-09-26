import {
  ArrowRightLeft,
  Bike,
  ClipboardCheck,
  ClipboardList,
  Coins,
  Landmark,
  LockKeyhole,
  type LucideIcon,
  MessageSquareWarning,
  PackagePlus,
  PiggyBank,
  UserCheck,
  Users,
  Vault,
} from "lucide-react";

import { BASE_SLOT } from "./baseSlot";

/**
 * Las acciones del turno: **una sola lista** para las dos pantallas que las
 * abren — el panel del turno (`ShiftPage`, grilla de botones grandes) y la
 * cinta de caja de Mesas (`CashRibbon`). Antes vivían adentro de
 * `ShiftPage.tsx`; se sacaron acá (2026-09-26) para que la cinta no copiara
 * rótulos, flags ni la regla de quién ve qué.
 *
 * `clave` es la que va en `?accion=` (deep link, en `/pos/turno` y en
 * `/pos/mesas`); `flag` es la función opcional que la enciende — sin flag,
 * siempre está.
 */
export type ClaveAccion =
  | "entrada"
  | "movimientos"
  | "cambio"
  | "retiros"
  | "domicilios"
  | "consignar"
  | "relevo"
  | "recibir"
  | "solicitudes"
  | "novedades"
  | "conteo"
  | "cierre"
  // Hueco para la «base de respaldo» (ver `baseSlot.ts`): no dibujan nada
  // mientras su panel no esté enchufado.
  | "base_tomar"
  | "base_devolver";

export interface Accion {
  clave: ClaveAccion;
  label: string;
  descripcion: string;
  icono: LucideIcon;
  flag?: string;
}

/**
 * **Inicio por rol**: lo que toca la plata del cajón lo ve sólo quien puede
 * manejar la caja (`puedeManejarCaja`: permiso de cobrar, responsable de la
 * caja del turno, supervisor o admin). Entrada / Salida, Solicitudes,
 * Novedades y el conteo del área son de todos. El backend rechaza igual
 * (`403 CASH_PERMISSION_REQUIRED`): esconder el botón ordena la pantalla, no
 * es el control.
 */
export const ACCIONES_DE_TODOS: ReadonlySet<ClaveAccion> = new Set(["entrada", "solicitudes", "novedades", "conteo"]);

/** En el orden en que las dibuja la grilla del panel del turno. */
export const ACCIONES: readonly Accion[] = [
  {
    clave: "entrada",
    label: "Entrada / Salida",
    descripcion: "Entrar, salir o pausar con tu PIN",
    icono: UserCheck,
  },
  { clave: "movimientos", label: "Movimientos", descripcion: "Ingreso o egreso de efectivo", icono: ArrowRightLeft },
  {
    clave: "cambio",
    label: "Cambio",
    descripcion: "Cambiar billetes por sencilla",
    icono: Coins,
    flag: "cash.swaps",
  },
  {
    clave: "retiros",
    label: "Retiros",
    descripcion: "Sacar efectivo del cajón a sobre",
    icono: PiggyBank,
    flag: "cash.pickups",
  },
  {
    clave: "domicilios",
    label: "Domicilios",
    descripcion: "Liquidar el efectivo de los domiciliarios",
    icono: Bike,
    flag: "pos.delivery",
  },
  {
    // Consignar desde el POS (2026-09-24): la plata de días anteriores que
    // está en el cajón. El turno está abierto si se llegó hasta acá.
    clave: "consignar",
    label: "Consignar",
    descripcion: "Llevar al banco la plata de días anteriores",
    icono: Landmark,
    flag: "money.deposits",
  },
  {
    clave: "relevo",
    label: "Relevo",
    descripcion: "Entregar la caja o hacer un arqueo sorpresa",
    icono: Users,
    flag: "cash.handovers",
  },
  // La rutina del turno (2026-09-25): lo que en café-sistema hace el barista
  // desde su dock — recibir, pedir y dejar novedades.
  {
    clave: "recibir",
    label: "Recibir mercancía",
    descripcion: "Registrar lo que trajo un proveedor, con foto",
    icono: PackagePlus,
    flag: "purchases",
  },
  {
    clave: "solicitudes",
    label: "Solicitudes",
    descripcion: "Pedir insumos o sencilla al administrador",
    icono: ClipboardList,
    flag: "pos.requests",
  },
  {
    clave: "novedades",
    label: "Novedades",
    descripcion: "Dejar dicho lo que pasó para el que sigue",
    icono: MessageSquareWarning,
    flag: "pos.novelties",
  },
  // Conteo corto por área (2026-09-25): cada área cuenta sus artículos clave
  // al abrir y al cerrar, a ciegas. No bloquea el cierre de caja.
  {
    clave: "conteo",
    label: "Conteo de mi área",
    descripcion: "Contar los artículos clave al abrir o al cerrar",
    icono: ClipboardCheck,
    flag: "inventory.shift_counts",
  },
];

/** El cierre, aparte de la grilla pero con la misma forma, para el deep link y la hoja. */
export const CIERRE: Accion = {
  clave: "cierre",
  label: "Cierre",
  descripcion: "Contar el cajón y cerrar la caja",
  icono: LockKeyhole,
};

/**
 * Las dos acciones de la base de respaldo. Sólo existen si su panel está
 * enchufado en `BASE_SLOT` (el agente de la base lo hace al integrar) y la
 * función de la sede está encendida; mientras tanto no aparecen en ningún
 * lado, ni por `?accion=`.
 */
export const BASE_TOMAR: Accion = {
  clave: "base_tomar",
  label: "Tomar de la base",
  descripcion: "Sacar efectivo de la base de respaldo al cajón",
  icono: Vault,
  flag: BASE_SLOT.flag,
};

export const BASE_DEVOLVER: Accion = {
  clave: "base_devolver",
  label: "Devolver a la base",
  descripcion: "Reponer a la base de respaldo lo que se tomó",
  icono: Vault,
  flag: BASE_SLOT.flag,
};

/** Las de la base que hoy tienen panel (vacío hasta que el agente de la base las enchufe). */
export function accionesDeBase(): Accion[] {
  const out: Accion[] = [];
  if (BASE_SLOT.tomar) out.push(BASE_TOMAR);
  if (BASE_SLOT.devolver) out.push(BASE_DEVOLVER);
  return out;
}

export interface FiltroAcciones {
  hasFeature: (key: string) => boolean;
  /** `puedeManejarCaja(persona, responsable)`. */
  conCaja: boolean;
  /** El servidor dijo que la persona no es de ningún área: sin «Conteo de mi área». */
  sinArea?: boolean;
}

/**
 * Las acciones que esta persona puede abrir, en orden: las de la grilla,
 * las de la base (si están enchufadas) y, con caja, el cierre. Es la lista
 * contra la que se resuelve `?accion=`: una clave desconocida, apagada por
 * flag o de caja sin caja no abre nada.
 */
export function accionesHabilitadas({ hasFeature, conCaja, sinArea = false }: FiltroAcciones): Accion[] {
  const grilla = [...ACCIONES, ...accionesDeBase()].filter(
    (a) =>
      (!a.flag || hasFeature(a.flag)) &&
      (conCaja || ACCIONES_DE_TODOS.has(a.clave)) &&
      !(a.clave === "conteo" && sinArea),
  );
  return conCaja ? [...grilla, CIERRE] : grilla;
}
