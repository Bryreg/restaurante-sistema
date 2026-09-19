// @vitest-environment node
/**
 * Invariantes de COMPRAS, CONTEOS, LOTES y VARIANZA que se verifican
 * **leyendo el código fuente** (pedido 2b).
 *
 * Mismo criterio que `inventory.test.ts` y `security.test.ts`: hay reglas
 * cuyo enunciado es «cierta línea no existe en ninguna parte», y ningún
 * render las prueba. Las de 2b son cinco:
 *
 * 1. **No existe «todo coincide»** (`docs/SPEC-NEGOCIO.md §5.4`): ninguna
 *    pantalla de conteo marca todos los renglones de una vez. En la
 *    referencia ese botón borró faltantes reales de −10.065 g. El checklist
 *    lo pide probado por contrato **y por revisión de la UI**: esto es la
 *    segunda mitad.
 * 2. **El conteo es a ciegas**: la pantalla de captura no pide, no recibe y
 *    no pinta el stock teórico por ningún camino. La única referencia es el
 *    conteo anterior.
 * 3. **Una sola matemática, en el backend** (`AGENTS.md`): las pantallas de
 *    Compras no calculan el saldo de una cuenta por pagar, ni el IVA de una
 *    línea, ni el promedio ponderado, ni la varianza. Los pintan como llegan.
 * 4. **`null` no es `0`**: un saldo, un food cost sin dos conteos y un KPI
 *    sin compras se dicen con palabras, nunca con un cero.
 * 5. **El operador no ve costos** (§11.10, invariante heredado #2 de la
 *    spec de 2b): la recepción lleva precios, así que es pantalla de Admin.
 *    Ninguna ruta de compras se registra en el POS.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** El territorio que este archivo audita. */
const TERRITORY_2B = [
  "features/purchases",
  "features/inventory/CountsTab.tsx",
  "features/inventory/CountCapturePage.tsx",
  "features/inventory/OpenCountDialog.tsx",
  "features/inventory/VarianceTab.tsx",
  "features/inventory/LotsTab.tsx",
  "features/inventory/ControlHealthTab.tsx",
  "api/purchases.ts",
];

/** La pantalla donde se capturan los renglones de un conteo. */
const COUNT_CAPTURE = "features/inventory/CountCapturePage.tsx";

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

/** Quita comentarios: una línea que sólo *habla* del patrón no es culpable. */
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

describe("el territorio de 2b existe y se está auditando", () => {
  it("las pantallas de compras y de conteos están en el árbol", () => {
    // Guardia contra el falso verde: sin estos archivos, todo lo de abajo
    // pasaría sin haber mirado nada. Es exactamente lo que pasó en 1b-2 con
    // los tres rojos en archivos sin dueño.
    const territorio = filesOf(TERRITORY_2B);
    expect(territorio.length, "no se encontró ningún archivo de compras/conteos").toBeGreaterThan(8);
    for (const pantalla of [
      "features/purchases/ReceptionForm.tsx",
      "features/purchases/PayablesTab.tsx",
      COUNT_CAPTURE,
      "features/inventory/VarianceTab.tsx",
      "features/inventory/LotsTab.tsx",
    ]) {
      expect(existsSync(path.join(SRC, pantalla)), `falta ${pantalla}`).toBe(true);
    }
  });
});

describe("no existe «todo coincide» (§5.4)", () => {
  const CAPTURE_FILES = filesOf([COUNT_CAPTURE, "features/inventory/CountsTab.tsx"]);

  it("ninguna pantalla de conteo marca todos los renglones de una vez", () => {
    // Un `map` sobre TODOS los renglones que ponga `was_counted: true` es el
    // botón prohibido escrito sin botón.
    const MARK_ALL =
      /was_counted\s*:\s*true[^\n]*\)\s*\)|\.map\s*\([^)]*was_counted\s*:\s*true|marcar\s*todo|todo\s*coincide|selectAll|markAll|confirmAll/i;
    const offenders = hits(CAPTURE_FILES, MARK_ALL);
    expect(offenders, offenders.join("\n")).toEqual([]);
  });

  it("no hay un control que aplique el mismo valor a todos los renglones", () => {
    const BULK_CONTROL = /\b(checkAll|toggleAll|setAll|applyToAll|bulkConfirm|seleccionarTodo)\b/i;
    const offenders = hits(CAPTURE_FILES, BULK_CONTROL);
    expect(offenders, offenders.join("\n")).toEqual([]);
  });

  it("la pantalla de captura dice que un guardado parcial es parcial", () => {
    // `partial` viene del backend (`CountLinesSaveOut.partial`): la pantalla
    // lo tiene que MOSTRAR, no recalcularlo — y sobre todo no ocultarlo, que
    // es lo que convierte un conteo a medias en un conteo «completo».
    const code = readFileSync(path.join(SRC, COUNT_CAPTURE), "utf8");
    expect(
      /partial|parcial|lines_counted/.test(code),
      "la pantalla de captura no muestra en ninguna parte cuántos renglones faltan",
    ).toBe(true);
  });
});

