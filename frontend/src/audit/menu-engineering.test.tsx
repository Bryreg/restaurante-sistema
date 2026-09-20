import { screen, waitFor } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import type { MenuEngineeringOut, VarianceByDishOut } from "@/api/analytics"
import { renderWithProviders } from "@/test/utils"

import { MenuEngineeringTab } from "@/features/analytics/MenuEngineeringTab"
import { VarianceByDishTab } from "@/features/analytics/VarianceByDishTab"

/**
 * **Ingeniería de menú y varianza por plato, en la pantalla** — auditor de
 * la fase 3 (T6).
 *
 * **Por qué este archivo existe si T4 y T5 ya tienen los suyos.** Los tests
 * de un constructor prueban que su pantalla hace lo que él quiso. Éstos
 * prueban lo contrario: que la pantalla **no miente cuando el servidor le
 * manda algo raro**. Por eso todos los casos de acá son respuestas que el
 * backend no debería producir —un margen `null`, un porcentaje que no
 * coincide con la resta, una varianza negativa— y lo que se mide es qué
 * hace la pantalla con ellas.
 *
 * Es la única forma de distinguir «la pantalla pinta lo que llega» de «la
 * pantalla calcula y casualmente coincide». Las dos se ven idénticas
 * mientras el servidor manda datos consistentes; sólo se separan con un
 * dato inconsistente, y ahí es donde se ve si hay una segunda matemática
 * escondida.
 *
 * Rojo **por ausencia** = la pantalla todavía no existe (el import falla y
 * vitest lo dice). Rojo **por defecto** = existe y deriva, redondea o
 * esconde.
 */

const { getMenuEngineeringMock, getVarianceByDishMock } = vi.hoisted(() => ({
  getMenuEngineeringMock: vi.fn(),
  getVarianceByDishMock: vi.fn(),
}))

vi.mock("@/api/analytics", async () => {
  const actual = await vi.importActual<typeof import("@/api/analytics")>("@/api/analytics")
  return {
    ...actual,
    getMenuEngineering: getMenuEngineeringMock,
    getVarianceByDish: getVarianceByDishMock,
  }
})

function textoDe(container: HTMLElement): string {
  return (container.textContent ?? "").replace(/ /g, " ")
}

