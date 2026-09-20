import { screen, waitFor } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import type { SustainedHealthOut } from "@/api/analytics"
import { renderWithProviders } from "@/test/utils"

import { SustainedHealthTab } from "../SustainedHealthTab"

const { getControlHealthSustainedMock } = vi.hoisted(() => ({ getControlHealthSustainedMock: vi.fn() }))

vi.mock("@/api/analytics", async () => {
  const actual = await vi.importActual<typeof import("@/api/analytics")>("@/api/analytics")
  return { ...actual, getControlHealthSustained: getControlHealthSustainedMock }
})

describe("SustainedHealthTab — D-1: sustained_red es null con motivo, NUNCA verde por defecto", () => {
  it("con menos de dos ventanas, muestra el motivo y no afirma nada sobre rojo o verde", async () => {
    const notEnough: SustainedHealthOut = {
      sustained_red: null,
      windows_evaluated: 1,
      reason: "sin historial suficiente: hacen falta al menos dos conteos completos aplicados",
    }
    getControlHealthSustainedMock.mockResolvedValue(notEnough)
    renderWithProviders(<SustainedHealthTab storeId={1} />)

    expect(await screen.findByText("Sin historial suficiente")).toBeInTheDocument()
    expect(screen.getByText("sin historial suficiente: hacen falta al menos dos conteos completos aplicados")).toBeInTheDocument()
    expect(screen.queryByText("Sí")).not.toBeInTheDocument()
    expect(screen.queryByText("No")).not.toBeInTheDocument()
  })

  it("con datos suficientes, pinta sustained_red tal como llega, sin decidirlo acá", async () => {
    const sustained: SustainedHealthOut = { sustained_red: true, windows_evaluated: 3, reason: null }
    getControlHealthSustainedMock.mockResolvedValue(sustained)
    renderWithProviders(<SustainedHealthTab storeId={1} />)

    await waitFor(() => expect(screen.getByText("Sí")).toBeInTheDocument())
    expect(screen.getByText("3")).toBeInTheDocument()
  })
})