describe("el conteo es a ciegas", () => {
  it("la pantalla de captura no pide el stock teórico por ningún camino", () => {
    const code = stripComments(readFileSync(path.join(SRC, COUNT_CAPTURE), "utf8"));
    const FETCHES_STOCK =
      /\b(getInventoryStock|listStock|fetchStock|getStock|stockQuery|current_stock|qty_base)\b/;
    const offenders: string[] = [];
    code.split("\n").forEach((line, index) => {
      if (FETCHES_STOCK.test(line)) offenders.push(`${COUNT_CAPTURE}:${index + 1}: ${line.trim()}`);
    });
    expect(
      offenders,
      "la captura de un conteo a ciegas no puede traer el stock del sistema:\n" + offenders.join("\n"),
    ).toEqual([]);
  });

  it("la única referencia en pantalla es el conteo anterior", () => {
    const code = readFileSync(path.join(SRC, COUNT_CAPTURE), "utf8");
    expect(
      code.includes("previous_qty_counted"),
      "la pantalla de captura no muestra el conteo anterior: §5.4 pide esa referencia y sólo esa",
    ).toBe(true);
  });
});

describe("una sola matemática, en el backend", () => {
  const FILES = filesOf(TERRITORY_2B);

  it("ninguna pantalla de compras deriva el saldo de una cuenta por pagar", () => {
    // `PayableOut.balance` lo DERIVA el backend de los pagos vivos. Restarlo
    // en el cliente es la segunda fuente de verdad que `AGENTS.md` prohíbe,
    // y la que muestra plata que no es.
    const DERIVED_BALANCE =
      /\b(balance|saldo|pending|pendiente)\s*[:=](?!=)\s*[^;,\n]*[A-Za-z0-9_)\]]\s*[-+]\s*[A-Za-z0-9_(]/i;
    const offenders = hits(FILES, DERIVED_BALANCE);
    expect(offenders, offenders.join("\n")).toEqual([]);
  });

  it("ninguna pantalla calcula el impuesto ni el costo final de una línea de recepción", () => {
    // El IVA bajo INC es mayor valor del costo y lo resuelve el backend
    // (`final_unit_cost`). Un `base * rate / 100` acá es la regla fiscal
    // escrita dos veces, y la del cliente es la que nadie prueba.
    const TAX_MATH =
      /\b(tax_amount|tax_base|iva|impuesto|final_unit_cost|unit_cost)\s*[:=](?!=)\s*[^;,\n]*[A-Za-z0-9_)\]]\s*[-+*/]\s*[A-Za-z0-9_(]/i;
    const offenders = hits(FILES, TAX_MATH);
    expect(offenders, offenders.join("\n")).toEqual([]);
  });

  it("ninguna pantalla calcula la varianza ni el promedio ponderado", () => {
    const VARIANCE_MATH =
      /\b(variance\w*|varianza|weighted\w*|promedio|real_usage\w*|theoretical_usage\w*)\s*[:=](?!=)\s*[^;,\n]*[A-Za-z0-9_)\]]\s*[-+*/]\s*[A-Za-z0-9_(]/i;
    const offenders = hits(FILES, VARIANCE_MATH);
    expect(offenders, offenders.join("\n")).toEqual([]);
  });

  it("ningún umbral del semáforo de varianza está cableado en el cliente", () => {
    // Los umbrales son configuración de sede (`InventorySettingsOut`): un
    // `2` o un `400` escrito acá es el semáforo que no cambia aunque el
    // dueño cambie su tolerancia.
    const HARDCODED_THRESHOLD =
      /\b(yellow|red|green|semaforo|semáforo|level)\w*\s*[:=](?!=)\s*[^;,\n]*\b\d{2,}\b/i;
    const offenders = hits(filesOf(["features/inventory/VarianceTab.tsx"]), HARDCODED_THRESHOLD);
    expect(offenders, offenders.join("\n")).toEqual([]);
  });

  it("nadie convierte la escala de cantidades ni de costos en el cliente", () => {
    const offenders = hits(FILES, /[*/]\s*1[_ ]?000[_ ]?(000)?\b|QTY_SCALE|COST_SCALE|\bmicros\b/i);
    expect(offenders, offenders.join("\n")).toEqual([]);
  });
});

