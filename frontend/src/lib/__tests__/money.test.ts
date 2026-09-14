import { describe, expect, it } from "vitest";

import { formatCOP, parseCOP } from "../money";

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
