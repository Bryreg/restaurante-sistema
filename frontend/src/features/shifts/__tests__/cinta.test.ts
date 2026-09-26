import { describe, expect, it } from "vitest";

import type { StaffRequest } from "@/api/requests";
import type { ShiftCurrent } from "@/api/shifts";

import { accionesHabilitadas } from "../acciones";
import {
  domiciliariosPorLiquidar,
  haySencillaPorRecibir,
  momentoDelTurno,
  repartirCinta,
  solicitudesPorAtender,
} from "../cinta";

/**
 * La lógica de la cinta de caja, sin pantalla: qué va en la fila, qué va en
 * «Más» y cuál es el botón «del momento».
 */

const TODAS = new Set([
  "cash.swaps",
  "cash.pickups",
  "pos.delivery",
  "money.deposits",
  "cash.handovers",
  "purchases",
  "pos.requests",
  "pos.novelties",
  "inventory.shift_counts",
]);
const todas = (key: string) => TODAS.has(key);
const ninguna = () => false;

const SHIFT: ShiftCurrent = { id: 7, cash_responsible: { id: 1, name: "Ana" }, is_stale: false, cash_over_threshold: false };

function sencilla(status: StaffRequest["status"]): StaffRequest {
  return { kind: "change", status } as StaffRequest;
}

describe("repartirCinta", () => {
  it("con todo encendido: tres en la fila y el resto en «Más», con el cierre al final", () => {
    const { principales, mas } = repartirCinta(accionesHabilitadas({ hasFeature: todas, conCaja: true }));

    expect(principales.map((a) => a.label)).toEqual(["Domicilios", "Cambio", "Gasto / Ingreso"]);
    expect(mas.map((a) => a.label)).toEqual([
      "Retiros",
      "Consignar",
      "Relevo",
      "Recibir mercancía",
      "Solicitudes",
      "Novedades",
      "Entrada / Salida",
      "Conteo de mi área",
      "Cierre",
    ]);
  });

  it("una función apagada no deja hueco: sin domicilios ni cambio, la fila es sólo Gasto / Ingreso", () => {
    const { principales, mas } = repartirCinta(accionesHabilitadas({ hasFeature: ninguna, conCaja: true }));

    expect(principales.map((a) => a.label)).toEqual(["Gasto / Ingreso"]);
    expect(mas.map((a) => a.label)).toEqual(["Entrada / Salida", "Cierre"]);
  });

  it("«Gasto / Ingreso» abre la misma acción que «Movimientos» en el turno", () => {
    const { principales } = repartirCinta(accionesHabilitadas({ hasFeature: todas, conCaja: true }));
    expect(principales.find((a) => a.label === "Gasto / Ingreso")?.clave).toBe("movimientos");
  });
});

describe("momentoDelTurno", () => {
  const habilitadas = accionesHabilitadas({ hasFeature: todas, conCaja: true });

  it("sin avisos no hay botón del momento", () => {
    expect(momentoDelTurno({ shift: SHIFT, habilitadas, sencillaPorRecibir: false })).toBeNull();
  });

  it("efectivo sobre el umbral → «Retiro sugerido», que abre Retiros", () => {
    const m = momentoDelTurno({ shift: { ...SHIFT, cash_over_threshold: true }, habilitadas, sencillaPorRecibir: false });
    expect(m).toMatchObject({ label: "Retiro sugerido", clave: "retiros" });
  });

  it("una sencilla aprobada → «Llegó la sencilla», que abre Solicitudes, y gana sobre el retiro", () => {
    const m = momentoDelTurno({ shift: { ...SHIFT, cash_over_threshold: true }, habilitadas, sencillaPorRecibir: true });
    expect(m).toMatchObject({ label: "Llegó la sencilla", clave: "solicitudes" });
  });

  it("turno abandonado gana sobre todo y abre el cierre", () => {
    const m = momentoDelTurno({
      shift: { ...SHIFT, is_stale: true, cash_over_threshold: true },
      habilitadas,
      sencillaPorRecibir: true,
    });
    expect(m).toMatchObject({ label: "Turno abandonado", clave: "cierre", tono: "alerta" });
  });

  it("un aviso cuya acción está apagada no aparece (sin cash.pickups no hay «Retiro sugerido»)", () => {
    const sinRetiros = accionesHabilitadas({ hasFeature: (k) => k !== "cash.pickups" && todas(k), conCaja: true });
    expect(
      momentoDelTurno({ shift: { ...SHIFT, cash_over_threshold: true }, habilitadas: sinRetiros, sencillaPorRecibir: false }),
    ).toBeNull();
  });

  it("sin el panel de la base enchufado, nunca pide «Devolver a la base»", () => {
    expect(habilitadas.some((a) => a.clave === "base_devolver")).toBe(false);
  });
});

describe("contadores (de cosas, nunca de plata)", () => {
  it("sencillas por recibir: sólo las de cambio aprobadas", () => {
    const rows = [sencilla("approved"), sencilla("pending"), sencilla("received"), { kind: "supply", status: "approved" } as StaffRequest];
    expect(haySencillaPorRecibir(rows)).toBe(true);
    expect(solicitudesPorAtender(rows)).toBe(1);
    expect(haySencillaPorRecibir(undefined)).toBe(false);
  });

  it("domicilios: cuántos domiciliarios tienen efectivo por liquidar", () => {
    expect(domiciliariosPorLiquidar({ couriers: [{ courier_employee_id: 1 }, { courier_employee_id: 2 }] })).toBe(2);
    expect(domiciliariosPorLiquidar(undefined)).toBe(0);
  });
});
