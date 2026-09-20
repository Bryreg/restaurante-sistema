import { readFileSync, readdirSync, statSync } from "node:fs"
import path from "node:path"

import { describe, expect, it } from "vitest"

const SRC = path.resolve(__dirname, "..")
const BACKEND = path.resolve(SRC, "../../backend")

/**
 * **La plata después del cajón, del lado de la pantalla** — auditor de la
 * fase 3 (T6), tema: consignaciones, banco, mano del dueño, conciliación,
 * gastos y obligaciones.
 *
 * Dos reglas, y las dos ya se rompieron en este proyecto:
 *
 * 1. **El frontend nunca deriva plata** (`AGENTS.md`, «una sola matemática,
 *    en el backend»). El saldo por consignar, la mano del dueño, la
 *    diferencia de una conciliación y el punto de equilibrio se pintan **como
 *    llegan**. Una resta hecha en la pantalla es una segunda matemática que
 *    nadie audita y que se desincroniza el día que el backend cambia un
 *    término.
 * 2. **La pantalla consume EXACTAMENTE la ruta que el backend publica**
 *    (contrato de API mínimo de `features/fase-3-dinero-control/spec.md §2`,
 *    vinculante en las dos direcciones). Este archivo **lee los decoradores
 *    reales de los routers** en vez de repetir una lista a mano — que es
 *    justo lo que se separó seis veces en este proyecto (`active-channels
 *    .test.ts` usa el mismo método).
 *
 * Rojo **por ausencia** (todavía no construido) vs. rojo **por defecto**
 * (construido mal): cada `it` lo dice en su mensaje. Un archivo que no
 * existe se reporta como ausencia; un archivo que existe y deriva plata es
 * un hallazgo con dueño.
 */

function archivosDe(dir: string, filtro: RegExp, acc: string[] = []): string[] {
  let entradas: string[]
  try {
    entradas = readdirSync(dir)
  } catch {
    return acc
  }
  for (const nombre of entradas) {
    const p = path.join(dir, nombre)
    if (statSync(p).isDirectory()) archivosDe(p, filtro, acc)
    else if (filtro.test(nombre)) acc.push(p)
  }
  return acc
}

/** Rutas que un router de FastAPI publica, leídas de sus decoradores. */
function rutasPublicadas(rutaRouter: string): Set<string> {
  let texto: string
  try {
    texto = readFileSync(rutaRouter, "utf8")
  } catch {
    return new Set()
  }
  const out = new Set<string>()
  for (const m of texto.matchAll(/@router\.(get|post|patch|put|delete)\(\s*"([^"]+)"/g)) {
    out.add(`${m[1].toUpperCase()} ${m[2]}`)
  }
  return out
}

/** Rutas que un cliente `src/api/*.ts` consume, leídas de sus `api<...>(...)`. */
function rutasConsumidas(rutaCliente: string): Set<string> {
  let texto: string
  try {
    texto = readFileSync(rutaCliente, "utf8")
  } catch {
    return new Set()
  }
  const out = new Set<string>()
  // `api<T>("/admin/x", { method: "POST" })` y `api<T>(\`/admin/x/${id}\`)`.
  for (const m of texto.matchAll(/api<[^>]*>\(\s*(["`])([^"`]+)\1([\s\S]{0,140}?)\)/g)) {
    const cruda = m[2]
    const cola = m[3]
    const metodo = /method:\s*"([A-Z]+)"/.exec(cola)?.[1] ?? "GET"
    // `${...}` -> `{}` : el NOMBRE del parámetro de path no cambia la URL.
    const normalizada = cruda.replace(/\$\{[^}]*\}/g, "{}")
    out.add(`${metodo} ${normalizada}`)
  }
  return out
}

/** La misma normalización del lado del backend: `{deposit_id}` -> `{}`. */
function normalizar(ruta: string): string {
  return ruta.replace(/\{[^}]*\}/g, "{}")
}

const TERRITORIOS = [
  { dominio: "banking", dueno: "T1 backend-banco" },
  { dominio: "expenses", dueno: "T2 backend-obligaciones" },
] as const

describe("las pantallas de plata consumen exactamente las rutas que el backend publica", () => {
  for (const { dominio, dueno } of TERRITORIOS) {
    it(`${dominio}: ninguna pantalla llama a una ruta que el backend no publica`, () => {
      const cliente = path.join(SRC, "api", `${dominio}.ts`)
      const router = path.join(BACKEND, "app", dominio, "router.py")

      const consumidas = rutasConsumidas(cliente)
      const publicadas = new Set([...rutasPublicadas(router)].map(normalizar))

      expect(
        consumidas.size,
        `AUSENCIA (no defecto): \`src/api/${dominio}.ts\` todavía no consume ninguna ruta`,
      ).toBeGreaterThan(0)
      expect(
        publicadas.size,
        `AUSENCIA (no defecto): \`app/${dominio}/router.py\` todavía no publica ninguna ruta (${dueno})`,
      ).toBeGreaterThan(0)

      // `expenses` extiende cuentas por pagar (D-2), que viven en el router
      // de `purchases`: esas rutas son legítimas y se agregan al conjunto.
      if (dominio === "expenses") {
        for (const r of rutasPublicadas(path.join(BACKEND, "app", "purchases", "router.py"))) {
          publicadas.add(normalizar(r))
        }
      }

      const inventadas = [...consumidas].filter((r) => !publicadas.has(r))
      expect(
        inventadas,
        `la pantalla llama a rutas que \`app/${dominio}/router.py\` no publica. Una pantalla que ` +
          `consume otra ruta rompe la conciliación (contrato de §2, dueño T5 frontend-fase3 si ` +
          `inventó la ruta, ${dueno} si la renombró):\n` +
          inventadas.join("\n") +
          `\nPublicadas: ${[...publicadas].sort().join(", ")}`,
      ).toEqual([])
    })
  }
})

