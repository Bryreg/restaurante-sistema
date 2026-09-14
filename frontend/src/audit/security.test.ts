// @vitest-environment node
/**
 * Invariantes de seguridad y de plata que se verifican leyendo el código fuente.
 *
 * Auditor de control interno: hay reglas que ningún render puede probar porque
 * lo que importa es que **cierta línea no exista en ninguna parte**. Tres son
 * así (`docs/SPEC-NEGOCIO.md §11.11, §8, §11.13`):
 *
 * 1. Nada de sesión en `localStorage` / `sessionStorage` (sólo el tema).
 * 2. Nada de `new Date("YYYY-MM-DD")` ni `toISOString().slice(0, 10)` sobre una
 *    fecha de negocio: las dos derivan el día de la zona del navegador y el
 *    "día que cambia a las 7 pm" es un bug real de la referencia.
 * 3. El frontend no deriva plata: `expected`, `difference` y `to_deposit`
 *    llegan del backend y se muestran, nunca se calculan acá.
 *
 * Corre con `environment: node` (recorre el disco con `fs`, no monta React).
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const SOURCE_EXTENSIONS = [".ts", ".tsx"];
/** El propio auditor y los tests nombran los patrones prohibidos a propósito. */
const IGNORED_SEGMENTS = ["/audit/", "/__tests__/", "node_modules"];

type SourceFile = { readonly file: string; readonly code: string };

function listSourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      found.push(...listSourceFiles(full));
      continue;
    }
    if (SOURCE_EXTENSIONS.includes(path.extname(entry))) found.push(full);
  }
  return found;
}

/**
 * Quita comentarios para no acusar a una línea que sólo *habla* del patrón.
 *
 * Heurística documentada: se borran los bloques `/* ... *\/` y las líneas `//`
 * cuando no vienen precedidas por `:` (así un `http://` dentro de una cadena no
 * se come el resto de la línea). No intenta parsear cadenas: un patrón
 * prohibido escrito dentro de un string SÍ se reporta, y eso es deliberado.
 */
function stripComments(code: string): string {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

function relevantFiles(): SourceFile[] {
  return listSourceFiles(SRC)
    .filter((file) => {
      const unix = file.split(path.sep).join("/");
      if (IGNORED_SEGMENTS.some((segment) => unix.includes(segment))) return false;
      return !/\.test\.tsx?$/.test(file);
    })
    .map((file) => ({ file, code: stripComments(readFileSync(file, "utf8")) }));
}

function hits(files: SourceFile[], pattern: RegExp): string[] {
  const found: string[] = [];
  for (const { file, code } of files) {
    code.split("\n").forEach((line, index) => {
      if (new RegExp(pattern.source, pattern.flags.replace("g", "")).test(line)) {
        found.push(`${path.relative(SRC, file)}:${index + 1}: ${line.trim()}`);
      }
    });
  }
  return found;
}

describe("nada de sesión en el almacenamiento del navegador", () => {
  it("no escribe en localStorage/sessionStorage salvo para el tema claro/oscuro", () => {
    const writes = hits(relevantFiles(), /(localStorage|sessionStorage)\s*\.\s*setItem\s*\(/);

    // Excepción única: el tema, y sólo si la clave lo dice (AGENTS.md: «sesión
    // en cookie httpOnly; nada sensible en localStorage»).
    const offenders = writes.filter((hit) => !/theme/i.test(hit));
    expect(offenders, offenders.join("\n")).toEqual([]);
  });

  it("no guarda un token ni una sesión en ningún almacenamiento del navegador", () => {
    const offenders = hits(
      relevantFiles(),
      /(localStorage|sessionStorage)\s*\.\s*setItem\s*\(\s*["'`][^"'`]*(token|session|jwt|pin|auth)/i,
    );
    expect(offenders, offenders.join("\n")).toEqual([]);
  });
});

describe("la fecha de negocio no se deriva de la zona del navegador", () => {
  it('no usa new Date("YYYY-MM-DD")', () => {
    const offenders = hits(relevantFiles(), /new\s+Date\s*\(\s*["'`]\d{4}-\d{2}-\d{2}/);
    expect(offenders, offenders.join("\n")).toEqual([]);
  });

  it("no construye una fecha con new Date(business_date)", () => {
    const offenders = hits(
      relevantFiles(),
      /new\s+Date\s*\(\s*[A-Za-z_$][\w$.]*(business_date|businessDate)\b/,
    );
    expect(offenders, offenders.join("\n")).toEqual([]);
  });

  it("no usa toISOString().slice(0, 10)", () => {
    const offenders = hits(relevantFiles(), /toISOString\s*\(\s*\)\s*\.\s*slice\s*\(\s*0\s*,\s*10\s*\)/);
    expect(offenders, offenders.join("\n")).toEqual([]);
  });
});

describe("una sola matemática, en el backend", () => {
  /**
   * Heurística (documentada, con sus falsos positivos):
   *
   * - `ASSIGNMENT` busca `expected|difference|to_deposit` a la izquierda de un
   *   `=` o `:` seguido de una expresión con un operador aritmético **entre dos
   *   operandos** (`a - b`). Por eso NO acusa a `difference: -5_000` (literal
   *   negativo, sin operando a la izquierda) ni a `difference_seen:
   *   review.difference` (el `\b` corta antes del `_`).
   * - `EQUATION` busca la ecuación del cierre escrita a mano
   *   (`contado − esperado`, `base + ventas`).
   *
   * Falsos positivos posibles: un `expected = something - 1` en código que no
   * es de plata (no existe hoy en `features/shifts`), o una comparación
   * escrita como `const difference = a - b` con fines de UI. Si aparece uno,
   * la respuesta correcta es mover el cálculo al backend, no aflojar el test.
   */
  const ASSIGNMENT =
    /\b(expected(_?cash)?|difference|to_?deposit|toDeposit)\s*[:=](?!=)\s*[^;,\n]*[A-Za-z0-9_)\]]\s*[-+*/]\s*[A-Za-z0-9_(]/;
  const EQUATION = /\b(counted\w*\s*[-+]\s*expected\w*|expected\w*\s*[-+]\s*counted\w*|base\w*\s*\+\s*\w*(sales|income)\w*)/i;

  function shiftFiles(): SourceFile[] {
    return relevantFiles().filter(({ file }) =>
      file.split(path.sep).join("/").includes("/features/shifts/"),
    );
  }

  it("ninguna pantalla de turno calcula el esperado, la diferencia ni lo que se consigna", () => {
    const offenders = hits(shiftFiles(), ASSIGNMENT);
    expect(offenders, offenders.join("\n")).toEqual([]);
  });

  it("ninguna pantalla de turno reescribe la ecuación del cierre", () => {
    const offenders = hits(shiftFiles(), EQUATION);
    expect(offenders, offenders.join("\n")).toEqual([]);
  });

  it("el territorio de turnos existe y se está auditando de verdad", () => {
    // Guardia contra un falso verde: si la carpeta no existiera, los dos tests
    // de arriba pasarían sin haber mirado nada.
    expect(shiftFiles().length).toBeGreaterThan(0);
  });
});
