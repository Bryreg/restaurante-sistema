// @vitest-environment node
/**
 * Invariantes de la venta que se verifican **leyendo el código fuente**.
 *
 * Auditor del pedido 1b-1. Igual que `security.test.ts`, esto no monta React:
 * hay reglas cuyo enunciado es «cierta línea no existe en ninguna parte», y
 * ningún render las puede probar. En 1b-1 son cuatro:
 *
 * 1. **Una sola matemática, en el backend** (`AGENTS.md`,
 *    `docs/SPEC-NEGOCIO.md §11.13`, `CONTRATO-INTERNO-1b-1.md §6.1`): el POS
 *    nunca calcula subtotales, impuestos, descuentos, propina sugerida,
 *    totales de sub-cuenta, partes iguales ni cambio. Los pinta tal como
 *    llegan. La **única** excepción declarada es la suma de lo que la persona
 *    teclea en los `splits` para decir «faltan $X» — que no decide nada: el
 *    backend valida con `400 SPLITS_DO_NOT_MATCH`.
 * 2. **Minimización** (§8.4, A-9 de 1a): la lista de personal del dispositivo
 *    y su selector no conocen `document`, `email` ni `discount_limit_pct`.
 * 3. **Nada de sesión en el almacenamiento del navegador** (§11.11): las
 *    pantallas nuevas tampoco.
 * 4. **La leyenda legal la escribe el servidor** (§3.3, §8.3): la del
 *    documento y la de la precuenta se muestran tal como llegan. Una leyenda
 *    fija en el front es una afirmación legal que nadie puede corregir sin
 *    volver a desplegar.
 *
 * Cada excepción tolerada está **enumerada con archivo y símbolo** más abajo:
 * una excepción que no se enumera es una excepción que se expande sola.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** El territorio de la venta que este archivo audita. */
