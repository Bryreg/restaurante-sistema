// @vitest-environment node
/**
 * Ronda 2 del pedido 2c — los invariantes del CLIENTE que el cierre de H-1
 * hace nacer.
 *
 * H-1 (bloqueante de la ronda 1) se cerró decidiendo que el `INCOME` de la
 * liquidación de domicilios se escribe por la **venta sola**, nunca por
 * venta + propina. Desde ese momento `amount` y `tip_amount` de
 * `GET /delivery-settlements/pending` **ya no pesan igual sobre el esperado
 * del turno**: uno lo mueve y el otro no.
 *
 * Eso convierte cualquier `amount + tip_amount` escrito en el cliente en una
 * segunda matemática del esperado — la regla dura que `AGENTS.md` pone
 * primero. El servidor ya publica `total`; el cliente lo pinta.
 *
 * Este archivo NO reescribe `channels-kds.test.ts` (la ronda 1 queda como
 * está): agrega los invariantes nuevos de la ronda 2.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BACKEND = path.resolve(SRC, "../../backend");

type SourceFile = { readonly file: string; readonly code: string };

function listFiles(target: string): string[] {
  if (!existsSync(target)) return [];
  if (statSync(target).isFile()) return [target];
  const found: string[] = [];
  for (const entry of readdirSync(target)) {
    const full = path.join(target, entry);
    if (statSync(full).isDirectory()) {
      found.push(...listFiles(full));
      continue;
    }
    if (/\.(ts|tsx)$/.test(entry)) found.push(full);
  }
  return found;
}

function stripComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function filesOf(targets: readonly string[]): SourceFile[] {
  const out: SourceFile[] = [];
  for (const target of targets) {
    for (const file of listFiles(path.join(SRC, target))) {
      out.push({ file: path.relative(SRC, file), code: stripComments(readFileSync(file, "utf8")) });
    }
  }
  return out;
}

function hits(files: readonly SourceFile[], pattern: RegExp): string[] {
  const found: string[] = [];
  for (const { file, code } of files) {
    code.split("\n").forEach((line, index) => {
      if (pattern.test(line)) found.push(`${file}:${index + 1}  ${line.trim()}`);
    });
  }
  return found;
}

describe("ronda 2 — venta y propina ya no pesan igual: el cliente no las suma", () => {
  it("ninguna pantalla suma a mano `amount + tip_amount` del pendiente de domicilios", () => {
    const offenders = hits(
      filesOf(["features/shifts", "features/orders", "features/payments", "api/shifts.ts"]),
      /(amount\s*\+\s*tip_amount|tip_amount\s*\+\s*amount|\.amount\s*\+\s*[A-Za-z_.]*tip)/,
    );
    expect(
      offenders,
      "el cliente suma la venta y la propina de un domicilio a mano. Desde el cierre de H-1 esos dos " +
        "números NO pesan igual sobre el esperado del turno (el `INCOME` de la liquidación se escribe " +
        "por la venta sola, app/channels/service.py:513-521): sumarlos acá es una segunda matemática. " +
        "El servidor ya publica `total`:\n" + offenders.join("\n"),
    ).toEqual([]);
  });

  it("la pantalla de liquidación pinta los tres números del servidor y no deriva ninguno", () => {
    const panel = path.join(SRC, "features/shifts/DeliverySettlementPanel.tsx");
    expect(existsSync(panel), "falta features/shifts/DeliverySettlementPanel.tsx").toBe(true);
    const code = stripComments(readFileSync(panel, "utf8"));
    for (const field of ["amount", "tip_amount", "total"]) {
      expect(
        new RegExp(`\\.${field}\\b`).test(code),
        `la pantalla de liquidación no pinta \`${field}\`: el domiciliario entrega venta + propina y ` +
          "las tres cifras tienen que verse por separado, porque ya no pesan igual sobre el esperado",
      ).toBe(true);
    }
  });
});

describe("ronda 2 — el renglón de propina de domicilio que nació en `ShiftTipsOut`", () => {
  it("el cliente no declara un tipo propio de `GET /shifts/{id}/tips` que se desincronice", () => {
    // El backend agregó `delivery`/`delivery_cash`/`delivery_cash_pending` a
    // `ShiftTipsOut`/`TipsByEmployeeOut` (app/shifts/schemas.py:538,554-555).
    // Hoy NINGUNA pantalla consume esa ruta, así que no hay tipo que pueda
    // quedar viejo. El invariante fija ese hecho: el día que alguien tipee la
    // respuesta a mano y se olvide del renglón de domicilio, este test se
    // pone rojo y obliga a declarar los cinco bolsillos.
    const consumers = hits(filesOf(["api", "features"]), /shifts\/\$\{[^}]+\}\/tips|["'`]\/shifts\/[^"'`]*\/tips/);
    if (consumers.length === 0) return; // nadie la consume: nada que desincronizar
    // RONDA 3: el contrato de `ShiftTipsOut` renombró el renglón al cerrar
    // H-7 (`delivery_cash*` → `delivery_tips*`) y agregó
    // `delivery_tips_settled`. El hecho medido es el mismo —que el cliente
    // declare el renglón entero— con los nombres que el servidor publica
    // hoy, y ahora son TRES campos, no dos: se exigen los tres.
    for (const field of ["delivery_tips", "delivery_tips_pending", "delivery_tips_settled"]) {
      const declared = hits(filesOf(["api"]), new RegExp(`\\b${field}\\b`));
      expect(
        declared.length,
        `alguna pantalla consume \`GET /shifts/{id}/tips\` pero el cliente no declara \`${field}\`: ` +
          "la propina de domicilio que salió de `.cash` desaparecería de la pantalla, o el cliente " +
          "tendría que derivarla restando:\n" + consumers.join("\n"),
      ).toBeGreaterThan(0);
    }
  });

  it("ninguna pantalla deriva `delivery_tips_settled` restando: la publica el servidor", () => {
    // RONDA 3, cierre de H-8. `cash_out` es ahora
    // `by_method.cash + delivery_tips_settled`, y el servidor publica el
    // sumando ya calculado. Si un cliente lo rearma con
    // `delivery_tips - delivery_tips_pending`, hay dos matemáticas de la
    // plata que se puede sacar del cajón — que es exactamente la regla dura
    // que H-8 existió para defender.
    const offenders = hits(
      filesOf(["api", "features"]),
      /delivery_tips\s*[-–]\s*[A-Za-z_.?[\]"'` ]*delivery_tips_pending/,
    );
    expect(
      offenders,
      "un cliente deriva la propina de domicilio ya liquidada restando en vez de leer " +
        "`delivery_tips_settled`, que el servidor publica:\n" + offenders.join("\n"),
    ).toEqual([]);
  });

  it("el nombre ambiguo `delivery_cash_pending` sigue significando venta + propina, y sólo en el desglose", () => {
    // RONDA 3, cierre de H-7. El renombre no puede haberse propagado al
    // desglose del turno: `ShiftCurrent`/`ShiftSummary.delivery_cash_pending`
    // conservan su significado de siempre. Si el tipo del desglose perdiera
    // la clave, la pantalla del turno dejaría de ver los domicilios
    // pendientes.
    const api = readFileSync(path.join(SRC, "api/shifts.ts"), "utf8");
    expect(
      (api.match(/delivery_cash_pending/g) ?? []).length,
      "`src/api/shifts.ts` dejó de declarar `delivery_cash_pending` en el desglose del turno: el " +
        "renombre de H-7 era SÓLO para `GET /shifts/{id}/tips`",
    ).toBeGreaterThan(0);
    const tipsBlock = api.slice(api.indexOf("interface ShiftTips"), api.indexOf("interface ShiftTips") + 2000);
    expect(
      /delivery_cash_pending/.test(tipsBlock.slice(0, tipsBlock.indexOf("\n}"))),
      "el tipo de `GET /shifts/{id}/tips` todavía declara `delivery_cash_pending`: es el nombre que " +
        "H-7 denunció por significar otra cosa en el desglose del turno",
    ).toBe(false);
  });

  it("el backend publica el renglón de domicilio como ENTERO, nunca como porcentaje ni float", () => {
    const schemas = readFileSync(path.join(BACKEND, "app/shifts/schemas.py"), "utf8");
    const bloque = schemas.slice(schemas.indexOf("class TipsByEmployeeOut"));
    const cuerpo = bloque.slice(0, bloque.indexOf("class TipPayout"));
    expect(
      /delivery:\s*int/.test(cuerpo),
      "`TipsByEmployeeOut.delivery` dejó de ser `int`: la plata del sistema es entera (renglón #13)",
    ).toBe(true);
    expect(
      /float/.test(cuerpo),
      "apareció un `float` en los esquemas de propina del turno",
    ).toBe(false);
  });
});

describe("ronda 2 — la fórmula heredada del esperado sigue siendo una sola, y vive en el backend", () => {
  it("`compute_breakdown` conserva la fórmula de 1b letra por letra", () => {
    const service = readFileSync(path.join(BACKEND, "app/shifts/service.py"), "utf8");
    expect(
      service.includes("expected = base + sales.cash + incomes - expenses - pickups"),
      "la fórmula del esperado cambió: el arreglo de H-1 no podía tocar `compute_breakdown`. " +
        "Es el número contra el que se cuenta a ciegas en TODO el producto, no sólo en 2c",
    ).toBe(true);
  });

  it("el cliente sigue sin derivar el esperado en ninguna pantalla de turno", () => {
    const offenders = hits(
      filesOf(["features/shifts"]),
      /(expected[A-Za-z_]*\s*=\s*[^=\n]*[+\-*/][^=\n]*(cash|incomes|pickups|sales))/i,
    );
    expect(
      offenders,
      "una pantalla de turno arma el esperado con aritmética propia: una sola matemática, en el " +
        "backend:\n" + offenders.join("\n"),
    ).toEqual([]);
  });
});
