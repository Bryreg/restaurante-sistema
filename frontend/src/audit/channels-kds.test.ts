// @vitest-environment node
/**
 * Invariantes del cliente para el pedido 2c — «Canales y cocina».
 *
 * Mismo criterio que `purchases-counts.test.ts` e `inventory.test.ts`: hay
 * reglas cuyo enunciado es «cierta línea no existe en ninguna parte» o «estos
 * dos conjuntos son el MISMO», y ningún render las prueba.
 *
 * Lo que cobra este archivo:
 *
 * 1. **CONTRATO C7** (`src/api/channels.ts`): el cruce entre los dos agentes
 *    de frontend. Quien importa `@/api/channels` necesita que ese archivo
 *    exista y publique lo acordado; si no, Vite no resuelve el import y la
 *    pantalla no se puede ni transformar — no es un error de tipos, es una
 *    pantalla que no existe.
 * 2. **Los conjuntos publicados que el cliente duplica**, en las DOS
 *    direcciones y sin nombrar ningún valor a mano: causas de caja, estados
 *    de comanda y canales. Se rompió en 2b en los dos sentidos y en dos
 *    rondas seguidas (H-8 y H-11), y el typecheck no vio ninguno.
 * 3. **Una sola matemática**: el cliente nunca suma el efectivo de domicilios
 *    al esperado, ni calcula una comisión, ni resuelve el precio de canal.
 * 4. **`null` no es `0`**: ni en el pendiente de domicilios ni en un precio
 *    de canal vacío.
 * 5. **El operador no ve costos ni comisiones** en las pantallas nuevas.
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

/** Quita comentarios: un comentario que nombra una regla no es la regla. */
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

/** Todo lo que 2c tocó o tenía que tocar del lado del cliente. */
const TERRITORY_2C = [
  "api/orders.ts",
  "api/shifts.ts",
  "api/catalog.ts",
  "features/orders",
  "features/shifts",
  "features/catalog",
];

// ===========================================================================
// 1. CONTRATO C7 — `src/api/channels.ts`, el cruce entre los dos frontends
// ===========================================================================