describe("null no es 0", () => {
  const FILES = filesOf(TERRITORY_2B);

  it("ningún costo, saldo, porcentaje ni razón se reemplaza por cero al pintarlo", () => {
    const NULL_AS_ZERO =
      /\b(cost|unit_cost|final_unit_cost|balance|amount|pct_bp|ratio|variance_value|purchases_value|opening_value|closing_value|net_sales|days_since_full_count)\w*\s*(\?\?|\|\|)\s*0\b/i;
    const offenders = hits(FILES, NULL_AS_ZERO);
    expect(
      offenders,
      "`null` no es `0` (AGENTS.md): sin dato se dice «sin datos», no se pinta un cero:\n" +
        offenders.join("\n"),
    ).toEqual([]);
  });

  it("la pantalla de food cost real dice el motivo cuando no hay dos conteos", () => {
    const candidatos = filesOf([
      "features/inventory/VarianceTab.tsx",
      "features/inventory/ControlHealthTab.tsx",
    ]);
    const muestraMotivo = candidatos.some(({ code }) => /\breason\b/.test(code));
    expect(
      muestraMotivo,
      "el backend manda `reason` con el `null` del food cost real y ninguna pantalla lo pinta: " +
        "«sin datos» sin decir por qué es un cero mudo con otra forma",
    ).toBe(true);
  });
});

describe("el operador no ve costos ni márgenes (§11.10)", () => {
  it("compras no registra ninguna ruta en el POS", () => {
    const code = readFileSync(path.join(SRC, "features/purchases/index.ts"), "utf8");
    const sinComentarios = stripComments(code);
    expect(
      /posRoutes\s*:\s*\[\s*\]/.test(sinComentarios) ||
        /posRoutes:\s*\[\]\s*as\s*RouteObject\[\]/.test(sinComentarios),
      "`purchasesFeature` registra rutas en el POS: la recepción lleva precios unitarios y es pantalla de " +
        "ADMIN (invariante heredado #2 de `spec.md`). Moverla al salón cambia una regla dura y es " +
        "decisión del dueño de la spec, no de una pantalla",
    ).toBe(true);
  });

  it("ninguna pantalla de conteo, varianza o lotes se registra en el POS", () => {
    const code = stripComments(readFileSync(path.join(SRC, "features/inventory/index.ts"), "utf8"));
    const bloquePos = code.slice(code.indexOf("posRoutes"));
    for (const prohibida of ["CountCapturePage", "VarianceTab", "LotsTab", "ControlHealthTab", "CountsTab"]) {
      expect(
        bloquePos.includes(prohibida),
        `${prohibida} quedó registrada como ruta del POS: lleva costo o stock del sistema`,
      ).toBe(false);
    }
  });
});

describe("los umbrales de varianza y los insumos críticos se pueden editar (§9.3)", () => {
  it("Configuración de sede edita los dos umbrales y la marca de insumo crítico", () => {
    // «Un campo que el backend acepta y ninguna pantalla edita está escrito a
    // medias» (`spec.md § Archivos huérfanos … (2b)`).
    const seccion = path.join(SRC, "features/settings/InventorySection.tsx");
    expect(existsSync(seccion), "falta la sección de inventario en Configuración de sede").toBe(true);
    const code = readFileSync(seccion, "utf8");
    for (const campo of ["variance_yellow_threshold_bp", "variance_red_threshold_bp", "key_item"]) {
      expect(code.includes(campo), `Configuración de sede no edita \`${campo}\``).toBe(true);
    }
  });
});

