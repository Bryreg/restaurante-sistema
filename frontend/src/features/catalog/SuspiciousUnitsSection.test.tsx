import { screen, waitFor } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import { renderWithProviders } from "@/test/utils"

import { SuspiciousUnitsSection } from "./SuspiciousUnitsSection"

const { getSuspiciousUnitsMock } = vi.hoisted(() => ({ getSuspiciousUnitsMock: vi.fn() }))

vi.mock("@/api/recipes", async () => {
  const actual = await vi.importActual<typeof import("@/api/recipes")>("@/api/recipes")
  return { ...actual, getSuspiciousUnits: getSuspiciousUnitsMock }
})

describe("SuspiciousUnitsSection", () => {
  it("muestra la línea sospechosa con el motivo que arma el servidor (18 kg donde iban 18 g)", async () => {
    getSuspiciousUnitsMock.mockResolvedValue([
      {
        product_id: 4,
        product_name: "Ensalada César",
        ingredient_id: 11,
        ingredient_name: "Sal",
        qty: "18",
        unit: "kg",
        reason: "supera el techo de 10000 g por línea",
      },
    ])
    renderWithProviders(<SuspiciousUnitsSection storeId={1} />)

    await waitFor(() => expect(screen.getByText("Ensalada César")).toBeInTheDocument())
    expect(screen.getByText("Sal")).toBeInTheDocument()
    expect(screen.getByText("18 kg")).toBeInTheDocument()
    expect(screen.getByText("supera el techo de 10000 g por línea")).toBeInTheDocument()
  })

  it("sin líneas sospechosas lo dice explícitamente", async () => {
    getSuspiciousUnitsMock.mockResolvedValue([])
    renderWithProviders(<SuspiciousUnitsSection storeId={1} />)

    await waitFor(() => expect(screen.getByText("No hay líneas sospechosas de unidad")).toBeInTheDocument())
  })
})
