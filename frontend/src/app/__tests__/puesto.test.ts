// @vitest-environment node
import { describe, expect, it } from "vitest";

import type { NavItem } from "../nav";
import {
  barraDelSalon,
  cuantasCaben,
  destinoSeguro,
  inicioParaPuesto,
  navParaPuesto,
  puedeManejarCaja,
  puestoEfectivo,
  rutaIdentificarse,
} from "../puesto";

/** Los manifiestos reales, en el orden en que `PosLayout` los concatena. */
const TODAS: NavItem[] = [
  { to: "/pos/mesas", label: "Mesas", feature: "pos.tables" },
  { to: "/pos/comanda/nueva", label: "Mostrador" },
  { to: "/pos/cocina", label: "Cocina", feature: "kitchen.view", posGroup: "cocina" },
  { to: "/pos/turno", label: "Turno", posGroup: "caja" },
  { to: "/pos/kds", label: "Tiquetes de cocina", feature: "kitchen.kds", posGroup: "cocina" },
  { to: "/pos/produccion", label: "Producción", feature: "catalog.preps", posGroup: "cocina" },
  { to: "/pos/merma", label: "Merma", feature: "inventory.waste", posGroup: "cocina" },
];

const TODO_ENCENDIDO = new Set(["pos.tables", "kitchen.view", "kitchen.kds", "catalog.preps", "inventory.waste"]);
const todo = (key: string) => TODO_ENCENDIDO.has(key);
const nada = () => false;

const rotulos = (items: NavItem[]) => items.map((i) => i.label);

describe("puestoEfectivo", () => {
  it("sin puesto, o supervisor / admin, ve todo (null)", () => {
    expect(puestoEfectivo({ role: "operator", puesto: null })).toBeNull();
    expect(puestoEfectivo({ role: "supervisor", puesto: "cocina" })).toBeNull();
    expect(puestoEfectivo({ role: "admin", puesto: "salon" })).toBeNull();
    expect(puestoEfectivo(null)).toBeNull();
  });

  it("un valor desconocido no inventa un puesto", () => {
    expect(puestoEfectivo({ role: "operator", puesto: "gerencia" })).toBeNull();
    expect(puestoEfectivo({ role: "operator", puesto: "bar" })).toBe("bar");
  });
});

describe("barraDelSalon — cinco destinos como máximo, según el puesto", () => {
  it("sin persona no hay entradas", () => {
    expect(barraDelSalon(TODAS, todo, null)).toEqual([]);
  });

  it("sin puesto: la barra completa de siempre, venta → caja → cocina", () => {
    expect(rotulos(barraDelSalon(TODAS, todo, { role: "operator" }))).toEqual([
      "Mesas",
      "Mostrador",
      "Turno",
      "Cocina",
      "Tiquetes de cocina",
      "Producción",
      "Merma",
    ]);
  });

  it("supervisor con puesto igual ve todo", () => {
    expect(barraDelSalon(TODAS, todo, { role: "supervisor", puesto: "salon" })).toHaveLength(7);
  });

  it("salón: Mesas, Mostrador y Turno", () => {
    expect(rotulos(barraDelSalon(TODAS, todo, { role: "operator", puesto: "salon" }))).toEqual([
      "Mesas",
      "Mostrador",
      "Turno",
    ]);
  });

  it("caja: Mesas, Mostrador, Turno y la vista de Cocina", () => {
    expect(rotulos(barraDelSalon(TODAS, todo, { role: "operator", puesto: "caja" }))).toEqual([
      "Mesas",
      "Mostrador",
      "Turno",
      "Cocina",
    ]);
  });

  it("cocina: los tiquetes primero, y Turno al final", () => {
    const barra = barraDelSalon(TODAS, todo, { role: "operator", puesto: "cocina" });
    expect(rotulos(barra)).toEqual(["Tiquetes de cocina", "Cocina", "Producción", "Merma", "Turno"]);
    expect(barra.length).toBeLessThanOrEqual(5);
  });

  it("bar: los tiquetes primero (el KDS recuerda su estación por su cuenta)", () => {
    const barra = barraDelSalon(TODAS, todo, { role: "operator", puesto: "bar" });
    expect(barra[0]).toMatchObject({ label: "Tiquetes de cocina", to: "/pos/kds" });
  });

  it("hiddenWithFeature: una entrada se va cuando otra función la reemplaza", () => {
    const conReemplazo: NavItem[] = TODAS.map((i) =>
      i.to === "/pos/cocina" ? { ...i, hiddenWithFeature: "kitchen.kds" } : i,
    );
    expect(rotulos(barraDelSalon(conReemplazo, todo, { role: "operator", puesto: "cocina" }))).toEqual([
      "Tiquetes de cocina",
      "Producción",
      "Merma",
      "Turno",
    ]);
  });

  it("los flags siguen mandando: con todo apagado la cocina sólo ve Turno", () => {
    expect(rotulos(barraDelSalon(TODAS, nada, { role: "operator", puesto: "cocina" }))).toEqual(["Turno"]);
    expect(rotulos(barraDelSalon(TODAS, nada, { role: "operator", puesto: "salon" }))).toEqual([
      "Mostrador",
      "Turno",
    ]);
  });

  it("navParaPuesto no toca la lista cuando la persona ve todo", () => {
    expect(navParaPuesto(TODAS, { role: "admin" })).toEqual(TODAS);
  });
});