describe("CONTRATO C7 — el cliente de `channels` que los dos agentes de frontend comparten", () => {
  const CHANNELS_API = path.join(SRC, "api/channels.ts");

  it("todo import de `@/api/channels` resuelve a un archivo que existe", () => {
    // **Por qué esto es distinto de un error de tipos.** Vite resuelve los
    // imports al transformar; un especificador que no existe hace fallar el
    // módulo entero, así que la pantalla que lo importa no se puede ni
    // renderizar ni testear. Un `Cannot find module` del typecheck se puede
    // leer como "falta un `.d.ts`"; esto es una pantalla rota.
    const importadores = hits(
      filesOf(TERRITORY_2C),
      /from\s+["']@\/api\/channels["']/,
    );
    if (importadores.length === 0) return; // nadie lo importa todavía: nada que cobrar
    expect(
      existsSync(CHANNELS_API),
      "estos archivos importan `@/api/channels` y ese archivo NO existe, así que Vite no puede " +
        "transformar la pantalla (no es un error de tipos: es una pantalla que no arranca):\n" +
        importadores.join("\n"),
    ).toBe(true);
  });

  it("`src/api/channels.ts` publica lo que el selector de plataforma del POS consume", () => {
    if (!existsSync(CHANNELS_API)) {
      // El test de arriba ya declaró el rojo con el detalle; acá no se
      // duplica el mensaje, pero tampoco se pasa por alto.
      expect(
        existsSync(CHANNELS_API),
        "`src/api/channels.ts` no existe: el CONTRATO C7 está a medias (la mitad de ida sin la de vuelta)",
      ).toBe(true);
      return;
    }
    const code = readFileSync(CHANNELS_API, "utf8");
    expect(
      /export\s+(async\s+)?function\s+listDevicePlatforms|export\s+const\s+listDevicePlatforms/.test(code),
      "`src/api/channels.ts` no exporta `listDevicePlatforms`: es el nombre que el POS importa",
    ).toBe(true);
    expect(
      /export\s+(interface|type)\s+DevicePlatformOut/.test(code),
      "`src/api/channels.ts` no exporta el tipo `DevicePlatformOut`",
    ).toBe(true);
    // Y la regla dura, acotada a lo que consume el DISPOSITIVO: la comisión
    // es legítima en los tipos de `/admin/**` (§9.3 la pone en
    // Configuración); lo que no puede llevarla es `DevicePlatformOut`.
    const bloque = /export\s+interface\s+DevicePlatformOut\s*\{([\s\S]*?)\n\}/.exec(code);
    expect(bloque, "no pude leer `DevicePlatformOut`").not.toBeNull();
    expect(
      /commission/i.test(stripComments(bloque![1])),
      "`DevicePlatformOut` declara la comisión: `GET /device/platforms` es superficie de dispositivo y " +
        "la comisión es plata contra la venta (`AGENTS.md`: el operador no recibe costos ni márgenes)",
    ).toBe(false);
  });

  it("el endpoint que el cliente llama es el que el backend publica", () => {
    if (!existsSync(CHANNELS_API)) return;
    const code = readFileSync(CHANNELS_API, "utf8");
    const router = readFileSync(path.join(BACKEND, "app/channels/router.py"), "utf8");
    const rutas = [...code.matchAll(/["'`](\/(?:api\/v1\/)?[a-z0-9/{}\-_.$]+)["'`]/gi)].map((m) => m[1]);
    const faltantes = rutas
      .map((r) => r.replace(/^\/api\/v1/, "").replace(/\$\{[^}]*\}/g, "{id}"))
      .filter((r) => r.startsWith("/"))
      .filter((r) => {
        const base = r.split("?")[0];
        const patron = base.replace(/\{id\}/g, "[^\"']+");
        return !new RegExp(`@router\\.(get|post|patch|delete)\\(\\s*\n?\\s*["']${patron}`).test(router);
      });
    expect(
      faltantes,
      "el cliente de `channels` llama rutas que `app/channels/router.py` no publica:\n" +
        faltantes.join("\n"),
    ).toEqual([]);
  });
});

// ===========================================================================
// 2. LOS CONJUNTOS PUBLICADOS, EN LAS DOS DIRECCIONES
// ===========================================================================

/** Lee un `Literal[...]` de un archivo de esquemas del backend. */
function backendLiteral(relPath: string, name: string): string[] {
  const file = path.join(BACKEND, relPath);
  expect(existsSync(file), `no encuentro ${relPath}`).toBe(true);
  const code = readFileSync(file, "utf8");
  const bloque = new RegExp(`${name}\\s*=\\s*Literal\\[([\\s\\S]*?)\\]`).exec(code);
  expect(bloque, `no pude leer \`${name}\` de ${relPath}`).not.toBeNull();
  return [...bloque![1].matchAll(/"([a-z_]+)"/g)].map((m) => m[1]).sort();
}

/** Lee una unión de strings o un array `as const` del cliente. */
function clientSet(relPath: string, pattern: RegExp): string[] {
  const code = stripComments(readFileSync(path.join(SRC, relPath), "utf8"));
  const bloque = pattern.exec(code);
  expect(bloque, `no pude leer el conjunto ${pattern} de ${relPath}`).not.toBeNull();
  return [...bloque![1].matchAll(/"([a-z_]+)"/g)].map((m) => m[1]).sort();
}

function sameSet(backend: string[], cliente: string[], contexto: string): void {
  const faltan = backend.filter((v) => !cliente.includes(v));
  const sobran = cliente.filter((v) => !backend.includes(v));
  expect(
    faltan,
    `${contexto}: el backend publica estos valores y el cliente no los conoce (se pintan crudos o el ` +
      `\`Record\` deja de compilar):\n` + faltan.join("\n"),
  ).toEqual([]);
  expect(
    sobran,
    `${contexto}: el cliente declara valores que el backend NO publica; si alguno llega a un desplegable, ` +
      `es una opción que el servidor rechaza siempre — un filtro que siempre falla es peor que no ` +
      `tenerlo:\n` + sobran.join("\n"),
  ).toEqual([]);
}

describe("el cruce backend → cliente de los conjuntos que 2c movió", () => {
  it("los ESTADOS de comanda son exactamente los que el backend publica (2c agregó `compensated`)", () => {
    const backend = backendLiteral("app/orders/schemas.py", "OrderStatusLiteral");
    expect(backend).toContain("compensated");
    const cliente = clientSet("api/orders.ts", /export type OrderStatus\s*=((?:[^\n]|\n\s*\|)*)/);
    sameSet(backend, cliente, "estados de comanda");

    // Y cada estado tiene etiqueta legible: `compensated` NO puede pintarse
    // como "Anulada" (confundirlas falsearía el reporte de anulaciones) ni
    // quedarse sin nombre.
    const lib = stripComments(readFileSync(path.join(SRC, "features/orders/lib.ts"), "utf8"));
    const mapa = /ORDER_STATUS_LABEL[^=]*=\s*\{([\s\S]*?)\n\}/.exec(lib);
    expect(mapa, "no pude leer `ORDER_STATUS_LABEL` de features/orders/lib.ts").not.toBeNull();
    const sinEtiqueta = backend.filter((estado) => {
      const entrada = new RegExp(`\\b${estado}\\s*:\\s*("([^"]*)"|'([^']*)')`).exec(mapa![1]);
      return !entrada || !(entrada[2] ?? entrada[3] ?? "").trim();
    });
    expect(
      sinEtiqueta,
      "estos estados de comanda no tienen etiqueta legible:\n" + sinEtiqueta.join("\n"),
    ).toEqual([]);
  });

  it("los CANALES son exactamente los que el backend publica (2c usa `delivery` y `platform`)", () => {
    const backend = backendLiteral("app/orders/schemas.py", "Channel");
    expect(backend).toEqual(expect.arrayContaining(["delivery", "platform"]));
    const cliente = clientSet("api/orders.ts", /export type OrderChannel\s*=((?:[^\n]|\n\s*\|)*)/);
    sameSet(backend, cliente, "canales de comanda");

    const lib = stripComments(readFileSync(path.join(SRC, "features/orders/lib.ts"), "utf8"));
    const mapa = /CHANNEL_LABEL[^=]*=\s*\{([\s\S]*?)\n\}/.exec(lib);
    expect(mapa, "no pude leer `CHANNEL_LABEL`").not.toBeNull();
    const sinEtiqueta = backend.filter((canal) => {
      const entrada = new RegExp(`\\b${canal}\\s*:\\s*("([^"]*)"|'([^']*)')`).exec(mapa![1]);
      return !entrada || !(entrada[2] ?? entrada[3] ?? "").trim();
    });
    expect(sinEtiqueta, "canales sin etiqueta:\n" + sinEtiqueta.join("\n")).toEqual([]);
  });

  it("las CAUSAS de caja son exactamente las del backend (2c agregó `delivery_settlement`)", () => {
    const backend = backendLiteral("app/shifts/schemas.py", "CashMovementCauseLiteral");
    expect(backend).toContain("delivery_settlement");
    const cliente = clientSet("api/shifts.ts", /CASH_MOVEMENT_CAUSES\s*=\s*\[([\s\S]*?)\]/);
    sameSet(backend, cliente, "causas de movimiento de caja");
  });

  it("las causas SÓLO-SISTEMA del cliente son exactamente las del backend", () => {
    // `_SYSTEM_ONLY_MOVEMENT_CAUSES` decide qué causa el backend rechaza con
    // `400 CAUSE_NOT_MANUAL`. El cliente la espeja para no OFRECERLA en el
    // desplegable manual. Es el mismo espejo de H-8/H-11, en los dos
    // sentidos: si el cliente ofrece una causa sólo-sistema, el usuario
    // recibe un error; si deja de espejar una que el backend agregó, vuelve
    // a ofrecer una opción que siempre falla.
    const service = readFileSync(path.join(BACKEND, "app/shifts/service.py"), "utf8");
    const bloque = /_SYSTEM_ONLY_MOVEMENT_CAUSES\s*=\s*\{([\s\S]*?)\}/.exec(service);
    expect(bloque, "no pude leer `_SYSTEM_ONLY_MOVEMENT_CAUSES` de app/shifts/service.py").not.toBeNull();
    const backend = [...bloque![1].matchAll(/"([a-z_]+)"/g)].map((m) => m[1]).sort();
    expect(backend.length, "el barrido leyó cero causas sólo-sistema: el formato cambió").toBeGreaterThan(0);

    const cliente = clientSet("api/shifts.ts", /SYSTEM_ONLY_MOVEMENT_CAUSES[^=]*=\s*\[([\s\S]*?)\]/);
    sameSet(backend, cliente, "causas sólo-sistema");
  });

  it("el desplegable de movimiento manual no ofrece ninguna causa sólo-sistema", () => {
    const panel = path.join(SRC, "features/shifts/MovementsPanel.tsx");
    expect(existsSync(panel), "no encuentro features/shifts/MovementsPanel.tsx").toBe(true);
    const code = stripComments(readFileSync(panel, "utf8"));
    expect(
      /SYSTEM_ONLY_MOVEMENT_CAUSES/.test(code),
      "`MovementsPanel` no filtra por `SYSTEM_ONLY_MOVEMENT_CAUSES`: no hay nada que impida ofrecer una " +
        "causa que el servidor siempre rechaza con `400 CAUSE_NOT_MANUAL`",
    ).toBe(true);
    // Lo que se RECORRE para armar el desplegable no puede ser el mapa
    // entero: tiene que ser la lista ya filtrada.
    const recorridos = [...code.matchAll(/\{\s*([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*(?:\([^)]*\))?)\s*\.map\(/g)].map(
      (m) => m[1],
    );
    expect(
      recorridos.filter((r) => /^Object\.entries\(CAUSE_LABEL\)$/.test(r.replace(/\s+/g, ""))),
      "el desplegable de causa recorre `Object.entries(CAUSE_LABEL)` entero: así ofrece " +
        "`delivery_settlement`, que el backend rechaza siempre",
    ).toEqual([]);
  });
});

// ===========================================================================
// 3. UNA SOLA MATEMÁTICA, EN EL BACKEND
// ===========================================================================

describe("una sola matemática: el cliente pinta, no calcula", () => {
  it("nadie suma el efectivo de domicilios al esperado del turno", () => {
    // `compute_breakdown` deja `delivery_cash_pending` FUERA de `expected` a
    // propósito: es plata de la sede que todavía NO está en el cajón. Si el
    // cliente la sumara, la pantalla mostraría un esperado que el backend no
    // reconoce — y el error iría en la dirección que muestra MÁS plata, que
    // es justo la que `AGENTS.md` prohíbe.
    const offenders = hits(
      filesOf(["features/shifts", "features/orders"]),
      /(expected[A-Za-z_]*\s*[+\-]\s*[^=\n]*delivery_cash_pending|delivery_cash_pending\s*[+\-][^=\n]*expected)/i,
    );
    expect(
      offenders,
      "el cliente está sumando o restando el efectivo de domicilios al esperado: es una segunda " +
        "matemática del esperado y además miente (el billete no está en el cajón):\n" + offenders.join("\n"),
    ).toEqual([]);
  });

  it("el cliente no calcula ninguna comisión de plataforma", () => {
    const offenders = hits(
      filesOf([...TERRITORY_2C, "api/channels.ts"]),
      /commission[A-Za-z_]*\s*[*/]|[*/]\s*commission[A-Za-z_]*|commission_bp\s*\/\s*10_?000/i,
    );
    expect(
      offenders,
      "el cliente calcula una comisión: la única matemática de la comisión vive en " +
        "`app/channels/service.py::compute_commission` (puntos básicos enteros, redondeo half-up). Una " +
        "escala escrita dos veces es un rojo esperando (B-2 de 2a, H-7 de 2b):\n" + offenders.join("\n"),
    ).toEqual([]);
  });

  it("el cliente no resuelve el precio de canal: el servidor ya lo manda resuelto", () => {
    // `GET /catalog` devuelve `prices.{dine_in,takeout,delivery,platform}` ya
    // resueltos (`ProductPricesResolvedOut`, nunca `null`). Un `??` o un `||`
    // del lado del cliente sería la MISMA regla escrita dos veces — y con
    // `||` además convertiría un precio legítimo de `0` en el de mesa.
    const offenders = hits(
      filesOf(["features/orders", "features/payments"]),
      /prices\.(takeout|delivery|platform)\s*(\?\?|\|\|)/,
    );
    expect(
      offenders,
      "el cliente resuelve el fallback del precio por canal: lo decide el servidor (§4.3). Con `||` " +
        "además un precio de canal fijado en 0 caería al de mesa:\n" + offenders.join("\n"),
    ).toEqual([]);
  });
});

// ===========================================================================
// 4. `null` NO ES `0`
// ===========================================================================

describe("`null` no es `0` en los campos nuevos", () => {
  it("el pendiente de domicilios no se pinta con un cero mudo", () => {
    const offenders = hits(
      filesOf(["features/shifts"]),
      /delivery_cash_pending\s*\?\?\s*0|delivery_cash_pending\s*\|\|\s*0/,
    );
    expect(
      offenders,
      "`delivery_cash_pending` se convierte en `0` cuando llega `null`. `null` significa «no te lo puedo " +
        "mostrar» (el gate de `_can_see_expected`), no «no hay»: un cero mudo dice que no falta plata " +
        "cuando en realidad no se sabe:\n" + offenders.join("\n"),
    ).toEqual([]);
  });

  it("un precio de canal vacío se manda como `null`, nunca como `0`", () => {
    const offenders = hits(
      filesOf(["features/catalog"]),
      /price_(takeout|delivery|platform)\s*:\s*(Number\([^)]*\)\s*\|\|\s*0|[A-Za-z_.]+\s*\?\?\s*0)/,
    );
    expect(
      offenders,
      "un precio de canal vacío se manda como `0`: eso lo convierte en un precio de cero pesos de verdad " +
        "(el servidor respeta el `0` y sólo el `null` cae al de mesa):\n" + offenders.join("\n"),
    ).toEqual([]);
  });

  it("un precio de canal vacío se muestra como «igual que mesa», no como un guion mudo", () => {
    const tab = path.join(SRC, "features/catalog/ProductsTab.tsx");
    expect(existsSync(tab), "no encuentro features/catalog/ProductsTab.tsx").toBe(true);
    const code = readFileSync(tab, "utf8");
    expect(
      /[Ii]gual que mesa/.test(code),
      "la tabla de productos sigue pintando un precio de canal vacío con un símbolo ambiguo: la spec pide " +
        "decir que cae al precio de mesa, no dejar al administrador adivinando si es 0",
    ).toBe(true);
  });
});

// ===========================================================================
// 5. EL OPERADOR NO VE COSTOS NI COMISIONES
// ===========================================================================

describe("el operador no ve costos ni comisiones en las pantallas nuevas", () => {
  it("ninguna pantalla del POS lee un costo, un margen o una comisión", () => {
    const offenders = hits(
      filesOf(["features/orders", "features/payments", "features/shifts"]),
      /\b(unit_cost|unit_cost_micros|cost_source|theoretical_cost|gross_margin|platform_commission_bp)\b/,
    );
    expect(
      offenders,
      "una pantalla de POS lee un campo de costo/comisión (`AGENTS.md`: el operador no recibe costos ni " +
        "márgenes):\n" + offenders.join("\n"),
    ).toEqual([]);
  });

  it("el tipo de la plataforma que el POS consume no declara la comisión", () => {
    const offenders = hits(filesOf(["api/orders.ts"]), /commission/i);
    expect(
      offenders,
      "`api/orders.ts` declara la comisión en el contrato que consume el POS. El backend la deja fuera " +
        "de `PlatformOut` a propósito; declararla acá invita a pintarla:\n" + offenders.join("\n"),
    ).toEqual([]);
  });
});

// ===========================================================================
// 6. ZONA HORARIA — la fecha de negocio nunca sale del navegador
// ===========================================================================

describe("la fecha de negocio nunca se deriva del navegador", () => {
  it("ninguna pantalla nueva usa `toISOString().slice(0, 10)` para una fecha de negocio", () => {
    // H-6 de 2b, cerrado ahí y vigilado acá: el navegador de una tablet en
    // Bogotá con la zona mal puesta cambiaría el día operativo. La fecha de
    // negocio la decide el servidor (`app/core/tz.py`).
    const offenders = hits(
      filesOf(TERRITORY_2C),
      /toISOString\(\)\s*\.\s*(slice|substring|substr)\(\s*0\s*,\s*10\s*\)/,
    );
    expect(
      offenders,
      "una pantalla deriva una fecha de la zona del navegador:\n" + offenders.join("\n"),
    ).toEqual([]);
  });

  it("la hora prometida de un pedido se manda como hora de pared, no convertida a UTC por el navegador", () => {
    // `app/core/tz.py::from_bogota_wall_clock` existe justamente porque el
    // `<input type="datetime-local">` entrega hora de pared sin zona. Un
    // `new Date(x).toISOString()` en el cliente la interpreta con la zona
    // del NAVEGADOR y corre el pedido varias horas.
    const offenders = hits(
      filesOf(["features/orders"]),
      /promised_at\s*:\s*new Date\([^)]*\)\s*\.\s*toISOString\(\)/,
    );
    expect(
      offenders,
      "la hora prometida se convierte a UTC con la zona del navegador:\n" + offenders.join("\n"),
    ).toEqual([]);
  });
});

// ===========================================================================
// 7. LO QUE 2c TENÍA QUE CONSTRUIR DEL LADO DEL CLIENTE
// ===========================================================================

describe("las superficies que el pedido 2c pide en el cliente", () => {
  it("existe una pantalla de KDS con su ruta (checklist #14: POS y KDS)", () => {
    // El KDS es una PANTALLA NUEVA (spec.md, «huérfanos con dueño»:
    // `frontend/src/app/router.tsx` y la navegación). Sin ella, las cinco
    // rutas de `app/kitchen/**` no las consume nadie y el renglón del
    // checklist que pide «POS y KDS en 375 px y 1024 px» no tiene sujeto.
    const cliente = path.join(SRC, "api/kitchen.ts");
    const code = existsSync(cliente) ? stripComments(readFileSync(cliente, "utf8")) : "";
    const tieneBump = /\/kitchen\/items\/|bump/i.test(code);
    const pantalla = listFiles(path.join(SRC, "features/kitchen"));
    const router = existsSync(path.join(SRC, "app/router.tsx"))
      ? readFileSync(path.join(SRC, "app/router.tsx"), "utf8")
      : "";
    const enRuta = /kitchen|cocina|kds/i.test(router);

    expect(
      tieneBump && pantalla.length > 0 && enRuta,
      "falta la pantalla del KDS en el cliente. Estado medido: " +
        `api/kitchen.ts con bump=${tieneBump}, archivos en features/kitchen=${pantalla.length}, ` +
        `ruta en app/router.tsx=${enRuta}. Las cinco rutas de \`app/kitchen/**\` (bump, unbump, ` +
        "expedite, print-jobs) no las consume nadie, y el renglón #14 del checklist («POS y KDS en " +
        "375 px y 1024 px sin scroll horizontal, foco visible») no tiene superficie que medir.",
    ).toBe(true);
  });

  it("existe la configuración de plataformas y comisiones en Configuración (§9.3)", () => {
    // `spec.md` nombra `frontend/src/features/settings/**` como huérfano con
    // dueño: «plataformas y comisiones, estaciones, cursos y tiempos
    // objetivo son configuración de sede (§9.3)». Sin esa pantalla, la única
    // forma de crear una plataforma es un `POST` a mano: el dueño del
    // restaurante no puede usar `pos.platforms`.
    const settings = filesOf(["features/settings"]);
    const nombra = settings.filter(({ code }) => /platform|plataforma|comisi[oó]n|commission/i.test(code));
    expect(
      nombra.map((f) => f.file),
      "ninguna pantalla de Configuración nombra plataformas ni comisiones: `pos.platforms` no se puede " +
        "configurar desde la interfaz (§9.3 lista «plataformas y comisiones» en Configuración)",
    ).not.toEqual([]);
  });
});

// ===========================================================================
// 8. EL CRUCE MÁS FRÁGIL DE 2c: el KDS no publica esquema de respuesta
// ===========================================================================

describe("el contrato del KDS, que ningún typecheck puede vigilar", () => {
  // `GET /kitchen/rounds` devuelve `list[dict[str, Any]]` y las tres
  // escrituras devuelven `JSONResponse`: el backend **no publica esquema**
  // para el cuerpo de `rounds`, así que el cliente lo tipó a mano. Ni el
  // `mypy` del backend ni el `tsc` del frontend ven una deriva de nombres:
  // un `bumped_by` que pase a llamarse `bumped_employee` deja la pantalla
  // mostrando `undefined` y los dos typechecks en verde.
  //
  // Por eso el invariante compara las CLAVES literales que arma el backend
  // contra los campos que declara `api/kitchen.ts`.
  const ROUTER = path.join(BACKEND, "app/kitchen/router.py");
  const SERVICE = path.join(BACKEND, "app/kitchen/service.py");

  function backendKeys(source: string, marker: RegExp): string[] {
    const bloque = marker.exec(source);
    expect(bloque, `no pude leer el bloque ${marker} del backend`).not.toBeNull();
    return [...bloque![1].matchAll(/"([a-z_]+)"\s*:/g)].map((m) => m[1]).sort();
  }

  function clientFields(interfaceName: string): string[] {
    const code = stripComments(readFileSync(path.join(SRC, "api/kitchen.ts"), "utf8"));
    const bloque = new RegExp(`export interface ${interfaceName}\\s*\\{([\\s\\S]*?)\\n\\}`).exec(code);
    expect(bloque, `no pude leer \`${interfaceName}\` de api/kitchen.ts`).not.toBeNull();
    return [...bloque![1].matchAll(/^\s*([a-z_]+)\??\s*:/gm)].map((m) => m[1]).sort();
  }

  it("los campos por ÍTEM que el cliente declara son los que el backend arma", () => {
    const router = readFileSync(ROUTER, "utf8");
    const service = readFileSync(SERVICE, "utf8");
    const base = backendKeys(router, /items_out\.append\(\s*\{([\s\S]*?)\n\s*\}\s*\)/);
    // Los tres campos que agrega `enrich_round_for_kds` con la flag encendida.
    const extra = [...service.matchAll(/item_out\[\s*"([a-z_]+)"\s*\]\s*=/g)].map((m) => m[1]);
    const backend = [...new Set([...base, ...extra])].sort();
    expect(
      backend.length,
      "el barrido leyó menos de ocho claves: cambió la forma del backend y esto se volvió un falso verde",
    ).toBeGreaterThanOrEqual(8);

    const cliente = clientFields("KitchenRoundItemOut");
    const faltan = backend.filter((k) => !cliente.includes(k));
    const sobran = cliente.filter((k) => !backend.includes(k));
    expect(
      faltan,
      "el backend manda estas claves por ítem y `KitchenRoundItemOut` no las declara: la pantalla del KDS " +
        "no puede leerlas y ningún typecheck lo ve (la ruta no publica `response_model`):\n" +
        faltan.join("\n"),
    ).toEqual([]);
    expect(
      sobran,
      "`KitchenRoundItemOut` declara campos que el backend NO manda: la pantalla los lee `undefined` y, " +
        "si alguno se pinta, muestra un hueco en vez de un dato:\n" + sobran.join("\n"),
    ).toEqual([]);
  });

  it("los campos por RONDA que el cliente declara son los que el backend arma", () => {
    const router = readFileSync(ROUTER, "utf8");
    const service = readFileSync(SERVICE, "utf8");
    const base = backendKeys(router, /round_out:\s*dict\[str,\s*Any\]\s*=\s*\{([\s\S]*?)\n\s*\}/);
    const extra = [...service.matchAll(/round_out\[\s*"([a-z_]+)"\s*\]\s*=/g)].map((m) => m[1]);
    const backend = [...new Set([...base, ...extra])].sort();
    expect(backend.length, "el barrido leyó menos de ocho claves por ronda").toBeGreaterThanOrEqual(8);

    const cliente = clientFields("KitchenRoundOut");
    const faltan = backend.filter((k) => !cliente.includes(k));
    const sobran = cliente.filter((k) => !backend.includes(k));
    expect(faltan, "claves de la ronda que el cliente no declara:\n" + faltan.join("\n")).toEqual([]);
    expect(sobran, "campos que el cliente declara y el backend no manda:\n" + sobran.join("\n")).toEqual([]);
  });

  it("el KDS no declara ningún campo de costo ni de comisión", () => {
    const code = stripComments(readFileSync(path.join(SRC, "api/kitchen.ts"), "utf8"));
    const offenders = [...code.matchAll(/^\s*([a-z_]*(?:cost|margin|commission)[a-z_]*)\s*\??\s*:/gim)].map(
      (m) => m[1],
    );
    expect(
      offenders,
      "`api/kitchen.ts` declara un campo de costo/margen/comisión: el KDS es superficie de dispositivo:\n" +
        offenders.join("\n"),
    ).toEqual([]);
  });
});

// ===========================================================================
// 9. CHECKLIST #14 — lo que SÍ se puede cobrar sin navegador, y lo que no
// ===========================================================================

describe("375 px y 1024 px: la parte del renglón #14 que un test de fuente sí puede cobrar", () => {
  /** Las superficies nuevas de 2c. */
  const NUEVAS = [
    "features/kitchen",
    "features/shifts/DeliverySettlementPanel.tsx",
    "features/settings/ChannelsSection.tsx",
    "features/orders/NewOrderPage.tsx",
    "features/orders/OrderPage.tsx",
  ];

  it("ninguna pantalla nueva fija un ancho mayor al viewport de 375 px", () => {
    // Un `min-w-[420px]` (o un `w-[500px]`) dentro del flujo obliga a scroll
    // horizontal en la tablet de 375 px sin que nadie lo note en un monitor.
    // Lo que SÍ es legítimo es un ancho grande dentro de un contenedor
    // `overflow-x-auto` (una tabla que se desliza sola); por eso el barrido
    // sólo acusa los anchos por encima del viewport y el informe los revisa
    // uno por uno.
    const offenders = hits(filesOf(NUEVAS), /(min-w|w)-\[(\d{3,})px\]/).filter((linea) => {
      const m = /(min-w|w)-\[(\d{3,})px\]/.exec(linea);
      return m !== null && Number(m[2]) > 375;
    });
    expect(
      offenders,
      "una pantalla nueva fija un ancho mayor que el viewport de 375 px: en la tablet del salón eso es " +
        "scroll horizontal:\n" + offenders.join("\n"),
    ).toEqual([]);
  });

  it("ninguna pantalla nueva apaga el foco visible sin reemplazarlo", () => {
    // `focus:outline-none` sin un `focus-visible:` que devuelva el anillo
    // deja la navegación por teclado sin indicador — WCAG 2.1 AA, guardrail
    // duro de `.claude/AGENTS.md`.
    const offenders: string[] = [];
    for (const { file, code } of filesOf(NUEVAS)) {
      code.split("\n").forEach((line, index) => {
        if (!/outline-none/.test(line)) return;
        if (/focus-visible:/.test(line)) return;
        offenders.push(`${file}:${index + 1}  ${line.trim()}`);
      });
    }
    expect(
      offenders,
      "se apaga el foco visible sin reemplazarlo:\n" + offenders.join("\n"),
    ).toEqual([]);
  });

  it("toda tabla de las pantallas nuevas vive dentro de un contenedor que se desliza", () => {
    const conTabla = filesOf(NUEVAS).filter(({ code }) => /<Table\b|<table\b/.test(code));
    const sinContenedor = conTabla
      .filter(({ code }) => !/overflow-x-auto|overflow-auto|overflow-x-scroll/.test(code))
      .map((f) => f.file);
    expect(
      sinContenedor,
      "estas pantallas nuevas tienen una tabla sin contenedor deslizante: en 375 px la tabla empuja la " +
        "página entera y aparece scroll horizontal de documento:\n" + sinContenedor.join("\n"),
    ).toEqual([]);
  });

  // LO QUE ESTE ARCHIVO **NO** CUBRE, declarado sin maquillaje:
  //
  // - Que a 375 px y a 1024 px **no haya scroll horizontal de documento**.
  //   Eso depende del layout calculado (anchos intrínsecos, `flex` que no
  //   encoge, texto largo sin `truncate`), y jsdom no calcula layout: no
  //   tiene motor de cajas. Sólo lo ve un navegador real.
  // - Que el **contraste** sea AA (4.5:1) con el tema claro y el oscuro.
  // - Que el **orden de tabulación** sea el correcto y que el anillo de foco
  //   se VEA (existe ≠ se ve).
  //
  // Es el mismo hueco abierto desde 1a (`docs/ESTADO.md`). Decirlo es mejor
  // que fingir que estos tres tests lo cierran.
});

// ===========================================================================
// 10. LA ESCALA DE PUNTOS BÁSICOS: la excepción, declarada y con su precio
// ===========================================================================

describe("puntos básicos (100 = 1 %): una escala escrita dos veces es un rojo esperando", () => {
  // El precedente: B-2 de 2a y H-7 de 2b. La escala autoritativa vive en el
  // backend (`commission_bp: int`, `0 <= bp <= 10_000`), y el cliente la
  // FORMATEA con `formatBasisPoints` (`features/inventory/lib.ts`).
  //
  // La excepción real: para ENTRAR un porcentaje hace falta el camino
  // inverso, y `Math.round(value * 100)` aparece hoy en DOS archivos
  // (`features/settings/InventorySection.tsx`, de 2b, y
  // `features/settings/ChannelsSection.tsx`, de 2c). Ninguno de los dos
  // guarda ese número sin que el servidor lo revalide, así que su peor caso
  // es un `400` de más, nunca un dato mal guardado — el mismo fundamento con
  // el que se aceptó `COUNT_QTY_SCALE` en 2b.
  //
  // Este bloque es el PRECIO de la excepción: mientras se cumpla, la
  // excepción es legítima; si cae, deja de serlo.
  const ENTRADA_BP = ["features/settings/InventorySection.tsx", "features/settings/ChannelsSection.tsx"];

  it("la escala de entrada vive SÓLO en los dos archivos declarados", () => {
    const produccion = filesOf([
      "features/orders",
      "features/shifts",
      "features/catalog",
      "features/kitchen",
      "features/settings",
      "api/channels.ts",
      "api/orders.ts",
      "api/shifts.ts",
    ]).filter(({ file }) => !/__tests__|\.test\.tsx?$/.test(file) && !ENTRADA_BP.includes(file));
    // Aritmética sobre un valor en puntos básicos, no la aparición del
    // número 100 en cualquier contexto (eso sería un grep, no un invariante).
    const otros = hits(
      produccion,
      /[A-Za-z_$][\w$.]*_bp\b\s*[*/]\s*\d|\d\s*[*/]\s*[A-Za-z_$][\w$.]*_bp\b|Math\.round\([^)]*\*\s*100\s*\)/,
    );
    expect(
      otros,
      "la escala 100 = 1 % apareció fuera de los dos campos de entrada declarados " +
        `(${ENTRADA_BP.join(", ")}): una excepción que no se enumera es una excepción que se expande ` +
        "sola:\n" + otros.join("\n"),
    ).toEqual([]);
  });

  it("el formato de salida pasa siempre por `formatBasisPoints`, nunca por una división suelta", () => {
    for (const archivo of ENTRADA_BP) {
      const code = stripComments(readFileSync(path.join(SRC, archivo), "utf8"));
      if (!/commission_bp|variance|_bp\b/.test(code)) continue;
      expect(
        /formatBasisPoints/.test(code),
        `${archivo} muestra un valor en puntos básicos sin usar \`formatBasisPoints\`: la escala de ` +
          "salida quedaría escrita dos veces",
      ).toBe(true);
      expect(
        /\bbp\s*\/\s*100\b|\/\s*100\s*\)\s*\.toFixed/.test(code),
        `${archivo} divide por 100 a mano para mostrar un porcentaje`,
      ).toBe(false);
    }
  });

  it("lo que se manda al servidor es el ENTERO en puntos básicos, nunca un porcentaje decimal", () => {
    // El fundamento de la excepción: el contrato es `commission_bp` entero.
    // Si el cliente mandara `18.5` el backend lo rechazaría, y si mandara
    // `18` querría decir 0,18 % — el error de tecleo clásico que el rango
    // `0..10_000` del backend no puede distinguir.
    const code = stripComments(readFileSync(path.join(SRC, "features/settings/ChannelsSection.tsx"), "utf8"));
    const envios = [...code.matchAll(/commission_bp:\s*([^,\n}]+)/g)].map((m) => m[1].trim());
    expect(envios.length, "no encontré ningún envío de `commission_bp`").toBeGreaterThan(0);
    for (const envio of envios) {
      expect(
        /percentTextToBp|Number\.parseInt|commission_bp/.test(envio),
        `\`commission_bp: ${envio}\` no pasa por la conversión declarada: la escala se escribió otra vez`,
      ).toBe(true);
      expect(/toFixed|parseFloat/.test(envio), `\`commission_bp: ${envio}\` manda un decimal`).toBe(false);
    }
  });
});