describe("la ingeniería de menú pinta lo que llega y no lo recalcula", () => {
  it("un margen que no coincide con la resta se muestra TAL COMO LLEGA, no recalculado", async () => {
    // Respuesta deliberadamente INCONSISTENTE: el `contribution_margin` que
    // manda el servidor ($12.345) NO es `revenue_net − theoretical_cost`
    // ($70.000). Si la pantalla muestra $70.000, está restando por su
    // cuenta — la segunda matemática que `AGENTS.md` prohíbe, y la que se
    // desincroniza el día que el backend cambie el término (p. ej. si
    // empieza a descontar la merma o la propina).
    //
    // **Calibración declarada**: la primera versión de este test medía
    // `margin_pct_bp`. Resultó que la pantalla no publica ese campo — lo
    // cual NO es un defecto (no mostrar un dato no es mentir; la
    // clasificación Kasavana–Smith va por popularidad y margen en pesos,
    // que sí se muestran). El invariante se corrigió para medir el campo
    // que la pantalla de verdad pinta. Se corrigió el invariante, que
    // estaba mal medido, no se ablandó la regla.
    const data: MenuEngineeringOut = {
      store_id: 1,
      date_from: "2026-01-01",
      date_to: "2026-01-31",
      available: true,
      reason: null,
      popularity_threshold_bp: 1750,
      avg_contribution_margin_per_unit: 7000,
      rows: [
        {
          product_id: 1,
          product_name: "Bandeja paisa",
          qty_sold: 10,
          popularity_share_bp: 10000,
          revenue_net: 100_000,
          theoretical_cost: 30_000,
          contribution_margin: 12_345,
          margin_pct_bp: 9999,
          costed_qty_pct_bp: 10000,
          classification: "star",
          classification_reason: "popularidad y margen sobre el umbral",
        },
      ],
    } as MenuEngineeringOut
    getMenuEngineeringMock.mockResolvedValue(data)
    const { container } = renderWithProviders(<MenuEngineeringTab storeId={1} />)

    await waitFor(() => expect(screen.getByText("Bandeja paisa")).toBeInTheDocument())
    const texto = textoDe(container)
    expect(
      /12[.,]345/.test(texto),
      "la pantalla no muestra el `contribution_margin` que mandó el servidor ($12.345). El cliente " +
        "pinta la plata como llega, no la deriva (AGENTS.md, «una sola matemática»; dueño T5).\n" +
        `Texto renderizado: ${texto.slice(0, 400)}`,
    ).toBe(true)
    expect(
      /70[.,]000/.test(texto),
      "la pantalla muestra $70.000, que es `revenue_net − theoretical_cost` calculado en el cliente, " +
        "en vez del `contribution_margin` del servidor. Ésa es la segunda matemática del margen " +
        "(dueño T5 frontend-fase3)",
    ).toBe(false)
    // No se mide acá el margen PORCENTUAL: esta pantalla no lo publica, y
    // buscarlo sobre el `textContent` concatenado de una tabla da falsos
    // positivos (las celdas «$ 12.345» y «100 %» quedan pegadas y parecen
    // un decimal). Declarado como límite del invariante, no como permiso:
    // si mañana la pantalla muestra un porcentaje de margen, el invariante
    // que lo cobre tiene que leer la CELDA, no el texto del contenedor.
  })

  it("un plato sin costo congelado dice que no lo tiene, y no lo muestra como margen $0", async () => {
    // El caso real: un plato vendido antes de que su ficha existiera. El
    // backend manda `theoretical_cost: null` y `contribution_margin: null`
    // —lo correcto—. Pintarlos como `$ 0` convierte «no sé cuánto cuesta»
    // en «no cuesta nada», que hace ver ese plato como el más rentable de
    // la carta. Es el error repetido nº7 con la peor consecuencia posible:
    // el dueño empuja justo el plato que no sabe costear.
    const data: MenuEngineeringOut = {
      store_id: 1,
      date_from: "2026-01-01",
      date_to: "2026-01-31",
      available: true,
      reason: null,
      popularity_threshold_bp: 1750,
      avg_contribution_margin_per_unit: null,
      rows: [
        {
          product_id: 2,
          product_name: "Sancocho sin ficha",
          qty_sold: 5,
          popularity_share_bp: 10000,
          revenue_net: 50_000,
          theoretical_cost: null,
          contribution_margin: null,
          margin_pct_bp: null,
          costed_qty_pct_bp: 0,
          classification: "unclassified",
          classification_reason: "sin costo congelado en el período",
        },
      ],
    } as MenuEngineeringOut
    getMenuEngineeringMock.mockResolvedValue(data)
    const { container } = renderWithProviders(<MenuEngineeringTab storeId={1} />)

    await waitFor(() => expect(screen.getByText("Sancocho sin ficha")).toBeInTheDocument())
    const texto = textoDe(container)
    expect(
      /\$\s*0(\D|$)/.test(texto),
      "un plato SIN costo congelado se pintó con un `$ 0`. «No sé cuánto cuesta» y «no cuesta nada» " +
        "son dos frases distintas, y la segunda hace ver ese plato como el más rentable de la carta: " +
        "el dueño empuja exactamente el que no sabe costear (error repetido nº7, dueño T5).\n" +
        `Texto renderizado: ${texto.slice(0, 400)}`,
    ).toBe(false)
  })

  it("sin ventas del período dice el motivo, no una tabla vacía muda", async () => {
    const vacio: MenuEngineeringOut = {
      store_id: 1,
      date_from: "2026-01-01",
      date_to: "2026-01-31",
      available: false,
      reason: "No hay ventas con costo congelado en este período.",
      popularity_threshold_bp: null,
      avg_contribution_margin_per_unit: null,
      rows: [],
    } as MenuEngineeringOut
    getMenuEngineeringMock.mockResolvedValue(vacio)
    renderWithProviders(<MenuEngineeringTab storeId={1} />)

    expect(
      await screen.findByText("No hay ventas con costo congelado en este período."),
      "la pantalla tiene que mostrar el `reason` del servidor: una tabla vacía sin explicación se lee " +
        "como «no tenés platos que convengan» (dueño T5)",
    ).toBeInTheDocument()
  })
})

