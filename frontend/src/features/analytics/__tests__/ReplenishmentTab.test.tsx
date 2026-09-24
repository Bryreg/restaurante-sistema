import { screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

import type { ReplenishmentOut } from "@/api/analytics"
import { renderWithProviders } from "@/test/utils"

import { ReplenishmentTab } from "../ReplenishmentTab"

const { getReplenishmentMock } = vi.hoisted(() => ({ getReplenishmentMock: vi.fn() }))

vi.mock("@/api/analytics", async () => {
  const actual = await vi.importActual<typeof import("@/api/analytics")>("@/api/analytics")
  return { ...actual, getReplenishment: getReplenishmentMock }
})

const DATA = {
  store_id: 1,
  available: true,
  reason: null,
  lookback_days: 30,
  rows: [
    {
      ingredient_id: 43,
      ingredient_name: "Aceite vegetal",
      base_unit: "ml",
      current_stock: "-126",
      min_stock: "6000",
      avg_daily_consumption: "2222.2",
      median_daily_consumption: "2410",
      history_days: 14,
      lead_time_days: 5,
      suggested_qty: "6126",
      suggested_min: "11111",
      based_on: "consumo de 14 día(s) con historial (de los últimos 30) × lead_time_days (5 días)",
      reason: null,
    },
    {
      ingredient_id: 35,
      ingredient_name: "Aguacate hass",
      base_unit: "unit",
      current_stock: "122.89",
      min_stock: "30",
      avg_daily_consumption: "0.024",
      median_daily_consumption: "0.02",
      history_days: 14,
      lead_time_days: null,
      suggested_qty: "0",
      suggested_min: null,
      based_on: null,
      reason: "sin lead_time_days configurado",
    },
  ],
} as unknown as ReplenishmentOut

describe("ReplenishmentTab — el consumo diario con su historial real y su mediana (científico #17)", () => {
  it("dice con cuántos días de historial se calculó y muestra la mediana junto al promedio, en es-CO", async () => {
    getReplenishmentMock.mockResolvedValue(DATA)
    renderWithProviders(<ReplenishmentTab storeId={1} />)

    expect(await screen.findByTestId("historial-comun")).toHaveTextContent(
      /Consumo diario calculado con 14 días de historial \(de los últimos 30\)/,
    )
    // `null` no es 0: el mínimo sin lead time dice «Sin datos», a la vista
    // (no detrás de «Más columnas»).
    const aguacateVisible = within(screen.getAllByRole("row").find((f) => f.textContent?.includes("Aguacate hass"))!)
    expect(aguacateVisible.getByText("Sin datos")).toBeInTheDocument()

    // Consumo diario e historial son el cómo del cálculo: detrás de «Más columnas» (regla 3).
    await userEvent.setup().click(screen.getByRole("button", { name: "Más columnas (3)" }))
    const filas = screen.getAllByRole("row")
    const aceite = within(filas.find((f) => f.textContent?.includes("Aceite vegetal"))!)
    expect(aceite.getByText("6.126 ml")).toBeInTheDocument()
    expect(aceite.getByText("11.111 ml")).toBeInTheDocument()
    expect(aceite.getByText(/2\.410 ml/)).toBeInTheDocument()
    expect(aceite.getByText(/2\.222,2 ml/)).toBeInTheDocument()
    expect(aceite.getByText("14 días")).toBeInTheDocument()

    const aguacate = within(filas.find((f) => f.textContent?.includes("Aguacate hass"))!)
    expect(aguacate.getByText(/0,02 unidad/)).toBeInTheDocument()
    expect(aguacate.getByText(/0,024 unidad/)).toBeInTheDocument()
    expect(aguacate.getByText("Sin datos")).toBeInTheDocument()
  })

  it("la cifra protagonista cuenta los insumos con sugerencia mayor que cero, en ámbar", async () => {
    getReplenishmentMock.mockResolvedValue(DATA)
    renderWithProviders(<ReplenishmentTab storeId={1} />)

    // El aguacate trae `suggested_qty: "0"`: no se pide. Queda uno.
    const cifra = await screen.findByTestId("por-pedir")
    expect(cifra).toHaveTextContent(/^1\s*insumo para pedir$/)
    expect(within(cifra).getByText("1").className).toMatch(/text-warning/)
  })
})
