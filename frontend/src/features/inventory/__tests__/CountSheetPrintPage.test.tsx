import { screen, within } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import type { CountSheetOut } from "@/api/inventory"
import { renderWithProviders } from "@/test/utils"

import { CountSheetPrintPage } from "../CountSheetPrintPage"

const { getCountSheetMock } = vi.hoisted(() => ({ getCountSheetMock: vi.fn() }))

vi.mock("@/api/inventory", async () => {
  const actual = await vi.importActual<typeof import("@/api/inventory")>("@/api/inventory")
  return { ...actual, getCountSheet: getCountSheetMock }
})

const SHEET: CountSheetOut = {
  store_id: 1,
  store_name: "Sede Centro",
  business_date: "2026-01-15",
  generated_at: "2026-01-15T12:00:00Z",
  areas: [{ id: 4, name: "Bar" }],
  sections: [
    {
      area_id: 4,
      title: "Bar",
      items: [
        { ingredient_id: 1, name: "Ron", category: null, count_unit: "botella" },
        { ingredient_id: 2, name: "Aguardiente", category: null, count_unit: "botella" },
      ],
    },
    { area_id: null, title: "Sin área asignada", items: [{ ingredient_id: 3, name: "Arroz", category: "Granos", count_unit: "kg" }] },
  ],
}

describe("Hoja de conteo para imprimir", () => {
  it("una hoja por área, en el orden del servidor, con la columna de cantidad en blanco", async () => {
    getCountSheetMock.mockResolvedValue(SHEET)
    renderWithProviders(<CountSheetPrintPage />, { route: "/imprimir/hoja-conteo?sede=1" })

    const bar = await screen.findByRole("article", { name: "Hoja de Bar" })
    const rows = within(bar).getAllByRole("row").slice(1)
    expect(rows.map((r) => within(r).getAllByRole("cell")[1].textContent)).toEqual(["Ron", "Aguardiente"])
    expect(within(bar).getByLabelText("Cantidad de Ron")).toBeEmptyDOMElement()
    expect(screen.getByRole("article", { name: "Hoja de Sin área asignada" })).toBeInTheDocument()
    expect(getCountSheetMock).toHaveBeenCalledWith(1, null)
  })

  it("sin sede en la dirección no pide nada y lo dice", () => {
    getCountSheetMock.mockReset()
    renderWithProviders(<CountSheetPrintPage />, { route: "/imprimir/hoja-conteo" })
    expect(screen.getByText("Falta de qué sede es la hoja")).toBeInTheDocument()
    expect(getCountSheetMock).not.toHaveBeenCalled()
  })
})
