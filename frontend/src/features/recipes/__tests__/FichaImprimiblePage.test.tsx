import { screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import type { PrintableSheetOut } from "@/api/recipes"
import { buildMe, renderWithProviders } from "@/test/utils"

import { FichaImprimiblePage } from "../FichaImprimiblePage"

const { getPrintableSheetMock } = vi.hoisted(() => ({ getPrintableSheetMock: vi.fn() }))
vi.mock("@/api/recipes", async () => {
  const actual = await vi.importActual<typeof import("@/api/recipes")>("@/api/recipes")
  return { ...actual, getPrintableSheet: getPrintableSheetMock }
})

const FICHA: PrintableSheetOut = {
  kind: "product",
  id: 4,
  name: "Lasaña",
  scale_text: "1 porción",
  scale: 1,
  recipe_version: 3,
  sheet: {
    product_id: 4,
    preparation_id: null,
    method_steps: ["Armar capas", "Hornear 25 min"],
    portion: "350 g",
    station: "caliente",
    prep_minutes: 35,
    plating_notes: "Gratinar arriba",
    chef_notes: null,
    photo_url: null,
    updated_at: "2026-10-06T10:00:00Z",
    updated_by_employee_name: "Chef",
    allergens: ["gluten", "lacteos"],
  },
  components: [
    { kind: "ingredient", name: "Harina", qty: "100", unit: "g", components: [] },
    {
      kind: "preparation",
      name: "Bechamel",
      qty: "250",
      unit: "g",
      components: [{ kind: "ingredient", name: "Leche", qty: "200", unit: "ml", components: [] }],
    },
  ],
  cost: null,
  generated_at: "2026-10-06T10:00:00Z",
}

describe("FichaImprimiblePage", () => {
  it("imprime componentes con lo de adentro de cada preparación, método y alérgenos, sin costos para cocina", async () => {
    getPrintableSheetMock.mockResolvedValue(FICHA)
    renderWithProviders(<FichaImprimiblePage />, { me: buildMe({}), route: "/imprimir/ficha?producto=4" })

    expect(await screen.findByRole("heading", { name: "Lasaña" })).toBeInTheDocument()
    expect(getPrintableSheetMock).toHaveBeenCalledWith({ kind: "product", id: 4 }, 1, false)
    expect(screen.getByText("Leche")).toBeInTheDocument()
    expect(screen.getByText(/Gluten · Lácteos/)).toBeInTheDocument()
    expect(screen.getByText("Hornear 25 min")).toBeInTheDocument()
    expect(screen.queryByText(/Costo/)).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: /Descargar PDF/ })).toBeInTheDocument()
  })
})
