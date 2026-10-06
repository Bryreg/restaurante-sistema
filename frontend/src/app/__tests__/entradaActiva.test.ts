import { describe, expect, it } from "vitest";

import { entradaActiva } from "@/app/AdminLayout";

// «Nómina» y «Propinas» comparten ruta; antes se encendían las dos a la vez.
const RAIL = ["/admin/nomina", "/admin/nomina?tab=propinas", "/admin/hoy"];

describe("entradaActiva", () => {
  it("en la pestaña de propinas enciende Propinas y no Nómina", () => {
    expect(entradaActiva("/admin/nomina?tab=propinas", true, "?tab=propinas", RAIL)).toBe(true);
    expect(entradaActiva("/admin/nomina", true, "?tab=propinas", RAIL)).toBe(false);
  });

  it("en cualquier otra pestaña de nómina enciende Nómina y no Propinas", () => {
    expect(entradaActiva("/admin/nomina", true, "", RAIL)).toBe(true);
    expect(entradaActiva("/admin/nomina", true, "?tab=horas", RAIL)).toBe(true);
    expect(entradaActiva("/admin/nomina?tab=propinas", true, "?tab=horas", RAIL)).toBe(false);
  });

  it("una ruta que no está activa nunca se enciende", () => {
    expect(entradaActiva("/admin/hoy", false, "", RAIL)).toBe(false);
  });

  it("una entrada puede reclamar pestañas hermanas: Salud del control enciende «Varianza y salud», no Inventario", () => {
    const inventario = ["/admin/inventario", "/admin/inventario?tab=varianza"];
    expect(entradaActiva("/admin/inventario?tab=varianza", true, "?tab=salud", inventario)).toBe(true);
    expect(entradaActiva("/admin/inventario", true, "?tab=salud", inventario)).toBe(false);
    expect(entradaActiva("/admin/inventario", true, "?tab=stock", inventario)).toBe(true);
  });
});
