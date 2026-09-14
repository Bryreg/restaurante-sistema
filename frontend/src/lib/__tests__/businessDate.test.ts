import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { formatBusinessDate, formatInstant, parseBusinessDate } from "../businessDate";

const SOURCE_PATH = fileURLToPath(new URL("../businessDate.ts", import.meta.url));

describe("businessDate", () => {
  it("no usa new Date(\"YYYY-MM-DD\") en su propia fuente (la trampa de zona horaria)", () => {
    const source = readFileSync(SOURCE_PATH, "utf-8");
    expect(source).not.toMatch(/new Date\(\s*value\s*\)/);
    expect(source).not.toMatch(/new Date\(["'`]/);
    expect(source).not.toMatch(/toISOString\(\)\.slice/);
  });

  it("parsea las partes de una fecha de negocio sin ambigüedad", () => {
    expect(parseBusinessDate("2026-09-14")).toEqual({ y: 2026, m: 9, d: 14 });
  });

  it("rechaza una fecha con formato inválido en vez de adivinar", () => {
    expect(() => parseBusinessDate("14/09/2026")).toThrow();
  });

  it("formatea 2026-09-14 (lunes) como \"lun 14 sep 2026\", sin correrse un día", () => {
    expect(formatBusinessDate("2026-09-14")).toBe("lun 14 sep 2026");
  });

  it("formatea un fin de año sin correrse de año por el huso horario", () => {
    // 2025-12-31 es miércoles; si el código usara `new Date("2025-12-31")` y
    // formateara en una zona con offset positivo grande, podría leerse como
    // 2026-01-01. Acá tiene que seguir siendo 31 de diciembre de 2025.
    expect(formatBusinessDate("2025-12-31")).toBe("mié 31 dic 2025");
  });

  it("formatBusinessDate(null) es \"—\"", () => {
    expect(formatBusinessDate(null)).toBe("—");
    expect(formatBusinessDate(undefined)).toBe("—");
  });

  it("formatInstant formatea un instante ISO en hora de Bogotá", () => {
    // 2026-09-14T15:05:00Z = 10:05 a.m. en Bogotá (UTC-5, sin horario de verano).
    const formatted = formatInstant("2026-09-14T15:05:00Z");
    expect(formatted).toContain("2026");
    expect(formatted).toContain("14 sep");
    expect(formatted).toMatch(/10:05/);
  });

  it("formatInstant(null) es \"—\"", () => {
    expect(formatInstant(null)).toBe("—");
  });
});
