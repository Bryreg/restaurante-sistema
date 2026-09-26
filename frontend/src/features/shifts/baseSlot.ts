import type { ComponentType } from "react";

import type { ShiftCurrent } from "@/api/shifts";

import { ReturnToReservePanel, TakeFromReservePanel, VerifyReservePanel } from "./ReservePanels";

/**
 * ─── HUECO PARA LA «BASE DE RESPALDO» ───────────────────────────────────────
 *
 * La cinta de caja de Mesas (`CashRibbon`) y el panel del turno (`ShiftPage`)
 * ya saben dibujar «Tomar de la base» y «Devolver a la base» — rótulos,
 * lugar en «Más», botón «del momento» y hoja —, pero sus paneles los
 * construye otro trabajo en paralelo (apertura con cuadre y base de
 * respaldo). Mientras `tomar` y `devolver` sean `null`, ninguna de las dos
 * acciones existe: no aparecen, y `?accion=base_tomar` no abre nada.
 *
 * Para enchufarlas al integrar, sólo se toca ESTE archivo:
 *
 * ```ts
 * import { TakeFromBaseSheet } from "./TakeFromBaseSheet";
 * import { ReturnToBaseSheet } from "./ReturnToBaseSheet";
 * export const BASE_SLOT: BaseSlot = {
 *   flag: "cash.reserve",            // o la función que la base declare
 *   tomar: TakeFromBaseSheet,
 *   devolver: ReturnToBaseSheet,
 *   debeDevolver: (shift) => …,      // un booleano que mande el servidor
 * };
 * ```
 *
 * `debeDevolver` enciende el botón «del momento» de la cinta con «Devolver a
 * la base». Tiene que leer un **dato del servidor** (un booleano o un
 * conteo en `GET /shifts/current`), nunca una resta hecha acá: una sola
 * matemática, en el backend.
 */
export interface BasePanelProps {
  shiftId: number;
  /** Cierra la hoja cuando el panel terminó (opcional para el panel). */
  onDone?: () => void;
}

export interface BaseSlot {
  /** La función de la sede que enciende la base de respaldo. */
  flag: string;
  tomar: ComponentType<BasePanelProps> | null;
  devolver: ComponentType<BasePanelProps> | null;
  /** ¿Hay que devolver a la base ahora? Sin panel de devolver no se consulta. */
  debeDevolver: (shift: ShiftCurrent) => boolean;
  /**
   * «Verificar base» del custodio (supervisor o admin), a ciegas. Opcional:
   * sólo lo ve quien puede manejar la caja, y el servidor rechaza a quien no
   * es custodio (`403 RESERVE_CUSTODIAN_REQUIRED`).
   */
  verificar?: ComponentType<{ onDone?: () => void }> | null;
}

/**
 * Enchufado (2026-09-26) con los paneles de la base de respaldo
 * (`ReservePanels.tsx`). `debeDevolver` lee `reserve_loan` de
 * `GET /shifts/current` —lo que el cajón le debe a la base, calculado por el
 * servidor; `null` con la función apagada— y sólo lo compara con cero.
 */
export const BASE_SLOT: BaseSlot = {
  flag: "cash.reserve",
  tomar: TakeFromReservePanel,
  devolver: ReturnToReservePanel,
  debeDevolver: (shift) => (shift.reserve_loan ?? 0) > 0,
  verificar: VerifyReservePanel,
};
