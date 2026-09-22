// @vitest-environment node
/**
 * Invariantes de las pantallas del documento fiscal, clientes y reportes del
 * administrador (pedido 1b-2), verificados **leyendo el código fuente**.
 *
 * Mismo método que `sales.test.ts` (1b-1) y por el mismo motivo: hay reglas
 * cuyo enunciado es «cierta línea no existe en ninguna parte», y ningún
 * render las puede probar. Las que se auditan acá:
 *
 * 1. **Una sola matemática, en el backend** (`AGENTS.md`,
 *    `docs/SPEC-NEGOCIO.md §11.13`): las pantallas nuevas —Documentos
 *    fiscales, Rangos, Notas, Devoluciones pendientes, Clientes, Hoy y
 *    Ventas— pintan `gross`, `net`, `tax`, `tips`, `amount`, `total`,
 *    `base` y `avg_ticket` tal como llegan. **`null` no es 0**: "sin datos"
 *    se dice, no se dibuja como cero (§9.3).
 * 2. **La leyenda legal la escribe el servidor** (§8.3). En 1b-2 la leyenda
 *    depende del estado ante la DIAN y de la contingencia, así que una
 *    leyenda fija en el cliente dejó de ser una prolijidad: es una
 *    afirmación legal que el servidor no hizo.
 * 3. **Minimización** (§8.4): el maestro de clientes es del administrador en
 *    PC; el POS no lo lee, no lo exporta y no lo importa.
 * 4. **Interfaz** (§9.1, WCAG 2.1 AA): el estado nunca se comunica sólo por
 *    color; ninguna tabla ancha sin `overflow-x-auto`; ningún ancho fijo que
 *    fuerce scroll horizontal a 375 px; ningún color crudo (sólo tokens, que
 *    es lo que mantiene el contraste en claro y oscuro).
 * 5. **Nada de sesión ni de datos personales en el navegador** (§11.11).
 *
 * Cada excepción tolerada va **enumerada con archivo y motivo**: una
 * excepción que no se enumera es una excepción que se expande sola.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** El territorio de 1b-2 que este archivo audita. */