describe("ninguna pantalla de plata deriva una cifra que el backend ya mandó", () => {
  // Campos de plata que llegan del backend. Cualquier operación aritmética
  // sobre uno de ellos en una pantalla es una segunda matemática.
  const CAMPOS = [
    "amount",
    "balance",
    "outstanding",
    "to_deposit",
    "deposited",
    "spent",
    "withdrawn",
    "difference",
    "expected",
    "settled",
    "net_amount",
    "gross_amount",
    "commission_amount",
    "retention_amount",
    "fixed_costs",
    "break_even_amount",
    "profit",
    "net_sales",
    "allocated_amount",
    "unallocated_amount",
  ]

  for (const { dominio, dueno } of TERRITORIOS) {
    it(`${dominio}: no hay sumas, restas ni porcentajes sobre cifras del servidor`, () => {
      const dir = path.join(SRC, "features", dominio)
      const archivos = archivosDe(dir, /\.tsx?$/).filter((f) => !/__tests__/.test(f))
      expect(
        archivos.length,
        `AUSENCIA (no defecto): \`src/features/${dominio}/\` todavía no tiene pantallas`,
      ).toBeGreaterThan(0)

      const malos: string[] = []
      const campos = CAMPOS.join("|")
      // `x.amount - y`, `x.amount + y`, `x.balance * 2`, `x.profit / 100`,
      // y el simétrico `y - x.amount`.
      const patron = new RegExp(
        `(\\.(?:${campos})\\s*[-+*/]\\s*[A-Za-z0-9_(])|([A-Za-z0-9_)\\]]\\s*[-+*/]\\s*[A-Za-z_][A-Za-z0-9_.]*\\.(?:${campos})\\b)`,
      )
      for (const archivo of archivos) {
        readFileSync(archivo, "utf8")
          .split("\n")
          .forEach((linea, i) => {
            const recortada = linea.trim()
            // Los comentarios no son código.
            if (recortada.startsWith("*") || recortada.startsWith("//") || recortada.startsWith("/*")) return
            // Un `reduce` tiene su propio invariante abajo: si cayera también
            // acá, una sola línea produciría DOS rojos y el orquestador
            // contaría dos hallazgos donde hay uno.
            if (/\.reduce\(/.test(linea)) return
            // Una asignación por defecto (`?? 0`) o una comparación no son
            // aritmética; sólo se caza el operador aritmético real.
            if (patron.test(linea)) malos.push(`${path.relative(SRC, archivo)}:${i + 1}  ${linea.trim()}`)
          })
      }
      expect(
        malos,
        `estas líneas derivan plata en el cliente. El saldo, la diferencia y el punto de equilibrio ` +
          `los calcula el backend y la pantalla los pinta como llegan (AGENTS.md; dueño T5 ` +
          `frontend-fase3, con ${dueno} del otro lado si falta el campo ya calculado):\n` +
          malos.join("\n"),
      ).toEqual([])
    })
  }

  it("ninguna pantalla de plata totaliza con `reduce` una cifra que el servidor va a guardar", () => {
    const malos: string[] = []
    for (const { dominio } of TERRITORIOS) {
      for (const archivo of archivosDe(path.join(SRC, "features", dominio), /\.tsx?$/)) {
        if (/__tests__/.test(archivo)) continue
        readFileSync(archivo, "utf8")
          .split("\n")
          .forEach((linea, i) => {
            if (/\.reduce\(/.test(linea)) malos.push(`${path.relative(SRC, archivo)}:${i + 1}  ${linea.trim()}`)
          })
      }
    }
    expect(
      malos,
      "un `reduce` sobre filas de plata es un total calculado en el cliente.\n\n" +
        "HALLAZGO CONCRETO (dueño T5 frontend-fase3): `CreateDepositDialog.tsx` arma el `amount` de " +
        "la consignación como la SUMA de las imputaciones que la persona tecleó. Dos consecuencias " +
        "que no son teóricas: (1) `unallocated_amount` nunca puede ser distinto de `0`, aunque el " +
        "backend lo publique como campo propio; (2) **no se puede registrar una consignación de " +
        "plata que no se imputa a ningún turno** —la que sale de la mano del dueño, que es " +
        "justamente el caso que `GET /admin/bank/owner-hand` mide—, así que el saldo de la mano " +
        "sólo baja por consignaciones imputadas a turnos.\n\n" +
        "Remedio: que el monto de la consignación sea un campo que la persona escribe (es lo que " +
        "dice el comprobante del banco) y que las imputaciones se validen contra él; el backend ya " +
        "publica `allocated_amount` y `unallocated_amount` para eso.\n\n" +
        malos.join("\n"),
    ).toEqual([])
  })
})

describe("«por consignar» dice `null` con motivo, nunca $0", () => {
  it("PendingDepositsTab distingue «nadie contó» de «no hay nada que consignar»", () => {
    const archivo = path.join(SRC, "features/banking/PendingDepositsTab.tsx")
    let texto: string
    try {
      texto = readFileSync(archivo, "utf8")
    } catch {
      expect.fail("AUSENCIA (no defecto): `features/banking/PendingDepositsTab.tsx` todavía no existe (T5)")
    }
    expect(
      /to_deposit\s*===?\s*null|to_deposit\s*==\s*null|to_deposit\s*\?\?|to_deposit\s*!=+\s*null/.test(texto),
      "la pantalla de «por consignar» no distingue `to_deposit === null` (turno cerrado sin conteo) de " +
        "un monto real. Un `$0` ahí dice «no hay nada que consignar» cuando la verdad es «nadie contó» " +
        "(error repetido nº7, dueño T5 frontend-fase3)",
    ).toBe(true)
    expect(
      /reason/.test(texto),
      "un `null` sin su `reason` a la vista es un `null` mudo: el backend lo manda y la pantalla tiene " +
        "que mostrarlo (dueño T5)",
    ).toBe(true)
  })
})

describe("la mano del dueño y la conciliación no se calculan en la pantalla", () => {
  it("el saldo de la mano del dueño se pinta como llega (`balance`), no como resta", () => {
    const archivo = path.join(SRC, "features/banking/OwnerHandTab.tsx")
    let texto: string
    try {
      texto = readFileSync(archivo, "utf8")
    } catch {
      expect.fail("AUSENCIA (no defecto): `features/banking/OwnerHandTab.tsx` todavía no existe (T5)")
    }
    expect(
      /\.balance\b/.test(texto),
      "la pantalla de la mano del dueño no lee `balance` del servidor: si lo está restando a mano " +
        "(`withdrawn − deposited − spent`), hay dos respuestas a «cuánta plata tiene el dueño en la " +
        "mano» y la que se muestre va a ser la que nadie auditó (dueño T5)",
    ).toBe(true)
  })

  it("la diferencia de una conciliación llega del servidor, no se resta en pantalla", () => {
    const archivo = path.join(SRC, "features/banking/ReconciliationTab.tsx")
    let texto: string
    try {
      texto = readFileSync(archivo, "utf8")
    } catch {
      expect.fail("AUSENCIA (no defecto): `features/banking/ReconciliationTab.tsx` todavía no existe (T5)")
    }
    expect(
      /\.difference\b/.test(texto),
      "la conciliación tiene que pintar `difference` tal como llega (§2 fija «lo esperado, lo liquidado, " +
        "la diferencia»): restarla en pantalla es la segunda matemática (dueño T5)",
    ).toBe(true)
  })
})
