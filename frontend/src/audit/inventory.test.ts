// @vitest-environment node
/**
 * Invariantes de costo e inventario que se verifican **leyendo el código
 * fuente**.
 *
 * Auditor del pedido 2a. Igual que `security.test.ts` y `sales.test.ts`, acá
 * no se monta React: hay reglas cuyo enunciado es «cierta línea no existe en
 * ninguna parte», y ningún render las puede probar. En 2a son cinco:
 *
 * 1. **Una sola matemática, en el backend** (`AGENTS.md`,
 *    `docs/SPEC-NEGOCIO.md §11.13`): las pantallas de Inventario,
 *    Preparaciones y Recetas no calculan costos, food cost, márgenes,
 *    saldos ni varianzas. Los pintan tal como llegan.
 * 2. **Las cantidades tampoco se derivan**: la unidad base viaja como texto
 *    decimal ya convertido (`"117.648"`), así que ninguna pantalla puede
 *    multiplicar ni dividir por la escala (`QTY_SCALE = 1000`) ni por
 *    `COST_SCALE`. Un `/1000` en el cliente es la escala duplicada en dos
 *    lugares, y el día que cambie sólo cambia uno.
 * 3. **`null` no es `0`** (`AGENTS.md`): un costo sin origen, un stock sin
 *    libro y un KPI sin compras se dicen con palabras, nunca con un cero.
 * 4. **El operador no ve costos ni márgenes** (§11.10): las dos pantallas de
 *    dispositivo de esta fase —producción rápida y registro de merma— no
 *    nombran costo, margen ni food cost en ninguna parte.
 * 5. **La causa es una lista cerrada** (§5.1/§11.14): el filtro de
 *    movimientos y el de merma eligen de un enum, nunca de un campo de texto
 *    libre — «la causa no se infiere de un texto».
 *
 * Cada excepción tolerada está enumerada con archivo y símbolo: una excepción
 * que no se enumera es una excepción que se expande sola.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** El territorio de costo e inventario que este archivo audita. */
const COST_TERRITORY = [
  "features/inventory",
  "features/recipes",
  "api/inventory.ts",
  "api/recipes.ts",
  "components/CostValue.tsx",
];

/** Las dos pantallas que usa el operador en la tablet del salón/cocina. */
const DEVICE_SCREENS = [
  "features/recipes/QuickProductionPage.tsx",
  "features/inventory/WastePage.tsx",
];

type SourceFile = { readonly file: string; readonly code: string };

function listFiles(target: string): string[] {
  if (statSync(target).isFile()) return [target];
  const found: string[] = [];
  for (const entry of readdirSync(target)) {
    const full = path.join(target, entry);
    if (statSync(full).isDirectory()) {
      found.push(...listFiles(full));
      continue;
    }
    if ([".ts", ".tsx"].includes(path.extname(entry))) found.push(full);
  }
  return found;
}

/**
 * Quita comentarios para no acusar a una línea que sólo *habla* del patrón
 * prohibido. Misma heurística que `security.test.ts` (hallazgo O-2 de 1b-1:
 * colapsa saltos de línea dentro de un bloque `/* *\/`, así que los números de
 * línea de un archivo con comentarios de bloque pueden correrse; el archivo y
 * el texto de la línea siguen siendo exactos).
 */