describe("la varianza por plato se declara prorrateada y no le cambia el signo a la plata", () => {
  it("el método viaja a la pantalla tal cual, sin asumirlo", async () => {
    // Si el backend mandara otro método, la pantalla NO puede seguir
    // diciendo "prorrateada": estaría afirmando algo que el servidor no
    // dijo. Se prueba con un método distinto a propósito — el caso que el
    // test del constructor no cubre, porque él siempre manda "prorated".
    const data = {
      method: "measured",
      available: true,
      reason: null,
      rows: [
        {
          product_id: 1,
          product_name: "Hamburguesa",
          theoretical_consumption_share_bp: 3200,
          variance_value: 4500,
          ingredients_involved: 2,
        },
      ],
    } as unknown as VarianceByDishOut
    getVarianceByDishMock.mockResolvedValue(data)
    const { container } = renderWithProviders(<VarianceByDishTab storeId={1} />)

    await waitFor(() => expect(screen.getByText("Hamburguesa")).toBeInTheDocument())
    const texto = textoDe(container)
    expect(
      texto.includes("measured"),
      "la pantalla no muestra el `method` que llegó: si lo tiene quemado como «prorrateada», el día " +
        "que el backend publique otro método la pantalla va a mentir sobre cómo se calculó ese " +
        "número (§5.4, dueño T5).\n" + `Texto renderizado: ${texto.slice(0, 400)}`,
    ).toBe(true)
  })

  it("una varianza NEGATIVA conserva su signo en pantalla", async () => {
    // `variance_value` negativo = se contó MÁS stock del que el libro
    // explica. Mostrarlo sin el signo lo convierte en un faltante del mismo
    // tamaño: el mismo número con el significado exactamente invertido, y
    // alguien le pide cuentas a una persona por un sobrante.
    const data = {
      method: "prorated",
      available: true,
      reason: null,
      rows: [
        {
          product_id: 3,
          product_name: "Arroz con pollo",
          theoretical_consumption_share_bp: 5000,
          variance_value: -12_500,
          ingredients_involved: 1,
        },
      ],
    } as unknown as VarianceByDishOut
    getVarianceByDishMock.mockResolvedValue(data)
    const { container } = renderWithProviders(<VarianceByDishTab storeId={1} />)

    await waitFor(() => expect(screen.getByText("Arroz con pollo")).toBeInTheDocument())
    const texto = textoDe(container)
    expect(
      /-\s*\$|\$\s*-|\(\s*\$/.test(texto),
      "una varianza NEGATIVA (se contó más stock del que el libro explica) se pintó sin signo: es el " +
        "mismo número con el significado invertido, y convierte un sobrante en un faltante (dueño T5)." +
        `\nTexto renderizado: ${texto.slice(0, 400)}`,
    ).toBe(true)
  })

  it("una fila sin valor de varianza no se pinta como $0", async () => {
    const data = {
      method: "prorated",
      available: true,
      reason: null,
      rows: [
        {
          product_id: 4,
          product_name: "Plato sin atribuir",
          theoretical_consumption_share_bp: 0,
          variance_value: null,
          ingredients_involved: 0,
        },
      ],
    } as unknown as VarianceByDishOut
    getVarianceByDishMock.mockResolvedValue(data)
    const { container } = renderWithProviders(<VarianceByDishTab storeId={1} />)

    await waitFor(() => expect(screen.getByText("Plato sin atribuir")).toBeInTheDocument())
    const texto = textoDe(container)
    expect(
      /\$\s*0(\D|$)/.test(texto),
      "una varianza `null` (no se pudo atribuir) se pintó como `$ 0`, o sea «este plato no tiene " +
        "varianza». Son dos afirmaciones distintas y sólo una es verdad (error repetido nº7, dueño T5)." +
        `\nTexto renderizado: ${texto.slice(0, 400)}`,
    ).toBe(false)
  })
})