const TERRITORY_1B2 = [
  "features/fiscal",
  "features/customers",
  "features/reports",
  "api/fiscal.ts",
  "api/customers.ts",
  "api/reports.ts",
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

/** Quita comentarios conservando la cuenta de líneas (O-2 de 1b-1: un
 * `archivo:línea` corrido es un hallazgo que nadie puede verificar). */
function stripComments(code: string): string {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

function stripCommentsAndStrings(code: string): string {
  return stripComments(code)
    .replace(/`(?:[^`\\]|\\.)*`/g, (template) => {
      const parts = template.match(/\$\{[^{}]*\}/g) ?? [];
      return ` ${parts.join(" ")} `;
    })
    .replace(/'(?:[^'\\\n]|\\.)*'/g, " '' ")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, ' "" ');
}

function territoryPaths(prefixes: string[] = TERRITORY_1B2): string[] {
  const files: string[] = [];
  for (const entry of prefixes) files.push(...listFiles(path.join(SRC, entry)));
  return files.filter((file) => {
    const unix = file.split(path.sep).join("/");
    return !unix.includes("/__tests__/") && !/\.test\.tsx?$/.test(file);
  });
}

function territoryFiles(prefixes?: string[]): SourceFile[] {
  return territoryPaths(prefixes).map((file) => ({
    file,
    code: stripCommentsAndStrings(readFileSync(file, "utf8")),
  }));
}

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

describe("los reportes y el documento fiscal no calculan plata en el cliente", () => {
  /**
   * Campos de plata que el servidor manda ya calculados, en los esquemas de
   * 1b-2 (`SalesBucketOut`, `TodayOut`, `AccountantReportOut`,
   * `AdminFiscalDocumentOut`, `NoteOut`, `PendingRefundOut`).
   */
  const MONEY = String.raw`[\w$.?]*(?:subtotal|gross|\bnet\b|tax_total|tips|tip_amount|avg_ticket|avg_per_cover|documents_base|documents_tax|notes_base|notes_tax|expected_cash|amount|total)[\w$.?]*`;
  const GAP = String.raw`(?:\s*\?\?\s*\d+)?\s*\)?`;
  const ARITHMETIC_AFTER = new RegExp(String.raw`${MONEY}${GAP}\s*[-+*/]\s*\(?\s*[A-Za-z0-9_$]`, "i");
  const ARITHMETIC_BEFORE = new RegExp(String.raw`[A-Za-z0-9_$)\]]${GAP}\s*[-+*/]\s*\(?\s*${MONEY}`, "i");
  const ROUNDING = /Math\s*\.\s*(round|floor|ceil|trunc)\s*\(|\.\s*toFixed\s*\(/;

  /**
   * Excepciones toleradas, una por una, con su motivo. Ninguna toca plata.
   */
  const ALLOWED = [
    // `RangesPage` deriva el AVANCE del rango (`consumed / total`) y los días
    // que faltan para vencer. No es plata: son NÚMEROS DE DOCUMENTO y DÍAS,
    // que el servidor manda como `consumed`, `from_number`, `to_number` y
    // `valid_until`. La alerta de verdad (80 % / 30 días) la decide el
    // backend y llega como notificación `fiscal_range_low`; esto es sólo la
    // barra de progreso.
    "features/fiscal/RangesPage.tsx",
    // `formatPercent(ratio)` sobre una proporción que YA mandó el backend
    // (`sent_at_payment_ratio`), y el bimestre a partir del mes. Nada de plata.
    "features/reports/lib.ts",
    "features/reports/AccountantReportTab.tsx",
    // La escala del eje de una gráfica: dónde van las cuatro líneas de guía
    // y cómo se rotulan («200k»). Son las marcas de la regla contra la que
    // se dibujan las barras, no una cifra que alguien lea como plata: las
    // barras usan los enteros del servidor sin tocar, y toda cifra que sí se
    // lee en pesos pasa por `formatCOP` sobre ese mismo entero.
    //
    // Vive en su propio archivo —treinta líneas— justamente para que la
    // excepción sea ésta y no `charts.tsx` entero, donde mañana alguien
    // podría derivar un saldo sin que este guardián se entere.
    "features/reports/escalaEje.ts",
  ];

  function offenders(pattern: RegExp): string[] {
    return hits(territoryFiles(), pattern).filter(
      (hit) => !ALLOWED.some((allowed) => hit.startsWith(`${allowed}:`)),
    );
  }

  it("ninguna pantalla nueva hace aritmética sobre un campo de plata", () => {
    const found = [...offenders(ARITHMETIC_AFTER), ...offenders(ARITHMETIC_BEFORE)];
    expect(
      found,
      `Plata derivada en el frontend (§11.13). Si el número hace falta, lo manda el ` +
        `backend; si de verdad es una excepción, se agrega con nombre a ALLOWED y al ` +
        `entregable del auditor:\n${found.join("\n")}`,
    ).toEqual([]);
  });

  it("ninguna pantalla nueva redondea plata", () => {
    const found = offenders(ROUNDING);
    expect(
      found,
      `El redondeo a peso es del backend (round_half_up, app/orders/money.py). ` +
        `Los reportes reciben enteros:\n${found.join("\n")}`,
    ).toEqual([]);
  });

  it("lo tolerado en `RangesPage` sigue siendo el avance del rango, nunca plata", () => {
    const code = stripCommentsAndStrings(
      readFileSync(path.join(SRC, "features/fiscal/RangesPage.tsx"), "utf8"),
    );
    const cuentas = code
      .split("\n")
      .map((text, index) => ({ text: text.trim(), index }))
      .filter(({ text }) => ROUNDING.test(text) || /[-+*/]\s*\(?\s*[A-Za-z0-9_$]/.test(text));
    // `total` a secas es, en este archivo, la CANTIDAD de números del rango
    // (`to_number - from_number + 1`): no es plata. Lo que no puede aparecer
    // es un campo de plata de la API.
    const conPlata = cuentas.filter(({ text }) =>
      /\b(subtotal|gross|net|tax_total|tips|tip_amount|amount|documents_base|documents_tax)\b/i.test(
        text,
      ),
    );
    expect(
      conPlata.map(({ text, index }) => `features/fiscal/RangesPage.tsx:${index + 1}: ${text}`),
      "la tolerancia de `RangesPage` era para el avance del rango (números de documento " +
        "y días), no para plata",
    ).toEqual([]);
  });

  it("«sin datos» no se dibuja como cero: nada de `?? 0` sobre un campo de plata", () => {
    /**
     * §9.3 y §6.1: «"sin datos" se dice, no se dibuja como cero»; `null` no es
     * 0. Los contadores (`unsent_count`, `tables_occupied`, …) **sí** pueden
     * caer a 0 — «cero comandas sin enviar» es un hecho, no una ausencia; lo
     * que no puede es un peso.
     */
    const MONEY_FALLBACK = new RegExp(
      String.raw`\b[\w.?]*(?:gross|\bnet\b|tax|tips|amount|avg_ticket|avg_per_cover|expected_cash|subtotal|_base)\b[\w.?]*\s*\?\?\s*0`,
      "i",
    );
    const found = hits(territoryFiles(), MONEY_FALLBACK);
    /**
     * **Observación O-1 de 1b-2**, tolerada con nombre: `SalesTab` mapea las
     * filas a datos de gráfico con `value: r.net ?? 0`. Hoy `SalesBucket.net`
     * es obligatorio en el tipo, así que la rama nunca corre; pero la
     * convención de despliegue desfasado del proyecto (§12: «todo campo nuevo
     * de respuesta es opcional en el cliente; "ausente" se dibuja distinto de
     * "vacío" o "0"») dice que ese `?? 0` es exactamente la costumbre que hace
     * que un día el gráfico dibuje una barra en cero donde no hubo dato.
     */
    const TOLERADO = "features/reports/SalesTab.tsx";
    const nuevos = found.filter((hit) => !hit.startsWith(`${TOLERADO}:`));
    expect(
      nuevos,
      `\`?? 0\` sobre plata del servidor: si el campo puede faltar, se muestra "—" ` +
        `(\`formatCOP(null)\` ya lo hace), no "$0":\n${nuevos.join("\n")}`,
    ).toEqual([]);
    expect(
      found.filter((hit) => hit.startsWith(`${TOLERADO}:`)).length,
      "la tolerancia de `SalesTab` era para el mapeo del gráfico; si creció, dejó de ser una excepción",
    ).toBeLessThanOrEqual(2);
  });
});