function stripComments(code: string): string {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

function filesOf(targets: readonly string[]): SourceFile[] {
  const out: SourceFile[] = [];
  for (const relative of targets) {
    const absolute = path.join(SRC, relative);
    if (!existsSync(absolute)) continue;
    for (const file of listFiles(absolute)) {
      if (/\.test\.tsx?$/.test(file)) continue;
      if (file.split(path.sep).join("/").includes("/__tests__/")) continue;
      out.push({ file, code: stripComments(readFileSync(file, "utf8")) });
    }
  }
  return out;
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

describe("el territorio de costo e inventario existe y se está auditando", () => {
  it("las pantallas de esta fase están en el árbol", () => {
    // Guardia contra el falso verde: si las carpetas no existieran, todos los
    // tests de abajo pasarían sin haber mirado nada. Es exactamente lo que
    // pasó en 1b-2 con los tres rojos en archivos sin dueño.
    const territorio = filesOf(COST_TERRITORY);
    expect(territorio.length, "no se encontró ningún archivo de costo/inventario").toBeGreaterThan(5);

    for (const screen of DEVICE_SCREENS) {
      expect(
        existsSync(path.join(SRC, screen)),
        `falta la pantalla de dispositivo ${screen}: sin ella el operador no puede producir ni registrar merma`,
      ).toBe(true);
    }
  });
});

describe("una sola matemática, en el backend", () => {
  /**
   * Busca una variable o propiedad de plata/costo a la izquierda de un `=` o
   * `:` cuyo valor sea una expresión aritmética **entre dos operandos**. No
   * acusa a `cost: null`, ni a `unit_cost: 1_200` (literal), ni a
   * `cost_source: x.cost_source` (sin operador).
   */
  const DERIVED_MONEY =
    /\b(unit_?cost|total_?cost|theoretical_?cost|food_?cost\w*|gross_?margin|margin|contribution)\s*[:=](?!=)\s*[^;,\n]*[A-Za-z0-9_)\]]\s*[-+*/]\s*[A-Za-z0-9_(]/i;

  /** La fórmula del food cost escrita a mano en el cliente. */
  const FOOD_COST_FORMULA = /\bcost\w*\s*\/\s*\w*(net_?price|price|net)\w*/i;

  it("ninguna pantalla de costo calcula un costo, un margen ni un food cost", () => {
    const offenders = hits(filesOf(COST_TERRITORY), DERIVED_MONEY);
    expect(offenders, offenders.join("\n")).toEqual([]);
  });

  it("nadie reescribe la fórmula del food cost (costo ÷ precio neto)", () => {
    const offenders = hits(filesOf(COST_TERRITORY), FOOD_COST_FORMULA);
    expect(offenders, offenders.join("\n")).toEqual([]);
  });

  it("nadie recalcula el saldo de un insumo sumando movimientos en el cliente", () => {
    // `current_stock` es Σ del libro y lo calcula el backend: sumarlo acá
    // sobre una página de movimientos daría un saldo distinto del real en
    // cuanto haya paginación, y nadie se daría cuenta.
    const offenders = hits(
      filesOf(COST_TERRITORY),
      /\.reduce\s*\([^)]*\b(qty_base|qty|cost|stock)\b/i,
    );
    expect(offenders, offenders.join("\n")).toEqual([]);
  });
});

describe("las cantidades no se convierten en el cliente", () => {
  it("nadie multiplica ni divide por la escala de cantidades o de costos", () => {
    // `QTY_SCALE = 1000` y `COST_SCALE = 1_000_000` viven en
    // `backend/app/core/quantity.py` y NO se cruzan al frontend: la API
    // manda y recibe texto decimal ya convertido. Un `/1000` acá es la
    // escala escrita dos veces.
    //
    // **RONDA 2 de 2b — una excepción, con nombre propio y con precio.**
    // El orquestador decidió (hallazgo H-7) que la calculadora de sumas de
    // la captura de conteo se QUEDA: contar «6+8 cajas» es ergonomía real
    // de conteo físico (`docs/SPEC-NEGOCIO.md §5.4`), y sumar en milésimas
    // enteras es justamente lo que evita que «0.1+0.2» dé
    // «0.30000000000000004». La excepción es UN símbolo, nombrado acá:
    //
    //     features/inventory/lib.ts :: COUNT_QTY_SCALE  (parseCountInput)
    //
    // Fundamento: el cliente manda SIEMPRE texto decimal y el servidor
    // revalida con `app.core.quantity.parse_qty_base`, así que el espejo no
    // es una segunda matemática de negocio sino ayuda de tecleo — su peor
    // caso es un `422` de más, nunca un dato mal guardado. El precio de la
    // excepción está cobrado en `purchases-counts.test.ts` → «la excepción
    // de escala del conteo, declarada con nombre propio (H-7)»: si
    // `parseCountInput` dejara de devolver texto decimal, o si la escala
    // apareciera en un segundo archivo, esos tests caen.
    //
    // Se acota por SÍMBOLO, no por patrón de ruta: un `COUNT_QTY_SCALE` en
    // cualquier otro archivo sigue cayendo acá, y `lib.ts` sigue barrido
    // para todo lo demás (`micros`, `COST_SCALE`, un `/1000` suelto).
    // `hits` devuelve "<ruta relativa a src>:<línea>: <texto>".
    const EXCEPCION_ARCHIVO = "features/inventory/lib.ts";
    const offenders = hits(
      filesOf(COST_TERRITORY),
      /[*/]\s*1[_ ]?000[_ ]?(000)?\b|QTY_SCALE|COST_SCALE|\bmicros\b/i,
    ).filter((linea) => {
      const [ruta, , ...resto] = linea.split(":");
      const texto = resto.join(":");
      if (ruta !== EXCEPCION_ARCHIVO) return true;
      // Dentro del archivo de la excepción, sólo se perdona la línea que
      // NOMBRA el símbolo declarado. `COST_SCALE`, `micros` o un `/1000`
      // suelto ahí adentro siguen siendo un hallazgo.
      if (/COST_SCALE|\bmicros\b|\bQTY_SCALE\b/.test(texto)) return true;
      return !/\bCOUNT_QTY_SCALE\b/.test(texto);
    });
    expect(offenders, offenders.join("\n")).toEqual([]);
  });

  it("ninguna cantidad se manda al backend como número JSON", () => {
    // El contrato del pedido: `qty`, `min_stock`, `qty_delta`,
    // `standard_yield_qty` y los costos viajan como **texto decimal**. Un
    // `Number(...)` sobre uno de esos campos mete un `float` en el borde y ya
    // nadie lo saca (`0.1 + 0.2` en una varianza).
    const offenders = hits(
      filesOf(COST_TERRITORY),
      /\b(qty|qty_real|qty_expected|qty_delta|min_stock|official_cost|estimated_cost|standard_yield_qty)\s*:\s*(Number|parseFloat|parseInt)\s*\(/,
    );
    expect(offenders, offenders.join("\n")).toEqual([]);
  });
});

describe("`null` no es `0`", () => {
  it("ningún costo, stock ni porcentaje cae a 0 con ?? o ||", () => {
    // `cost ?? 0` convierte "no sé cuánto cuesta" en "cuesta cero" — el cero
    // mudo que §4.1 prohíbe, del lado del cliente.
    const offenders = hits(
      filesOf(COST_TERRITORY),
      /\b(cost|unit_cost|total_cost|theoretical_cost|food_cost_pct|ratio|qty_base|current_stock|stock)\w*\s*(\?\?|\|\|)\s*0\b/i,
    );
    expect(offenders, offenders.join("\n")).toEqual([]);
  });

  it("el KPI semanal de mermas dice «sin datos» y no un número inventado", () => {
    // `weekly_kpi.ratio` es `null` hasta que 2b traiga las compras. La
    // pantalla tiene que decirlo con palabras: un `0 %` se lee como "no hay
    // merma", que es lo contrario del dato.
    const territorio = filesOf(["features/inventory"]);
    const mencionan = territorio.filter(({ code }) => /weekly_kpi|weeklyKpi/.test(code));
    expect(
      mencionan.length,
      "ninguna pantalla de inventario muestra el KPI semanal de mermas",
    ).toBeGreaterThan(0);
    for (const { file, code } of mencionan) {
      expect(
        /sin datos/i.test(code),
        `${path.relative(SRC, file)} usa weekly_kpi sin decir «sin datos» cuando es null`,
      ).toBe(true);
    }
  });
});

describe("el operador no ve costos ni márgenes", () => {
  it("las pantallas de dispositivo no nombran costo, margen ni food cost", () => {
    const offenders = hits(filesOf(DEVICE_SCREENS), /\b\w*(cost|margin|margen)\w*\b/i);
    expect(
      offenders,
      "§11.10: el operador no ve costos ni márgenes, y la pantalla tampoco los nombra\n" +
        offenders.join("\n"),
    ).toEqual([]);
  });

  it("las pantallas de dispositivo no importan el componente de costo", () => {
    const offenders = hits(filesOf(DEVICE_SCREENS), /import[^;\n]*CostValue|import[^;\n]*costDisplay/);
    expect(offenders, offenders.join("\n")).toEqual([]);
  });
});

describe("la causa de un movimiento es una lista cerrada", () => {
  it("el filtro de causa y el de tipo de merma no son campos de texto libre", () => {
    // §5.1: «la causa NO se infiere de un texto». Si el filtro fuera un
    // `<Input>` libre, el cliente mandaría cualquier cosa y el backend
    // tendría que adivinar — el modo de falla de la referencia
    // ($1.126.398 leídos como fuga porque el motivo estaba escrito distinto).
    const offenders = hits(
      filesOf(["features/inventory"]),
      /<Input[^>]*\b(cause|causa|waste_?type|tipo)\b/i,
    );
    expect(offenders, offenders.join("\n")).toEqual([]);
  });

  // BORRADO en el cierre de 2b: «las etiquetas de causa cubren el enum
  // completo del backend», que enumeraba las once causas A MANO.
  //
  // Una lista a mano de un enum ajeno envejece sin avisar, y ésta envejeció
  // en las dos direcciones a la vez: exigía `void_after_send`, que 2b sacó
  // del enum, y no exigía `reception_reversal`, que 2b agregó. Así que a la
  // vez daba un rojo imposible de cerrar —`CAUSE_LABEL` está tipado
  // `Record<MovementCause, string>`, o sea que sacar la causa OBLIGA a sacar
  // la etiqueta, y al sacarla este test se ponía rojo— y un verde falso por
  // la causa que le faltaba. Dos invariantes que no pueden estar verdes con
  // el mismo árbol no son dos invariantes: es uno roto.
  //
  // Lo reemplaza `src/audit/purchases-counts.test.ts`, que LEE
  // `app/inventory/schemas.py::MovementCauseLiteral` y compara en las dos
  // direcciones, sin lista a mano que mantener.

  it("no existe un tipo de merma de «consumo de personal»", () => {
    // §5.5, literal: «no existe "consumo de personal" como merma: es una
    // comanda `staff_meal`». Si la UI lo ofreciera, el mismo hecho tendría
    // dos caminos de registro.
    const offenders = hits(
      filesOf(["features/inventory"]),
      /(staff_?meal|consumo de personal|personal)\s*:\s*["'`]/i,
    );
    expect(offenders, offenders.join("\n")).toEqual([]);
  });
});

describe("«negativo» y «agotado» no se dicen igual", () => {
  it("la pantalla de stock distingue el saldo negativo del insumo bajo mínimo", () => {
    const stock = filesOf(["features/inventory"]).filter(({ file }) =>
      file.endsWith("StockTab.tsx"),
    );
    expect(stock.length, "no se encontró la pantalla de stock").toBe(1);
    const { code } = stock[0];
    expect(/negative/i.test(code), "la pantalla de stock no distingue el negativo").toBe(true);
    expect(/below_?min/i.test(code), "la pantalla de stock no distingue el bajo mínimo").toBe(true);
  });

  it("el negativo se explica como deuda de registro, no como falta de producto", () => {
    // §5.2: «el negativo es deuda de registro, no bloqueo» — y un helado que
    // estuvo tres meses en −400 g porque nadie leyó bien la alerta.
    const inventario = filesOf(["features/inventory", "features/reports"]);
    const explican = inventario.filter(({ code }) => /deuda de registro/i.test(code));
    expect(
      explican.length,
      "ninguna pantalla explica qué significa un stock negativo",
    ).toBeGreaterThan(0);
  });
});