describe("inicioParaPuesto — a dónde llega después del PIN", () => {
  it("caja → Turno; salón → Mesas (o Mostrador sin mesas)", () => {
    expect(inicioParaPuesto({ role: "operator", puesto: "caja" }, todo)).toBe("/pos/turno");
    expect(inicioParaPuesto({ role: "operator", puesto: "salon" }, todo)).toBe("/pos/mesas");
    expect(inicioParaPuesto({ role: "operator", puesto: "salon" }, nada)).toBe("/pos/comanda/nueva");
  });

  it("cocina y bar → KDS; sin KDS, la vista de cocina; sin nada, Turno", () => {
    expect(inicioParaPuesto({ role: "operator", puesto: "cocina" }, todo)).toBe("/pos/kds");
    expect(inicioParaPuesto({ role: "operator", puesto: "bar" }, todo)).toBe("/pos/kds");
    expect(inicioParaPuesto({ role: "operator", puesto: "cocina" }, (k) => k === "kitchen.view")).toBe("/pos/cocina");
    expect(inicioParaPuesto({ role: "operator", puesto: "bar" }, nada)).toBe("/pos/turno");
  });

  it("sin puesto o supervisor: lo de siempre", () => {
    expect(inicioParaPuesto({ role: "operator" }, todo)).toBe("/pos/mesas");
    expect(inicioParaPuesto({ role: "supervisor", puesto: "caja" }, nada)).toBe("/pos/comanda/nueva");
  });
});

describe("volver a donde se estaba (?next=)", () => {
  it("acepta sólo pantallas del salón", () => {
    expect(destinoSeguro("/pos/kds?station=bar")).toBe("/pos/kds?station=bar");
    expect(destinoSeguro("/pos/identify")).toBeNull();
    expect(destinoSeguro("/admin/hoy")).toBeNull();
    expect(destinoSeguro("//evil.example/pos/")).toBeNull();
    expect(destinoSeguro("https://evil.example/pos/mesas")).toBeNull();
    expect(destinoSeguro(null)).toBeNull();
  });

  it("arma la ruta de identificarse con la pantalla de origen", () => {
    expect(rutaIdentificarse("/pos/turno?accion=relevo")).toBe(
      `/pos/identify?next=${encodeURIComponent("/pos/turno?accion=relevo")}`,
    );
    expect(rutaIdentificarse("/pos")).toBe("/pos/identify");
    expect(rutaIdentificarse("/pos/identify")).toBe("/pos/identify");
  });
});

describe("puedeManejarCaja — la misma regla que el backend", () => {
  it("cobra, supervisa, administra o tiene la caja del turno", () => {
    expect(puedeManejarCaja({ id: 1, role: "operator", can_charge: true }, 9)).toBe(true);
    expect(puedeManejarCaja({ id: 1, role: "supervisor", can_charge: false }, 9)).toBe(true);
    expect(puedeManejarCaja({ id: 1, role: "admin", can_charge: false }, null)).toBe(true);
    expect(puedeManejarCaja({ id: 9, role: "operator", can_charge: false }, 9)).toBe(true);
  });

  it("el mesero o el cocinero sin la caja, no", () => {
    expect(puedeManejarCaja({ id: 1, role: "operator", can_charge: false }, 9)).toBe(false);
    expect(puedeManejarCaja({ id: 1, role: "operator", can_charge: false }, null)).toBe(false);
    expect(puedeManejarCaja(null, 9)).toBe(false);
  });
});

describe("cuantasCaben — lo que no cabe va a «Más»", () => {
  it("si cabe todo, todo; si no se pudo medir, todo", () => {
    expect(cuantasCaben([100, 100, 100], 400, 80)).toBe(3);
    expect(cuantasCaben([100, 100, 100], 0, 80)).toBe(3);
  });

  it("si no cabe, reserva el lugar de «Más»", () => {
    // 80 (Más) + 8 + 100 + 8 + 100 = 296 ≤ 300; una más no entra.
    expect(cuantasCaben([100, 100, 100, 100], 300, 80)).toBe(2);
  });
});
