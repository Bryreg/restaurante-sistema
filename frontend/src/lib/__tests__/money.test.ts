import { describe, expect, it } from "vitest";

import { formatCOP, formatCOPDecimal, parseCOP } from "../money";

describe("money", () => {
  it('formatCOP(null) es "—", nunca "0"', () => {
    expect(formatCOP(null)).toBe("—");
    expect(formatCOP(null)).not.toContain("0");
  });

  it('formatCOP(undefined) también es "—"', () => {
    expect(formatCOP(undefined)).toBe("—");
  });

  it("formatCOP(0) muestra $ 0, distinto de null", () => {
    const zero = formatCOP(0);
    expect(zero).not.toBe("—");
    expect(zero).toContain("0");
  });

  it("formatCOP formatea con separador de miles", () => {
    expect(formatCOP(1234567)).toContain("1.234.567");
  });

  it("parseCOP interpreta el separador de miles colombiano", () => {
    expect(parseCOP("1.234.567")).toBe(1234567);
    expect(parseCOP("$ 200.000")).toBe(200000);
  });

  it("parseCOP('') es null, no 0", () => {
    expect(parseCOP("")).toBeNull();
    expect(parseCOP(null)).toBeNull();
    expect(parseCOP(undefined)).toBeNull();
  });

  it("parseCOP redondea al peso (nunca centavos)", () => {
    expect(parseCOP("100,90")).toBe(100);
  });
});

describe("formatCOPDecimal — costo por unidad base, sin redondear al peso (B-2, ronda 2)", () => {
  it("formatCOPDecimal(null) es «—», nunca «0»", () => {
    expect(formatCOPDecimal(null)).toBe("—");
  });

  it('conserva todos los decimales de un costo sub-peso ("0.003" -> $0,003, sin el cero mudo)', () => {
    const out = formatCOPDecimal("0.003");
    expect(out).toContain(",003");
    expect(out).not.toBe("$ 0");
    expect(out).not.toMatch(/\$\s*0(\D|$)/);
  });

  it('conserva un decimal simple sin redondear ("14.5" -> $14,5, no $15)', () => {
    const out = formatCOPDecimal("14.5");
    expect(out).toContain("14,5");
    expect(out).not.toContain("15");
  });

  it('agrupa de a miles un entero sin decimales ("4500" -> $4.500)', () => {
    expect(formatCOPDecimal("4500")).toBe("$ 4.500");
  });

  it("acepta number además de string decimal (compatibilidad)", () => {
    expect(formatCOPDecimal(4500)).toBe("$ 4.500");
  });
});