describe("el egreso del cajón llega completo a la pantalla de caja (cruce purchases → shifts)", () => {
  it("el frontend conoce la causa `supplier_payment` y sabe cómo nombrarla", () => {
    // `app/shifts/schemas.py:26` agregó `"supplier_payment"` al contrato de
    // causas de caja en 2b (un pago a proveedor desde el cajón). Si el
    // frontend no la conoce, `MovementsPanel.tsx:203` pinta
    // `CAUSE_LABEL[movement.cause]` -> `undefined`: el cajero ve un egreso
    // SIN NOMBRE en la lista del turno justo antes de cerrar a ciegas, y la
    // diferencia que no sepa explicar la tiene que escribir una persona
    // (`docs/SPEC-NEGOCIO.md §3.2`; el sistema nunca calcula deuda de un
    // empleado, CST art. 149).
    //
    // `CAUSE_LABEL` está tipado `Record<CashMovementCause, string>`, así que
    // agregar la causa a la unión SIN etiqueta rompe el typecheck: alcanza
    // con exigir las dos cosas.
    const api = readFileSync(path.join(SRC, "api/shifts.ts"), "utf8");
    expect(
      /"supplier_payment"/.test(api),
      "`CashMovementCause` del frontend (api/shifts.ts) no incluye `supplier_payment`, que el backend " +
        "ya produce desde 2b: el egreso del pago a proveedor se pinta sin causa en el turno",
    ).toBe(true);

    const panel = readFileSync(path.join(SRC, "features/shifts/MovementsPanel.tsx"), "utf8");
    expect(
      /supplier_payment\s*:/.test(panel),
      "`CAUSE_LABEL` de MovementsPanel.tsx no tiene etiqueta para `supplier_payment`",
    ).toBe(true);
  });
});