const SALE_TERRITORY = [
  "features/orders",
  "features/payments",
  "components/EmployeePicker.tsx",
  "api/orders.ts",
  "api/kitchen.ts",
  "api/payments.ts",
  "api/documents.ts",
  "api/employees.ts",
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
 * Quita comentarios y **el texto de las cadenas**, conservando lo que hay
 * dentro de `${...}` de una plantilla.
 *
 * Heurística documentada, con su motivo: sin esto, una ruta como
 * `` `/orders/${id}/discounts/${d}` `` se leería como «descuento dividido por
 * algo», y un texto de interfaz como «Total a cobrar» como aritmética. Lo que
 * sí se conserva es la interpolación, porque `${total - tip}` sería una
 * cuenta de verdad escondida en una plantilla.
 */
function stripCommentsAndStrings(code: string): string {
  return stripComments(code)
    .replace(/`(?:[^`\\]|\\.)*`/g, (template) => {
      const parts = template.match(/\$\{[^{}]*\}/g) ?? [];
      return ` ${parts.join(" ")} `;
    })
    .replace(/'(?:[^'\\\n]|\\.)*'/g, " '' ")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, ' "" ');
}

/**
 * Quita comentarios **conservando la cuenta de líneas**: un bloque `/* … *\/`
 * de seis líneas se reemplaza por seis saltos, no por un espacio. Sin esto,
 * el `archivo:línea` que reporta el auditor no coincide con el archivo real,
 * que es justo lo único que el hallazgo tiene que entregar bien.
 */
function stripComments(code: string): string {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

function territoryPaths(prefixes: string[] = SALE_TERRITORY): string[] {
  const files: string[] = [];
  for (const entry of prefixes) files.push(...listFiles(path.join(SRC, entry)));
  return files.filter((file) => {
    const unix = file.split(path.sep).join("/");
    return !unix.includes("/__tests__/") && !/\.test\.tsx?$/.test(file);
  });
}

/** Sin comentarios **ni cadenas**: para buscar aritmética (una ruta como
 * `/orders/${id}/discounts/${d}` no es una división). */
function territoryFiles(prefixes?: string[]): SourceFile[] {
  return territoryPaths(prefixes).map((file) => ({
    file,
    code: stripCommentsAndStrings(readFileSync(file, "utf8")),
  }));
}

/** Sin comentarios pero **con cadenas**: para buscar un texto escrito a mano
 * (una leyenda legal fija es, justamente, una cadena). */
function territoryFilesRaw(prefixes?: string[]): SourceFile[] {
  return territoryPaths(prefixes).map((file) => ({
    file,
    code: stripComments(readFileSync(file, "utf8")),
  }));
}

function relative(file: string): string {
  return path.relative(SRC, file).split(path.sep).join("/");
}

function hits(files: SourceFile[], pattern: RegExp): string[] {
  const found: string[] = [];
  const line = new RegExp(pattern.source, pattern.flags.replace("g", ""));
  for (const { file, code } of files) {
    code.split("\n").forEach((text, index) => {
      if (line.test(text)) found.push(`${relative(file)}:${index + 1}: ${text.trim()}`);
    });
  }
  return found;
}

describe("una sola matemática de la venta, en el backend", () => {
  /**
   * Campos de plata que el servidor manda ya calculados. `total` lleva una
   * exclusión explícita: `totalSeconds` es tiempo, no plata (`features/
   * orders/lib.ts`, que deriva el tiempo transcurrido de una mesa porque
   * `GET /tables/status` manda `opened_at` y no el transcurrido).
   */
  const MONEY = String.raw`[\w$.?]*(?:subtotal|total|tax|tip|discount|change|per_?part|base)[\w$.?]*`;
  // Tolera el `?? 0)` que el front pone entre el campo y el operador: sin
  // esto, `(totals.total ?? 0) + (tip?.amount ?? 0)` se escaparía del patrón
  // justo por la costumbre que además viola «`null` no es 0».
  const GAP = String.raw`(?:\s*\?\?\s*\d+)?\s*\)?`;
  const ARITHMETIC_AFTER = new RegExp(
    String.raw`${MONEY}${GAP}\s*[-+*/]\s*\(?\s*[A-Za-z0-9_$]`,
    "i",
  );
  const ARITHMETIC_BEFORE = new RegExp(
    String.raw`[A-Za-z0-9_$)\]]${GAP}\s*[-+*/]\s*\(?\s*${MONEY}`,
    "i",
  );
  const ROUNDING = /Math\s*\.\s*(round|floor|ceil|trunc)\s*\(|\.\s*toFixed\s*\(/;

  /**
   * Excepciones toleradas, enumeradas una por una. Cada entrada es
   * `archivo:símbolo` y dice por qué se tolera. Cualquier línea fuera de esta
   * lista es un hallazgo: el auditor no afloja el patrón, agrega (o no) una
   * excepción con nombre.
   */
  const ALLOWED = [
    // (1) LA excepción del contrato §6.1: la suma de lo tecleado en los
    //     `splits`, para la guía "faltan $X". No decide nada; el backend
    //     valida con `400 SPLITS_DO_NOT_MATCH`.
    "features/payments/lib.ts",
    // (2) El mismo guía de tecleo, en el componente que la muestra:
    //     `remaining = totalDue - typedTotal`. Misma justificación que (1).
    "features/payments/PaymentSplitsForm.tsx",
    // (3) **A-10, parcialmente saldado en 1b-2.** Lo que el cliente VE ya no
    //     se deriva: `PaymentTargetPanel` pinta venta y propina en dos líneas
    //     separadas, cada una tal como llega, y dice explícitamente cuando
    //     `totals.total` no llegó (nada de `?? 0` sobre plata mostrada). Lo
    //     que queda es `totalDue = saleTotal + (tip?.amount ?? 0)`, que
    //     **nunca se muestra**: es el objetivo interno contra el que
    //     `PaymentSplitsForm` calcula "faltan $X", la misma excepción (1).
    //     Cierra del todo cuando `PreBillOut`/`SubAccountOut` traigan el
    //     monto ya sumado (hoy `amount_due` sólo existe DESPUÉS de cobrar,
    //     en `PaymentOut`). Sigue reportado como advertencia.
    "features/payments/PaymentTargetPanel.tsx",
    // (4) Tiempo, no plata: `elapsedFromSeconds` divide segundos.
    "features/orders/lib.ts",
  ];

  /**
   * Redondeo tolerado **sólo sobre tiempo o proporciones**, nunca sobre plata.
   * Cada archivo de esta lista se verifica además línea por línea: la línea
   * tolerada tiene que hablar de segundos, minutos o de una proporción que ya
   * mandó el backend. Sin esa segunda verificación, tolerar un archivo entero
   * sería abrir la puerta a que mañana ahí se redondee un total.
   */
  const ALLOWED_NON_MONEY_ROUNDING = [
    "features/orders/lib.ts",
    "features/orders/OrdersAdminPage.tsx",
  ];
  const NON_MONEY_ROUNDING_CONTEXT = /seconds|minutos|\bmin\b|\/\s*60\b|ratio|pct|percent/i;

  function offenders(pattern: RegExp): string[] {
    return hits(territoryFiles(), pattern).filter(
      (hit) => !ALLOWED.some((allowed) => hit.startsWith(`${allowed}:`)),
    );
  }

  it("ninguna pantalla de comanda o cobro hace aritmética sobre un campo de plata", () => {
    const found = [...offenders(ARITHMETIC_AFTER), ...offenders(ARITHMETIC_BEFORE)];
    expect(
      found,
      `Plata derivada en el frontend (§11.13). Si es legítimo, va al backend; ` +
        `si de verdad es una excepción, se agrega con nombre a ALLOWED y al ` +
        `entregable del auditor:\n${found.join("\n")}`,
    ).toEqual([]);
  });

  it("ninguna pantalla de comanda o cobro redondea plata", () => {
    const todos = hits(territoryFiles(), ROUNDING);
    const tolerados = todos.filter((hit) =>
      ALLOWED_NON_MONEY_ROUNDING.some((allowed) => hit.startsWith(`${allowed}:`)),
    );
    const found = todos.filter((hit) => !tolerados.includes(hit));
    expect(
      found,
      `El redondeo a peso es del backend (round_half_up, app/orders/money.py):\n${found.join("\n")}`,
    ).toEqual([]);

    // Y lo tolerado tiene que seguir siendo tiempo o proporción, no plata.
    const disfrazados = tolerados.filter((hit) => !NON_MONEY_ROUNDING_CONTEXT.test(hit));
    expect(
      disfrazados,
      `Se toleró el redondeo en estos archivos porque redondean SEGUNDOS o una ` +
        `proporción; estas líneas ya no son ninguna de las dos:\n${disfrazados.join("\n")}`,
    ).toEqual([]);
  });

  it("**O-1 cerrado**: el diálogo de descuento ya no redondea en silencio lo tecleado", () => {
    const file = path.join(SRC, "features/orders/DiscountDialog.tsx");
    const code = stripComments(readFileSync(file, "utf8"));
    expect(
      code,
      `O-1 (\`outputs-1b-1/auditor-venta.md §3\`): \`Math.round(numericValue)\` mandaba ` +
        `un "10,6 %" tecleado como "11 %" sin que el operador viera que su número cambió`,
    ).not.toMatch(/Math\s*\.\s*round/);
    expect(
      code,
      "y en su lugar tiene que rechazar el no-entero con un mensaje, no corregirlo solo",
    ).toMatch(/Number\s*\.\s*isInteger/);
  });

  it("la única excepción declarada es `sumTyped`, y sigue siendo sólo una suma", () => {
    const lib = territoryFiles().find(({ file }) => relative(file) === "features/payments/lib.ts");
    expect(lib, "falta `features/payments/lib.ts`: la excepción declarada no existe").toBeTruthy();
    const code = lib!.code;
    expect(code).toMatch(/export\s+function\s+sumTyped\s*\(/);
    // Una sola función exportada: si mañana aparece `computeChange` acá, este
    // test lo dice antes de que la excepción se vuelva una costumbre.
    const exported = code.match(/export\s+(?:function|const)\s+(\w+)/g) ?? [];
    expect(exported, `\`lib.ts\` del cobro exporta de más: ${exported.join(", ")}`).toHaveLength(1);
    expect(code, "`sumTyped` dejó de ser una suma").not.toMatch(/[-*/]\s*[A-Za-z0-9_(]/);
  });

  it("el cambio, las partes iguales y los totales de sub-cuenta se pintan como llegan", () => {
    const files = territoryFiles();
    // `PaymentOut.change`, `split.per_part` y `SubAccountOut.totals` son del
    // servidor: acá sólo pueden leerse y formatearse.
    const derived = hits(
      files,
      /\b(change|per_?part)\s*[:=](?!=)\s*[^;,\n]*[A-Za-z0-9_)\]]\s*[-+*/]\s*[A-Za-z0-9_(]/i,
    );
    expect(derived, derived.join("\n")).toEqual([]);
  });
});

describe("minimización: el dispositivo no conoce datos personales del personal", () => {
  const FORBIDDEN = /\b(document|email|discount_limit_pct|can_charge|pin_hash|password)\b/i;

  it("`DeviceEmployee` tiene exactamente id, name y role", () => {
    const source = readFileSync(path.join(SRC, "api/employees.ts"), "utf8");
    const match = source.match(/export\s+interface\s+DeviceEmployee\s*\{([\s\S]*?)\}/);
    expect(match, "no existe `DeviceEmployee` en `api/employees.ts`").toBeTruthy();

    const fields = (match![1].match(/^\s*(\w+)\??\s*:/gm) ?? []).map((line) =>
      line.replace(/[^\w]/g, ""),
    );
    expect(fields.sort()).toEqual(["id", "name", "role"]);
    expect(match![1]).not.toMatch(FORBIDDEN);
  });

  it("`EmployeePicker` no nombra documento, correo ni límites de descuento", () => {
    const file = path.join(SRC, "components/EmployeePicker.tsx");
    const code = stripComments(readFileSync(file, "utf8"));
    const offenders = code
      .split("\n")
      .map((line, index) => ({ line: line.trim(), index }))
      .filter(({ line }) => FORBIDDEN.test(line))
      .map(({ line, index }) => `components/EmployeePicker.tsx:${index + 1}: ${line}`);
    expect(offenders, offenders.join("\n")).toEqual([]);
  });

  it("ninguna pantalla nueva pide el maestro de empleados del administrador", () => {
    // Sólo las pantallas: `api/employees.ts` es también el CRUD del admin, y
    // ahí `listEmployees` tiene que existir (lo usa Configuración).
    const pantallas = territoryFilesRaw([
      "features/orders",
      "features/payments",
      "components/EmployeePicker.tsx",
    ]);
    const offenders = hits(pantallas, /\blistEmployees\s*\(|["'`]\/admin\/employees/);
    expect(
      offenders,
      `el POS se sirve de \`GET /device/employees\` (§9.1, A-9), nunca del maestro ` +
        `del administrador:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });
});

describe("nada de la venta se guarda en el navegador", () => {
  it("las pantallas de comanda, cocina y cobro no usan localStorage ni sessionStorage", () => {
    const offenders = hits(territoryFiles(), /\b(localStorage|sessionStorage)\b/);
    expect(
      offenders,
      `la sesión va en cookie \`httpOnly\` y la comanda vive en el servidor ` +
        `(§3.3): una comanda a medio escribir en \`localStorage\` es una comanda ` +
        `que la otra tablet no ve:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });
});

describe("la leyenda legal la escribe el servidor", () => {
  /** Las tres leyendas del pedido, tal como las emite el backend. */
  const LEGENDS = /NO ES FACTURA|PENDIENTE DE TRANSMISI|COMPROBANTE INTERNO|documento equivalente/i;

  it("ninguna pantalla escribe una leyenda legal a mano", () => {
    // **A-11 cerrado en 1b-2**: ya no hay tolerancia. En 1b-1 `CheckoutPage`
    // tenía `preBill?.legend ?? "NO ES FACTURA — documento informativo"`, y
    // el auditor lo toleró con nombre. En 1b-2 la leyenda depende del estado
    // ante la DIAN y de la contingencia (`app/fiscal/service.py::LEGEND_*`):
    // una leyenda fija en el cliente dejó de ser una prolijidad y pasó a ser
    // un riesgo legal — el papel afirmaría algo que el servidor no dijo.
    const offenders = hits(territoryFilesRaw(), LEGENDS);
    expect(
      offenders,
      `la leyenda viaja en \`PreBillOut.legend\` y \`DocumentPrintableOut.legend\`: ` +
        `escrita a mano, una corrección legal exige desplegar el frontend ` +
        `(§3.3, §8.3):\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("el comprobante muestra la leyenda del servidor y no tiene alternativa fija", () => {
    const code = stripComments(
      readFileSync(path.join(SRC, "features/payments/DocumentPage.tsx"), "utf8"),
    );
    expect(code, "`DocumentPage` tiene que leer `legend` del documento").toMatch(/\.legend\b/);
    expect(code, "y no puede tener una leyenda de respaldo escrita a mano").not.toMatch(LEGENDS);
  });

  it("**A-11 cerrado**: la precuenta ya no tiene leyenda de respaldo", () => {
    const code = stripComments(
      readFileSync(path.join(SRC, "features/payments/CheckoutPage.tsx"), "utf8"),
    );
    expect(
      code,
      "`CheckoutPage` tiene que leer la leyenda de la precuenta que manda el servidor",
    ).toMatch(/preBill\??\.legend/);
    expect(
      code,
      `A-11: volvió el respaldo \`legend ?? "…"\`. En 1b-2 la leyenda depende del ` +
        `estado DIAN: un texto fijo en el cliente afirma algo que el servidor no dijo`,
    ).not.toMatch(/legend\s*\?\?\s*["'`]/);
  });
});

describe("el territorio de la venta existe y se audita de verdad", () => {
  it("encuentra los archivos de comanda, cobro y selector de personal", () => {
    const files = territoryFiles().map(({ file }) => relative(file));
    // Guardia contra el falso verde: si el territorio no existiera, todos los
    // tests de arriba pasarían sin haber mirado una línea.
    expect(files.some((f) => f.startsWith("features/orders/"))).toBe(true);
    expect(files.some((f) => f.startsWith("features/payments/"))).toBe(true);
    expect(files).toContain("components/EmployeePicker.tsx");
    for (const api of ["orders", "kitchen", "payments", "documents", "employees"]) {
      expect(files).toContain(`api/${api}.ts`);
    }
    expect(files.length).toBeGreaterThan(15);
  });
});