describe("la leyenda legal y el estado ante la DIAN los escribe el servidor", () => {
  const LEGENDS =
    /NO ES FACTURA|PENDIENTE DE TRANSMISI|COMPROBANTE INTERNO|EXPEDIDO EN CONTINGENCIA|RECHAZADO POR LA DIAN|VALIDADO POR LA DIAN|616-1/i;

  /**
   * Única tolerancia, con nombre: `api/fiscal.ts` mantiene dos diccionarios de
   * **etiqueta de interfaz** (`DOCUMENT_TYPE_LABEL`, `DIAN_STATUS_LABEL`) para
   * que el listado del administrador pueda decir «Pendiente de transmisión» al
   * lado del color — es justamente lo que exige «el estado nunca sólo por
   * color» (WCAG 1.4.1), y esas rutas de admin no mandan `type_label`. No son
   * la leyenda legal: la leyenda del comprobante sale siempre de `doc.legend`,
   * y el test de abajo lo verifica.
   */
  const LABELS_FILE = "api/fiscal.ts";

  it("ninguna pantalla nueva escribe una leyenda legal a mano", () => {
    const found = hits(territoryFilesRaw(), LEGENDS).filter(
      (hit) => !hit.startsWith(`${LABELS_FILE}:`),
    );
    expect(
      found,
      `En 1b-2 la leyenda depende del estado DIAN y de la contingencia ` +
        `(\`app/fiscal/service.py::LEGEND_*\`): escrita en el cliente, el papel afirma ` +
        `algo que el servidor no dijo y una corrección legal exige desplegar el ` +
        `frontend (§8.3):\n${found.join("\n")}`,
    ).toEqual([]);
  });

  it("la tolerancia de `api/fiscal.ts` son etiquetas de estado, no la leyenda impresa", () => {
    const code = stripComments(readFileSync(path.join(SRC, LABELS_FILE), "utf8"));
    const toleradas = code
      .split("\n")
      .map((text, index) => ({ text: text.trim(), index }))
      .filter(({ text }) => LEGENDS.test(text));
    // Cada línea tolerada tiene que ser una entrada de uno de los dos
    // diccionarios de etiqueta, nunca una frase legal suelta.
    for (const { text, index } of toleradas) {
      expect(
        text,
        `\`${LABELS_FILE}:${index + 1}\` dejó de ser una etiqueta de estado: ${text}`,
      ).toMatch(/^\w+\s*:\s*["'`]/);
    }
    expect(code).toMatch(/DIAN_STATUS_LABEL/);

    // Y el comprobante impreso sigue leyendo la leyenda del servidor, no estas
    // etiquetas: son dos cosas distintas y no se pueden confundir.
    const printable = stripComments(
      readFileSync(path.join(SRC, "features/payments/DocumentPage.tsx"), "utf8"),
    );
    const linea = printable.split("\n").find((text) => /doc\.legend/.test(text));
    expect(linea, "`DocumentPage` tiene que imprimir `doc.legend`").toBeTruthy();
    expect(linea, "y esa línea no puede armar la leyenda con una etiqueta local").not.toMatch(
      /DIAN_STATUS_LABEL|DOCUMENT_TYPE_LABEL/,
    );
  });

  it("el comprobante imprime la leyenda y el estado que llegan, sin inventar evidencia", () => {
    const code = stripComments(
      readFileSync(path.join(SRC, "features/payments/DocumentPage.tsx"), "utf8"),
    );
    expect(code, "`DocumentPage` lee la leyenda del documento").toMatch(/doc\.legend/);
    expect(code, "y el estado ante la DIAN, que en 1b-2 la hace variar").toMatch(
      /dian_status|fiscal\??\.(dian_status|contingency)/,
    );
    // Un CUDE o un QR armado en el cliente sería evidencia inventada.
    expect(code, "el CUDE y el QR vienen del proveedor, nunca se arman acá").not.toMatch(
      /CUDE\s*[-+]|cude\s*=\s*[`"']/,
    );
  });
});

describe("minimización: el maestro de clientes es del administrador, no del salón", () => {
  it("ninguna pantalla del POS importa ni llama el maestro de clientes", () => {
    const pos = territoryFilesRaw(["features/payments", "features/orders", "app"]);
    const found = hits(
      pos,
      /from\s+["'][^"']*api\/customers|listCustomers\s*\(|["'`]\/admin\/customers/,
    );
    expect(
      found,
      `§8.4: «el operador no exporta el maestro de clientes». La tablet vive en el ` +
        `mostrador y su sesión dura 180 días: un listado de correos y direcciones ahí ` +
        `es una base de datos personal a la vista del salón:\n${found.join("\n")}`,
    ).toEqual([]);
  });

  it("ninguna pantalla nueva guarda nada en el navegador", () => {
    const found = hits(territoryFiles(), /\b(localStorage|sessionStorage|indexedDB|document\.cookie)\b/);
    expect(
      found,
      `§11.11: la sesión va en cookie \`httpOnly\`. Un cliente cacheado en ` +
        `\`localStorage\` sobrevive a la supresión que el titular pidió (§8.4):\n${found.join("\n")}`,
    ).toEqual([]);
  });

  it("la supresión de un cliente pide una confirmación explícita antes de disparar", () => {
    const code = stripComments(
      readFileSync(path.join(SRC, "features/customers/CustomersPage.tsx"), "utf8"),
    );
    expect(code, "la pantalla tiene que ofrecer la supresión (§8.4, derecho del titular)").toMatch(
      /eraseCustomer/,
    );
    // Es irreversible y borra datos de una persona: no puede ser un clic suelto.
    expect(
      code,
      "`erase` es irreversible: tiene que exigir un motivo y una confirmación explícita, " +
        "no dispararse con un solo clic",
    ).toMatch(/reason|motivo/i);
    expect(code).toMatch(/confirm|Dialog|AlertDialog/i);
  });
});

describe("interfaz: el estado se lee, no se adivina por el color", () => {
  it("ninguna pantalla nueva usa un color crudo", () => {
    const found = hits(territoryFiles(), /#[0-9a-fA-F]{3,8}\b|\brgb\s*\(|\bhsl\s*\(/);
    expect(
      found,
      `§9.3 («claro y oscuro») y WCAG 2.1 AA: el contraste se garantiza con los tokens ` +
        `del tema, no con un color escrito a mano que sólo se probó en claro:\n${found.join("\n")}`,
    ).toEqual([]);
  });

  it("ningún `Badge` de estado se pinta sin texto", () => {
    // Un `<Badge variant="destructive" />` comunica «algo anda mal» sólo por
    // color: invisible para quien no distingue rojo de verde (WCAG 1.4.1).
    const found = hits(territoryFilesRaw(), /<Badge[^>]*\/>/);
    expect(found, `Badge sin texto:\n${found.join("\n")}`).toEqual([]);
  });

  it("toda tabla ancha del administrador viaja dentro de un contenedor con scroll propio", () => {
    // La ola 2 del rediseño del admin cambió la FORMA de la tabla, no la
    // regla: `<Table>` envuelto a mano en `overflow-x-auto` pasó a ser
    // `<DenseTable>` (`@/components/admin`), que trae el contenedor que
    // scrollea ADENTRO —`overflow-auto` sobre el cuerpo, con la cabecera
    // pegada— y además impide por `style` que una celda de datos parta una
    // palabra o haga crecer la fila (`docs/PATRONES-ADMIN.md` § 8).
    //
    // Este chequeo contaba sólo `<Table>`, así que al migrar las pantallas
    // se quedaba sin nada que proteger y fallaba por su propia guarda. Ahora
    // cuenta las dos formas, y `DenseTable` cumple la regla por
    // construcción: el scroll vive en el componente, no en cada sitio de
    // llamada, que es justamente lo que hace que no se pueda volver a perder.
    const archivos = territoryFilesRaw().filter(({ code }) => /<(?:Dense)?Table\b/.test(code));
    expect(archivos.length, "no se encontró ninguna tabla en las pantallas nuevas").toBeGreaterThan(3);
    const sinScroll = archivos
      .filter(({ code }) => !/overflow-x-auto/.test(code) && !/<DenseTable\b/.test(code))
      .map(({ file }) => relative(file));
    expect(
      sinScroll,
      `una tabla sin \`overflow-x-auto\` empuja la página entera y deja scroll ` +
        `horizontal en el documento (§9.1: 375 px y 1024 px sin scroll horizontal):\n${sinScroll.join("\n")}`,
    ).toEqual([]);
  });

  it("ninguna pantalla nueva fija un ancho que no entre en 375 px", () => {
    const anchos = hits(territoryFilesRaw(), /\b(?:min-)?w-\[(\d{3,})px\]|minWidth:\s*(\d{3,})/);
    const grandes = anchos.filter((hit) => {
      const match = hit.match(/(\d{3,})/);
      return match !== null && Number(match[1]) > 360;
    });
    expect(
      grandes,
      `el POS y el admin tienen que entrar en 375 px sin scroll horizontal ` +
        `(checklist del pedido):\n${grandes.join("\n")}`,
    ).toEqual([]);
  });
});

describe("el territorio de 1b-2 existe y se audita de verdad", () => {
  it("encuentra las pantallas de documento fiscal, clientes y reportes", () => {
    // Guardia contra el falso verde: sin esto, todos los tests de arriba
    // pasarían sin haber leído una línea si el territorio no existiera.
    const files = territoryFiles().map(({ file }) => relative(file));
    for (const pantalla of [
      "features/fiscal/DocumentsPage.tsx",
      "features/fiscal/RangesPage.tsx",
      "features/fiscal/NotesPage.tsx",
      "features/fiscal/PendingRefundsPage.tsx",
      "features/customers/CustomersPage.tsx",
      "features/reports/TodayPage.tsx",
      "features/reports/SalesPage.tsx",
    ]) {
      expect(files, `falta la pantalla \`${pantalla}\` del pedido 1b-2`).toContain(pantalla);
    }
    for (const api of ["fiscal", "customers", "reports"]) {
      expect(files).toContain(`api/${api}.ts`);
    }
    expect(files.length).toBeGreaterThan(12);
  });
});
