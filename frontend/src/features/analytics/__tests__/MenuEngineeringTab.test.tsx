import { screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

import type { MenuEngineeringOut, MenuEngineeringRowOut } from "@/api/analytics"
import { renderWithProviders } from "@/test/utils"

import { MenuEngineeringTab } from "../MenuEngineeringTab"
import { menuResumen } from "../titulares"

const { getMenuEngineeringMock } = vi.hoisted(() => ({ getMenuEngineeringMock: vi.fn() }))

vi.mock("@/api/analytics", async () => {
  const actual = await vi.importActual<typeof import("@/api/analytics")>("@/api/analytics")
  return { ...actual, getMenuEngineering: getMenuEngineeringMock }
})

function plato(o: Partial<MenuEngineeringRowOut> & { product_id: number }): MenuEngineeringRowOut {
  return {
    product_name: `Plato ${o.product_id}`,
    category_id: 3,
    category_name: "Platos Fuertes",
    qty_sold: 100,
    popularity_share_bp: 700,
    revenue_net: 1_000_000,
    theoretical_cost: 400_000,
    contribution_margin: 600_000,
    contribution_margin_per_unit: 6000,
    margin_pct_bp: 6000,
    costed_qty_pct_bp: 10000,
    insufficient_sample: false,
    classification: "plowhorse",
    classification_reason: "alta popularidad, margen bajo el promedio",
    recommended_action: "Revisar precio",
    ...o,
  }
}

const DATA: MenuEngineeringOut = {
  store_id: 1,
  date_from: "2026-08-24",
  date_to: "2026-09-23",
  available: true,
  reason: null,
  popularity_threshold_bp: 350,
  avg_contribution_margin_per_unit: 12436,
  category_id: null,
  min_units: 20,
  min_costed_pct_bp: 8000,
  costed_pct_bp: 10000,
  excluded_products: 1,
  counts_by_class: { star: 1, plowhorse: 1, puzzle: 1, dog: 2, unclassified: 0, insufficient_sample: 1 },
  rows: [
    plato({ product_id: 8, product_name: "Bandeja paisa", qty_sold: 186, popularity_share_bp: 1247, contribution_margin_per_unit: 21536, classification: "star", recommended_action: "Mantener" }),
    plato({ product_id: 15, product_name: "Limonada de coco", category_id: 4, category_name: "Bebidas", qty_sold: 130, popularity_share_bp: 871, contribution_margin_per_unit: 5405 }),
    plato({ product_id: 9, product_name: "Frijoles con garra", qty_sold: 48, popularity_share_bp: 322, contribution_margin_per_unit: 18660, classification: "puzzle", recommended_action: "Promocionar" }),
    plato({ product_id: 19, product_name: "Flan de café", category_id: 5, category_name: "Postres", qty_sold: 41, popularity_share_bp: 275, contribution_margin_per_unit: 7099, classification: "dog", recommended_action: "Sacar o rediseñar" }),
    plato({ product_id: 4, product_name: "Tostones", category_id: 1, category_name: "Entradas", qty_sold: 29, popularity_share_bp: 194, contribution_margin_per_unit: 9620, classification: "dog", recommended_action: "Sacar o rediseñar" }),
    plato({
      product_id: 7,
      product_name: "Sopa de guineo",
      category_id: 2,
      category_name: "Sopas",
      qty_sold: 18,
      popularity_share_bp: 121,
      contribution_margin_per_unit: 10409,
      insufficient_sample: true,
      classification: null,
      classification_reason: "vendió 18 unidades en el período; hacen falta al menos 20 para clasificarlo con confianza",
      recommended_action: null,
    }),
  ],
}

describe("MenuEngineeringTab — resumen por acción, matriz con umbrales del servidor y tabla por acción (analista #5, científico #7)", () => {
  it("el resumen arriba sale de `counts_by_class`, primero lo que hay que sacar", async () => {
    getMenuEngineeringMock.mockResolvedValue(DATA)
    renderWithProviders(<MenuEngineeringTab storeId={1} />)

    expect(
      await screen.findByText("2 para sacar o rediseñar, 1 para revisar precio, 1 para promocionar y 1 para mantener"),
    ).toBeInTheDocument()
    expect(screen.getByTestId("menu-resumen")).toHaveTextContent(/Sin clasificar: 1 con muestra chica\./)
    expect(screen.getByTestId("menu-resumen")).toHaveTextContent(/1 producto queda fuera/)
  })

  it("la matriz: un punto por plato clasificado, las dos líneas de umbral rotuladas con los valores del servidor y los «perro» resaltados", async () => {
    getMenuEngineeringMock.mockResolvedValue(DATA)
    const { container } = renderWithProviders(<MenuEngineeringTab storeId={1} />)

    expect(
      await screen.findByRole("heading", {
        name: "2 platos quedan abajo a la izquierda: se venden poco y dejan menos de $ 12.436 por unidad",
      }),
    ).toBeInTheDocument()
    // La de muestra chica no entra a la matriz (no está clasificada).
    const puntos = container.querySelectorAll("[data-punto]")
    expect([...puntos].map((p) => p.getAttribute("data-punto")).sort()).toEqual(["15", "19", "4", "8", "9"])
    expect(container.querySelector('[data-umbral="x"]')).toHaveTextContent(/Popularidad mínima 3,50\s%/)
    expect(container.querySelector('[data-umbral="y"]')).toHaveTextContent("Margen promedio $ 12.436")
    // Los perros van resaltados (marca más grande), el resto no.
    expect(container.querySelector('[data-punto="19"]')).toHaveAttribute("r", "6")
    expect(container.querySelector('[data-punto="4"]')).toHaveAttribute("r", "6")
    expect(container.querySelector('[data-punto="8"]')).toHaveAttribute("r", "4.5")
    expect(container.querySelector("[data-cuadrantes]")).toHaveTextContent(/Perro/)
  })

  it("la tabla va ordenada por acción, con «Qué hacer», «Perro» en ámbar (nunca rojo) y «muestra chica» sin clasificar", async () => {
    getMenuEngineeringMock.mockResolvedValue(DATA)
    renderWithProviders(<MenuEngineeringTab storeId={1} />)

    const tabla = await screen.findByRole("table", { name: /ordenados por lo que conviene hacer/ })
    const filas = within(tabla).getAllByRole("row").slice(1)
    const nombres = filas.map((f) => within(f).getAllByRole("cell")[0]!.textContent)
    expect(nombres).toEqual(["Flan de café", "Tostones", "Limonada de coco", "Frijoles con garra", "Bandeja paisa", "Sopa de guineo"])
    expect(within(filas[0]!).getByText("Sacar o rediseñar")).toBeInTheDocument()
    expect(within(filas[2]!).getByText("Revisar precio")).toBeInTheDocument()

    const perro = within(filas[0]!).getByText("Perro")
    expect(perro.className).toMatch(/warning/)
    expect(perro.className).not.toMatch(/destructive/)
    expect(tabla.innerHTML).not.toMatch(/destructive/)

    const chica = filas[5]!
    expect(within(chica).getByText("Muestra chica")).toBeInTheDocument()
    expect(within(chica).getByText(/Esperar más ventas/)).toBeInTheDocument()
    // Margen por unidad y % tal como llegan.
    expect(within(filas[4]!).getByText("$ 21.536")).toBeInTheDocument()
    expect(within(filas[4]!).getByText(/^60,0\s%$/)).toBeInTheDocument()
  })

  it("filtrar por categoría pide al servidor con `categoryId` (los umbrales pasan a ser los de la categoría)", async () => {
    getMenuEngineeringMock.mockResolvedValue(DATA)
    const user = userEvent.setup()
    renderWithProviders(<MenuEngineeringTab storeId={1} />)

    await screen.findByRole("table", { name: /ordenados por lo que conviene hacer/ })
    await user.click(screen.getByRole("combobox", { name: "Categoría" }))
    await user.click(await screen.findByRole("option", { name: "Postres" }))

    await waitFor(() =>
      expect(getMenuEngineeringMock).toHaveBeenCalledWith(expect.objectContaining({ storeId: 1, categoryId: 5 })),
    )
  })

  it("sin umbrales (sin margen promedio) no dibuja una matriz inventada", async () => {
    getMenuEngineeringMock.mockResolvedValue({ ...DATA, avg_contribution_margin_per_unit: null })
    const { container } = renderWithProviders(<MenuEngineeringTab storeId={1} />)

    await screen.findByText("Bandeja paisa")
    expect(container.querySelector("[data-punto]")).toBeNull()
  })
})

describe("menuResumen — contar filas por clase y nombrarlas por acción", () => {
  it("omite las clases vacías y dice lo que quedó sin clasificar", () => {
    expect(menuResumen({ star: 5, plowhorse: 7, puzzle: 0, dog: 3, unclassified: 2, insufficient_sample: 1 })).toEqual({
      titular: "3 para sacar o rediseñar, 7 para revisar precio y 5 para mantener",
      aparte: "Sin clasificar: 1 con muestra chica y 2 sin costo suficiente.",
    })
    expect(menuResumen({ star: 0, plowhorse: 0, puzzle: 0, dog: 0, unclassified: 0, insufficient_sample: 4 })).toEqual({
      titular: "Ningún plato alcanzó a clasificarse",
      aparte: "Sin clasificar: 4 con muestra chica.",
    })
  })
})
