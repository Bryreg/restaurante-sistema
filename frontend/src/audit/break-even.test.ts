import { readFileSync, readdirSync, statSync } from "node:fs"
import path from "node:path"

import { describe, expect, it } from "vitest"

const SRC = path.resolve(__dirname, "..")
const BACKEND = path.resolve(SRC, "../../backend")

/**
 * **«Sin datos» se dice, con motivo** — auditor de la fase 3 (T6), tema:
 * punto de equilibrio, utilidad del período y la diferencia de factura
 * (D-2).
 *
 * El **cero mudo es el error repetido nº7** de este proyecto: un `0`
 * publicado donde correspondía `null` con motivo. En esta fase tiene un
 * costo concreto: un punto de equilibrio de `$0` le dice al dueño que ya
 * está ganando plata, y una utilidad de `$0` le dice que el mes empató. Las
 * dos frases son falsas cuando la verdad es «no cargaste los costos fijos».
 *
 * Este archivo audita el **lado de la pantalla**, que es el que el dueño de
 * verdad lee. El lado del backend lo cobra
 * `backend/tests/audit/test_contract_fase3_invariants.py`.
 *
 * Rojo **por ausencia** = la pantalla todavía no existe (lo dice el
 * mensaje). Rojo **por defecto** = existe y pinta un cero donde el backend
 * mandó `null`.
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

function leer(rel: string): string | null {
  try {
    return readFileSync(path.join(SRC, rel), "utf8")
  } catch {
    return null
  }
}

describe("el punto de equilibrio sin costos fijos no se pinta como $0", () => {
  it("BreakEvenTab respeta `available`/`reason` antes de pintar una cifra", () => {
    const texto = leer("features/expenses/BreakEvenTab.tsx")
    if (texto === null) {
      expect.fail("AUSENCIA (no defecto): `features/expenses/BreakEvenTab.tsx` todavía no existe (T5)")
      return
    }
    expect(
      /available/.test(texto),
      "la pantalla del punto de equilibrio no mira `available`: sin costos fijos cargados el backend " +
        "manda `break_even_amount: null` y la pantalla va a pintar el `—`/`$0` del formateador sin " +
        "decir por qué (error repetido nº7, dueño T5 frontend-fase3)",
    ).toBe(true)
    expect(
      /reason/.test(texto),
      "la pantalla no muestra el `reason` que acompaña al `null`: un indicador sin datos tiene que " +
        "decir POR QUÉ, no quedarse mudo (dueño T5)",
    ).toBe(true)
  })

  it("ProfitTab respeta el mismo contrato `available`/`reason`", () => {
    const texto = leer("features/expenses/ProfitTab.tsx")
    if (texto === null) {
      expect.fail("AUSENCIA (no defecto): `features/expenses/ProfitTab.tsx` todavía no existe (T5)")
      return
    }
    expect(
      /available/.test(texto) && /reason/.test(texto),
      "la utilidad del período tiene el mismo contrato que el punto de equilibrio " +
        "(`available`/`reason`, §2): sin él, un mes sin datos se lee como un mes que empató (dueño T5)",
    ).toBe(true)
  })

  it("ninguna pantalla de resultado sustituye un `null` por `0` antes de formatear", () => {
    // `?? 0` / `|| 0` sobre una cifra de plata convierte «no se pudo
    // calcular» en «es cero». Es el cero mudo, escrito en una línea.
    const CAMPOS = "break_even_amount|profit|fixed_costs|contribution_margin_pct_bp|payroll|cost|net_sales|invoice_discrepancy|invoice_total"
    const patron = new RegExp(`\\.(?:${CAMPOS})\\s*(\\?\\?|\\|\\|)\\s*0\\b`)
    const malos: string[] = []
    for (const archivo of archivosDe(path.join(SRC, "features/expenses"), /\.tsx?$/)) {
      if (/__tests__/.test(archivo)) continue
      readFileSync(archivo, "utf8")
        .split("\n")
        .forEach((linea, i) => {
          if (patron.test(linea)) malos.push(`${path.relative(SRC, archivo)}:${i + 1}  ${linea.trim()}`)
        })
    }
    expect(
      malos,
      "estas líneas convierten un `null` del servidor en un `0` antes de mostrarlo. `null` no es 0: " +
        "«no se pudo calcular» y «vale cero» son dos frases distintas y sólo una es verdad (dueño T5):\n" +
        malos.join("\n"),
    ).toEqual([])
  })
})

describe("el punto de equilibrio se calcula en el servidor, no en la pantalla", () => {
  it("ninguna pantalla de gastos divide costos fijos por un margen", () => {
    // `break_even = fixed_costs / margen` en el cliente es exactamente la
    // segunda matemática que `AGENTS.md` prohíbe, y además con `float`.
    const malos: string[] = []
    for (const archivo of archivosDe(path.join(SRC, "features/expenses"), /\.tsx?$/)) {
      if (/__tests__/.test(archivo)) continue
      readFileSync(archivo, "utf8")
        .split("\n")
        .forEach((linea, i) => {
          if (/fixed_costs\s*\/|\/\s*[A-Za-z_][A-Za-z0-9_.]*(?:margin|margen)/i.test(linea)) {
            malos.push(`${path.relative(SRC, archivo)}:${i + 1}  ${linea.trim()}`)
          }
        })
    }
    expect(
      malos,
      "el punto de equilibrio se calcula en el backend (`GET /admin/break-even`) y la pantalla lo pinta. " +
        "Dividir acá es la segunda matemática, y en TypeScript además es un `float` (dueño T5):\n" +
        malos.join("\n"),
    ).toEqual([])
  })

  it("ningún cálculo de la fase usa un literal decimal en TypeScript", () => {
    // CRUCE 4: «ningún `float`, en NINGUNA de las dos capas». En TS todo
    // número es `double`, así que la regla operativa es: nada de literales
    // decimales ni de `/` sobre cifras de plata en estos cuatro territorios.
    const malos: string[] = []
    for (const dominio of ["banking", "expenses", "payroll", "analytics"]) {
      for (const archivo of archivosDe(path.join(SRC, "features", dominio), /\.tsx?$/)) {
        if (/__tests__/.test(archivo)) continue
        readFileSync(archivo, "utf8")
          .split("\n")
          .forEach((linea, i) => {
            const recortada = linea.trim()
            // Los comentarios quedan afuera: un `§5.4` citado en un docstring
            // no es un `float`, y cazarlo convierte el invariante en ruido
            // (calibración declarada: la primera versión marcaba dos
            // docstrings de `VarianceByDishTab.tsx`).
            if (recortada.startsWith("*") || recortada.startsWith("//") || recortada.startsWith("/*")) return
            const sinComentario = linea.replace(/\/\/.*$/, "").replace(/\/\*.*?\*\//g, "")
            // Excluye versiones/`grid-cols-1`/clases de Tailwind: sólo caza
            // un literal decimal suelto usado como número.
            if (/(^|[^\w".\-/§])\d+\.\d+([^\w".\-/]|$)/.test(sinComentario) && !/className|import |from "/.test(sinComentario)) {
              malos.push(`${path.relative(SRC, archivo)}:${i + 1}  ${linea.trim()}`)
            }
          })
      }
    }
    expect(
      malos,
      "un literal decimal en una pantalla de plata es un `float` que el backend nunca mandó " +
        "(CRUCE 4; los recargos de nómina son donde más probable es que aparezca):\n" + malos.join("\n"),
    ).toEqual([])
  })
})

describe("D-2: la diferencia de factura se muestra y no se aprueba sola", () => {
  it("la pantalla de aprobación conoce `409 INVOICE_DISCREPANCY` y `confirm_discrepancy`", () => {
    const texto = leer("features/expenses/PayablesApprovalTab.tsx")
    if (texto === null) {
      expect.fail("AUSENCIA (no defecto): la pantalla de aprobación de cuentas por pagar no existe (T5)")
      return
    }
    expect(
      /INVOICE_DISCREPANCY/.test(texto),
      "la pantalla decide por `code`, nunca por `message` (`docs/CONTEXTO-AGENTES.md §7`), y el código " +
        "de D-2 es `INVOICE_DISCREPANCY`: sin él, el `409` se muestra como un error genérico y el " +
        "administrador no sabe que tiene que confirmar (dueño T5)",
    ).toBe(true)
    expect(
      /confirm_discrepancy/.test(texto),
      "sin `confirm_discrepancy` la cuenta con diferencia no se puede aprobar NUNCA desde la pantalla: " +
        "el flujo de D-2 queda cortado a la mitad (dueño T5)",
    ).toBe(true)
    expect(
      /invoice_total/.test(texto) && /invoice_discrepancy/.test(texto),
      "el `409` «nombra las dos cifras» porque las dos cifras importan: la pantalla tiene que mostrar " +
        "`invoice_total` (el papel) e `invoice_discrepancy` (la diferencia) para que quien confirma " +
        "sepa qué está confirmando (D-2, dueño T5)",
    ).toBe(true)
  })

  it("la confirmación de D-2 no inventa un segundo dialecto en el cliente", () => {
    const texto = leer("api/expenses.ts")
    if (texto === null) {
      expect.fail("AUSENCIA (no defecto): `src/api/expenses.ts` todavía no existe (T5)")
      return
    }
    for (const inventado of ["force_approve", "ignore_discrepancy", "override_discrepancy", "skip_discrepancy"]) {
      expect(
        texto.includes(inventado),
        `el cliente inventó \`${inventado}\` en vez de usar \`confirm_discrepancy\`, que es el patrón ` +
          "de `confirm_price` que D-2 manda copiar. Dos formas de decir «ya sé, seguí» son dos formas " +
          "de que alguien no entienda ninguna (dueño T5)",
      ).toBe(false)
    }
  })

  it("el backend y el cliente nombran el mismo campo de confirmación", () => {
    const cliente = leer("api/expenses.ts")
    if (cliente === null) {
      expect.fail("AUSENCIA (no defecto): `src/api/expenses.ts` todavía no existe (T5)")
      return
    }
    let esquemas: string
    try {
      esquemas = readFileSync(path.join(BACKEND, "app/purchases/schemas.py"), "utf8")
    } catch {
      expect.fail("AUSENCIA (no defecto): no se pudo leer `app/purchases/schemas.py`")
      return
    }
    expect(
      /confirm_discrepancy/.test(esquemas),
      "D-2 exige `confirm_discrepancy` en `PayableApproveIn` y el backend no lo declara " +
        "(dueño T2 backend-obligaciones)",
    ).toBe(true)
    expect(
      /confirm_discrepancy/.test(cliente),
      "el backend acepta `confirm_discrepancy` y el cliente no lo manda: la mitad de ida sin la mitad " +
        "de vuelta, que fue el modo de falla de los cinco hallazgos de cruce de 2b (dueño T5)",
    ).toBe(true)
  })
})