describe("la fecha de negocio de las pantallas de compras (§ zona horaria)", () => {
  it("ninguna pantalla de compras deriva la fecha de la zona del navegador", () => {
    // Duplica a propósito el barrido heredado de `security.test.ts` para que
    // el hallazgo quede nombrado en el territorio donde cayó: `new Date().
    // toISOString().slice(0,10)` da la fecha **UTC**, y en Bogotá (UTC−5)
    // después de las 19:00 locales eso es MAÑANA. El rango por defecto de
    // Compras, Cuentas por pagar y Confiabilidad queda corrido un día cada
    // noche. El helper correcto ya existe:
    // `features/reports/lib.ts:122` (`Intl.DateTimeFormat("en-CA",
    // { timeZone: "America/Bogota" })`).
    const offenders = hits(
      filesOf(["features/purchases"]),
      /toISOString\s*\(\s*\)\s*\.\s*slice\s*\(\s*0\s*,\s*10\s*\)/,
    );
    expect(
      offenders,
      "`AGENTS.md`: la fecha operativa se resuelve en `America/Bogota`, nunca con la zona del navegador:\n" +
        offenders.join("\n"),
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// RONDA 2 — los invariantes que cierran los hallazgos de la ronda 1 para que
// no puedan volver, y la excepción de escala declarada por el orquestador.
// ---------------------------------------------------------------------------

/** El contrato de causas de caja, tal como lo publica el backend. */
const BACKEND_SHIFT_SCHEMAS = path.resolve(SRC, "../../backend/app/shifts/schemas.py");

describe("el cruce backend → cliente de las causas de caja (ronda 2)", () => {
  it("toda causa de caja declarada por el backend tiene etiqueta no vacía en el cliente", () => {
    // **El cruce que en la ronda 1 no tenía nadie.** H-8 fue un caso
    // particular de esto: el backend agregó `"supplier_payment"` a
    // `CashMovementCauseLiteral` y el cliente se quedó con las seis causas de
    // 1a, así que `CAUSE_LABEL[movement.cause]` daba `undefined` y el
    // responsable de caja veía un egreso SIN NOMBRE en la lista del turno que
    // estaba por cerrar a ciegas. El typecheck no lo caza: `Record<
    // CashMovementCause, string>` sólo es exhaustivo sobre la unión, y la
    // unión es lo que quedó viejo.
    //
    // Por eso este test no nombra ninguna causa: LEE el `Literal` del backend
    // y exige una etiqueta por cada valor. La causa número ocho, la que
    // agregue fase 3, cae sola.
    expect(
      existsSync(BACKEND_SHIFT_SCHEMAS),
      `no encuentro el contrato de causas del backend en ${BACKEND_SHIFT_SCHEMAS}`,
    ).toBe(true);
    const schemas = readFileSync(BACKEND_SHIFT_SCHEMAS, "utf8");
    const bloque = /CashMovementCauseLiteral\s*=\s*Literal\[([\s\S]*?)\]/.exec(schemas);
    expect(bloque, "no pude leer `CashMovementCauseLiteral` de app/shifts/schemas.py").not.toBeNull();
    const declaradas = [...bloque![1].matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
    expect(
      declaradas.length,
      "el barrido leyó cero causas: el formato del `Literal` cambió y este test se volvió un falso verde",
    ).toBeGreaterThanOrEqual(6);

    const api = readFileSync(path.join(SRC, "api/shifts.ts"), "utf8");
    const panel = readFileSync(path.join(SRC, "features/shifts/MovementsPanel.tsx"), "utf8");
    const mapa = /CAUSE_LABEL[^=]*=\s*\{([\s\S]*?)\n\}/.exec(panel);
    expect(mapa, "no pude leer `CAUSE_LABEL` de MovementsPanel.tsx").not.toBeNull();

    const sinUnion: string[] = [];
    const sinEtiqueta: string[] = [];
    for (const causa of declaradas) {
      if (!new RegExp(`["']${causa}["']`).test(api)) sinUnion.push(causa);
      const entrada = new RegExp(`\\b${causa}\\s*:\\s*("([^"]*)"|'([^']*)')`).exec(mapa![1]);
      if (!entrada || !(entrada[2] ?? entrada[3] ?? "").trim()) sinEtiqueta.push(causa);
    }
    expect(
      sinUnion,
      "estas causas las publica `app/shifts/schemas.py::CashMovementCauseLiteral` y `api/shifts.ts::" +
        "CashMovementCause` no las conoce:\n" +
        sinUnion.join("\n"),
    ).toEqual([]);
    expect(
      sinEtiqueta,
      "estas causas no tienen etiqueta legible en `CAUSE_LABEL` (MovementsPanel.tsx): el movimiento se " +
        "pinta con la celda en blanco y el responsable de caja tiene que explicar una diferencia que el " +
        "sistema no nombra (`docs/SPEC-NEGOCIO.md §3.2`; CST art. 149: el sistema nunca calcula deuda de " +
        "un empleado):\n" +
        sinEtiqueta.join("\n"),
    ).toEqual([]);
  });
});

describe("la excepción de escala del conteo, declarada con nombre propio (H-7)", () => {
  // **DECISIÓN DEL ORQUESTADOR, RONDA 2 — declarada acá por escrito.**
  //
  // Qué prohíbe el invariante heredado: `inventory.test.ts` → «nadie
  // multiplica ni divide por la escala de cantidades o de costos». `QTY_SCALE
  // = 1000` y `COST_SCALE = 1_000_000` viven en `backend/app/core/quantity.py`
  // y no se cruzan al frontend: la API manda y recibe TEXTO decimal ya
  // convertido, así que un `* 1000` en el cliente es la escala escrita dos
  // veces y el día que cambie sólo cambia una.
  //
  // Qué lo rompe: `frontend/src/features/inventory/lib.ts :: COUNT_QTY_SCALE`,
  // usado por `parseCountInput` — la calculadora que deja teclear «6+8» al
  // capturar un conteo (`docs/SPEC-NEGOCIO.md §5.4`). Suma en milésimas
  // ENTERAS justamente para no acumular `float` («0.1+0.2» tiene que dar
  // «0.3»), y para eso necesita la escala.
  //
  // La decisión: **la calculadora se queda** —contar «6+8 cajas» es ergonomía
  // real de conteo físico— y la excepción se declara con NOMBRE PROPIO, no
  // acotando el barrido por patrón de ruta. El fundamento: el cliente manda
  // SIEMPRE texto decimal y el servidor revalida con `app.core.quantity.
  // parse_qty_base`, así que el espejo no es una segunda matemática de
  // negocio sino ayuda de tecleo — su peor caso es un `422` de más, nunca un
  // dato mal guardado. La matemática autoritativa sigue siendo la del
  // servidor.
  //
  // Los tres tests de abajo son el precio de la excepción: mientras se
  // cumplan, la excepción es legítima; si alguno cae, deja de serlo.
  const LIB = path.join(SRC, "features/inventory/lib.ts");

  it("la excepción vive en UN solo símbolo, con el nombre exacto que se declaró", () => {
    const code = readFileSync(LIB, "utf8");
    expect(
      /export const COUNT_QTY_SCALE\s*=\s*1000\b/.test(code),
      "la excepción declarada es `features/inventory/lib.ts :: COUNT_QTY_SCALE`. Si el símbolo cambió de " +
        "nombre o de valor, la excepción ya no cubre lo que está escrito y hay que volver a decidirla",
    ).toBe(true);
    // Y no se expandió: nadie más en el territorio de 2b escribe la escala.
    const otros = hits(
      filesOf(TERRITORY_2B).filter((f) => f.file !== LIB),
      /[*/]\s*1[_ ]?000[_ ]?(000)?\b|QTY_SCALE|COST_SCALE|\bmicros\b/i,
    );
    expect(
      otros,
      "la excepción de escala se declaró para UN símbolo y apareció en otro archivo: una excepción que no " +
        "se enumera es una excepción que se expande sola:\n" + otros.join("\n"),
    ).toEqual([]);
  });

  it("lo que sale de la calculadora es texto decimal, nunca milésimas", () => {
    // El fundamento de la excepción es que el cliente manda texto decimal y
    // el servidor revalida. Si `parseCountInput` devolviera el entero en
    // milésimas, la escala del cliente dejaría de ser ayuda de tecleo y
    // pasaría a ser el dato que se guarda — y ahí la excepción se cae.
    const code = stripComments(readFileSync(LIB, "utf8"));
    const cuerpo = /export function parseCountInput[\s\S]*?\n\}/.exec(code);
    expect(cuerpo, "no encuentro `parseCountInput` en features/inventory/lib.ts").not.toBeNull();
    expect(
      /value:\s*fracStr\s*\?|String\(|`\$\{/.test(cuerpo![0]),
      "`parseCountInput` ya no devuelve TEXTO decimal: la excepción de escala se declaró para una ayuda de " +
        "tecleo cuyo resultado el servidor revalida, no para un valor numérico que se guarde tal cual",
    ).toBe(true);
    expect(
      /value:\s*scaledSum\b/.test(cuerpo![0]),
      "`parseCountInput` devuelve las milésimas crudas: eso convierte la escala del cliente en el dato " +
        "guardado y la excepción deja de ser legítima",
    ).toBe(false);
  });

  it("la captura de conteo manda el valor como texto, no como número JSON", () => {
    const offenders = hits(
      filesOf([COUNT_CAPTURE]),
      /qty_counted\s*:\s*(Number|parseFloat|parseInt)\s*\(/,
    );
    expect(
      offenders,
      "la pantalla de captura manda `qty_counted` como número: el contrato es texto decimal y el servidor " +
        "lo revalida con `parse_qty_base` — mandarlo como `number` mete un float en el borde:\n" +
        offenders.join("\n"),
    ).toEqual([]);
  });
});

/** El enum cerrado de causas del LIBRO, tal como lo publica el backend. */
const BACKEND_INVENTORY_SCHEMAS = path.resolve(SRC, "../../backend/app/inventory/schemas.py");

describe("el cruce backend → cliente de las causas del libro (ronda 2)", () => {
  it("el cliente declara EXACTAMENTE las causas de movimiento que el backend publica", () => {
    // **El mismo cruce que H-8, del otro lado del libro.** `app/inventory/
    // schemas.py::MovementCauseLiteral` es lo que tipa `StockMovementOut.
    // cause` **y** lo que valida el query `?cause=` de
    // `GET /admin/ingredients/{id}/movements` (`app/inventory/router.py:187`).
    // El cliente lo espeja en `api/inventory.ts::MovementCause` y lo usa en
    // `features/inventory/lib.ts::CAUSE_LABEL`, que
    // `MovementsPanel.tsx:80` recorre con `Object.entries` para armar el
    // desplegable del filtro.
    //
    // Por eso la igualdad tiene que ser EXACTA en las dos direcciones:
    //
    // - una causa del backend que falte en el cliente se pinta sin nombre
    //   (el bug de H-8, del lado de caja);
    // - una causa del cliente que el backend NO declare se convierte en una
    //   opción del desplegable que **siempre falla**: el admin la elige,
    //   el cliente manda `?cause=<esa>` y FastAPI la rechaza antes de
    //   entrar al endpoint. Un filtro que no filtra nada y devuelve un
    //   error es peor que no tener el filtro.
    expect(
      existsSync(BACKEND_INVENTORY_SCHEMAS),
      `no encuentro el contrato de causas del libro en ${BACKEND_INVENTORY_SCHEMAS}`,
    ).toBe(true);
    const schemas = readFileSync(BACKEND_INVENTORY_SCHEMAS, "utf8");
    const bloque = /MovementCauseLiteral\s*=\s*Literal\[([\s\S]*?)\]/.exec(schemas);
    expect(bloque, "no pude leer `MovementCauseLiteral` de app/inventory/schemas.py").not.toBeNull();
    const backend = [...bloque![1].matchAll(/"([a-z_]+)"/g)].map((m) => m[1]).sort();
    expect(
      backend.length,
      "el barrido leyó menos de ocho causas: el formato del `Literal` cambió y esto se volvió un falso verde",
    ).toBeGreaterThanOrEqual(8);

    const api = readFileSync(path.join(SRC, "api/inventory.ts"), "utf8");
    const union = /export type MovementCause\s*=([\s\S]*?)\n\n/.exec(api);
    expect(union, "no pude leer `MovementCause` de api/inventory.ts").not.toBeNull();
    const cliente = [...union![1].matchAll(/"([a-z_]+)"/g)].map((m) => m[1]).sort();

    const faltan = backend.filter((c) => !cliente.includes(c));
    const sobran = cliente.filter((c) => !backend.includes(c));
    expect(
      faltan,
      "el backend publica estas causas y `api/inventory.ts::MovementCause` no las conoce: el movimiento " +
        "se pinta con la causa cruda en la tabla del libro:\n" + faltan.join("\n"),
    ).toEqual([]);
    expect(
      sobran,
      "`api/inventory.ts::MovementCause` declara causas que el backend NO publica en " +
        "`MovementCauseLiteral`:\n" + sobran.join("\n") + "\n" +
        "`features/inventory/lib.ts::CAUSE_LABEL` está tipado `Record<MovementCause, string>`, así que " +
        "cada una de ésas es una opción del desplegable de filtro (`MovementsPanel.tsx:80`, " +
        "`Object.entries(CAUSE_LABEL)`) que manda `?cause=<esa>` y el servidor rechaza antes de entrar al " +
        "endpoint (`app/inventory/router.py:187`, `cause: MovementCauseLiteral | None`). Un filtro que " +
        "siempre falla es peor que no tener el filtro",
    ).toEqual([]);

    // Y cada causa publicada tiene etiqueta legible, no vacía.
    const lib = readFileSync(path.join(SRC, "features/inventory/lib.ts"), "utf8");
    const mapa = /CAUSE_LABEL[^=]*=\s*\{([\s\S]*?)\n\}/.exec(lib);
    expect(mapa, "no pude leer `CAUSE_LABEL` de features/inventory/lib.ts").not.toBeNull();
    const sinEtiqueta = backend.filter((causa) => {
      const entrada = new RegExp(`\\b${causa}\\s*:\\s*("([^"]*)"|'([^']*)')`).exec(mapa![1]);
      return !entrada || !(entrada[2] ?? entrada[3] ?? "").trim();
    });
    expect(
      sinEtiqueta,
      "estas causas del libro no tienen etiqueta legible en `CAUSE_LABEL`:\n" + sinEtiqueta.join("\n"),
    ).toEqual([]);
  });
});
