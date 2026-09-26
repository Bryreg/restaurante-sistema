import type { StaffRequest } from "@/api/requests";
import type { DeliveryPendingList, ShiftCurrent } from "@/api/shifts";

import type { Accion, ClaveAccion } from "./acciones";
import { BASE_SLOT } from "./baseSlot";

/**
 * La lógica de la cinta de caja de Mesas (`CashRibbon`), sin React, para
 * probarla sola (`__tests__/cinta.test.ts`).
 *
 * La cinta es **una sola fila**: tres acciones de todo el rato, un botón
 * «del momento» que cambia según lo que el turno pide ahora, y «Más» con el
 * resto. Todo sale de `accionesHabilitadas` — la misma lista del panel del
 * turno —, así que un flag apagado o una persona sin caja no ven en la cinta
 * nada que no verían en `/pos/turno`.
 */

/**
 * Las de todo el rato, en orden, con el rótulo que llevan en la cinta.
 * «Movimientos» se llama acá «Gasto / Ingreso»: es lo que el cajero busca
 * con el dedo (la hoja sigue diciendo qué es).
 */
const PRINCIPALES: ReadonlyArray<{ clave: ClaveAccion; label: string }> = [
  { clave: "domicilios", label: "Domicilios" },
  { clave: "cambio", label: "Cambio" },
  { clave: "movimientos", label: "Gasto / Ingreso" },
];

/** El orden de «Más»: lo de la plata primero, la rutina después, el cierre al final. */
const ORDEN_MAS: readonly ClaveAccion[] = [
  "retiros",
  "consignar",
  "base_tomar",
  "base_devolver",
  "relevo",
  "recibir",
  "solicitudes",
  "novedades",
  "entrada",
  "conteo",
  "cierre",
];

export interface Cinta {
  principales: Accion[];
  mas: Accion[];
}

/** Reparte las acciones habilitadas entre la fila y «Más». Una apagada no deja hueco. */
export function repartirCinta(habilitadas: readonly Accion[]): Cinta {
  const porClave = new Map(habilitadas.map((a) => [a.clave, a]));
  const principales: Accion[] = [];
  for (const { clave, label } of PRINCIPALES) {
    const accion = porClave.get(clave);
    if (accion) principales.push({ ...accion, label });
  }
  const mas: Accion[] = [];
  for (const clave of ORDEN_MAS) {
    const accion = porClave.get(clave);
    if (accion) mas.push(accion);
  }
  return { principales, mas };
}

export type TonoMomento = "alerta" | "aviso";

export interface Momento {
  /** La acción que abre. */
  clave: ClaveAccion;
  label: string;
  /** Una línea: por qué aparece. Va como descripción accesible del botón. */
  descripcion: string;
  tono: TonoMomento;
}

/** ¿Hay una sencilla aprobada esperando que quien tiene la caja la registre? */
export function haySencillaPorRecibir(solicitudes: readonly StaffRequest[] | undefined): boolean {
  return (solicitudes ?? []).some((r) => r.kind === "change" && r.status === "approved");
}

/** Cuántas solicitudes esperan algo de la caja (hoy: sencillas aprobadas por registrar). */
export function solicitudesPorAtender(solicitudes: readonly StaffRequest[] | undefined): number {
  return (solicitudes ?? []).filter((r) => r.kind === "change" && r.status === "approved").length;
}

/**
 * Cuántos domiciliarios tienen efectivo por liquidar. Es un **conteo de
 * personas** que manda el servidor, no una cifra: la cinta no muestra plata.
 */
export function domiciliariosPorLiquidar(pendientes: DeliveryPendingList | undefined): number {
  return (pendientes?.couriers ?? []).length;
}

/**
 * El botón «del momento»: el aviso más urgente del turno, convertido en la
 * acción que lo resuelve. `null` cuando no hay nada que pedir.
 *
 * Cada aviso sale de un **dato del servidor** —nunca de una cuenta hecha
 * acá— y sólo aparece si la acción que lo resuelve está habilitada para esta
 * persona (flag y caja). En orden:
 *
 * 1. «Turno abandonado» (`is_stale`: pasó la hora de corte) → Cierre.
 * 2. «Llegó la sencilla» (una solicitud de sencilla aprobada) → Solicitudes,
 *    donde se registra con el Cambio. Hay alguien esperando con la plata.
 * 3. «Retiro sugerido» (`cash_over_threshold`) → Retiros. El mismo aviso
 *    que da la barra de estado, que sabe si hay de más **sin decir cuánto**.
 * 4. «Devolver a la base» (hueco de la base de respaldo, `baseSlot.ts`) →
 *    su hoja, cuando esté enchufada.
 */
export function momentoDelTurno({
  shift,
  habilitadas,
  sencillaPorRecibir,
}: {
  shift: ShiftCurrent;
  habilitadas: readonly Accion[];
  sencillaPorRecibir: boolean;
}): Momento | null {
  const hay = (clave: ClaveAccion): boolean => habilitadas.some((a) => a.clave === clave);

  if (shift.is_stale && hay("cierre")) {
    return {
      clave: "cierre",
      label: "Turno abandonado",
      descripcion: "Pasó la hora de corte: cerrá la caja",
      tono: "alerta",
    };
  }
  if (sencillaPorRecibir && hay("solicitudes")) {
    return {
      clave: "solicitudes",
      label: "Llegó la sencilla",
      descripcion: "La sencilla que pediste está aprobada: registrala en el cajón",
      tono: "aviso",
    };
  }
  if (shift.cash_over_threshold && hay("retiros")) {
    return {
      clave: "retiros",
      label: "Retiro sugerido",
      descripcion: "El efectivo del cajón pasó el umbral de retiro",
      tono: "aviso",
    };
  }
  if (hay("base_devolver") && BASE_SLOT.debeDevolver(shift)) {
    return {
      clave: "base_devolver",
      label: "Devolver a la base",
      descripcion: "Reponé a la base de respaldo lo que se tomó",
      tono: "aviso",
    };
  }
  return null;
}
