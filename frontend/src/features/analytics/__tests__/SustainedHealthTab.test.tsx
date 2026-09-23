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
      reason: "sin historial suficiente: hacen falta al menos TRES conteos completos aplicados (dos períodos entre conteos) para saber si la brecha se sostiene",
    }
    getControlHealthSustainedMock.mockResolvedValue(notEnough)
    renderWithProviders(<SustainedHealthTab storeId={1} />)

    expect(await screen.findByText("Sin historial suficiente")).toBeInTheDocument()
    expect(screen.getByText("sin historial suficiente: hacen falta al menos TRES conteos completos aplicados (dos períodos entre conteos) para saber si la brecha se sostiene")).toBeInTheDocument()
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
  it("la brecha por ventana contra el umbral rojo: titular que concluye, un punto por ventana y las ventanas saltadas explicadas", async () => {
    const data: SustainedHealthOut = {
      sustained_red: false,
      windows_evaluated: 3,
      reason: null,
      red_threshold_bp: 400,
      min_window_days: 1,
      min_costed_pct_bp: 8000,
      windows_skipped: 2,
      windows: [
        { window_index: 1, window_from: "2026-08-25T14:00:00Z", window_to: "2026-09-01T14:00:00Z", real_pct_bp: 3900, theoretical_pct_bp: 3300, gap_bp: 600, exceeds_red: true, window_hours: 168, window_days: 7, orders_in_window: 300, costed_pct_bp: 9900 },
        { window_index: 2, window_from: "2026-09-01T14:00:00Z", window_to: "2026-09-08T14:00:00Z", real_pct_bp: 3500, theoretical_pct_bp: 3300, gap_bp: 200, exceeds_red: false, window_hours: 168, window_days: 7, orders_in_window: 280, costed_pct_bp: 9900 },
        { window_index: 3, window_from: "2026-09-08T14:00:00Z", window_to: "2026-09-15T14:00:00Z", real_pct_bp: 3510, theoretical_pct_bp: 3300, gap_bp: 210, exceeds_red: false, window_hours: 168, window_days: 7, orders_in_window: 290, costed_pct_bp: 9900 },
      ],
    }
    getControlHealthSustainedMock.mockResolvedValue(data)
    const { container } = renderWithProviders(<SustainedHealthTab storeId={1} />)

    // Analista #6: «La brecha está en 2,1 pts, por debajo del rojo».
    expect(
      await screen.findByRole("heading", { name: "La brecha está en 2,1 puntos, por debajo del rojo (4,0 puntos)" }),
    ).toBeInTheDocument()
    expect(screen.getByText(/Base: 870 comandas · 3 ventanas/)).toBeInTheDocument()
    // Un punto por ventana; la que pasó el umbral va marcada (lo decide la regla del servidor).
    expect(container.querySelectorAll("[data-punto]")).toHaveLength(3)
    expect(container.querySelectorAll("[data-sobre]")).toHaveLength(1)
    expect(container.querySelector("[data-umbral]")).toHaveTextContent("Umbral rojo: 4,0 pts")
    // `windows_skipped` explicado con las reglas del servidor.
    expect(screen.getByTestId("ventanas-saltadas")).toHaveTextContent(
      /2 ventanas entre conteos no cuentan: una ventana entra sólo si dura 1 día completo o más, tiene ventas, tiene ficha con costo en 80,0\s% o más/,
    )
    expect(screen.getByText("No")).toBeInTheDocument()
  })

  it("real bajo el teórico: no dice «se pierden» ni pinta un porcentaje negativo como pérdida", async () => {
    const data: SustainedHealthOut = {
      sustained_red: null,
      windows_evaluated: 1,
      reason: "sin historial suficiente",
      red_threshold_bp: 400,
      windows_skipped: 1,
      min_window_days: 1,
      min_costed_pct_bp: 8000,
      windows: [
        { window_index: 1, window_from: "2026-09-01T21:39:43Z", window_to: "2026-09-21T21:39:43Z", real_pct_bp: 1901, theoretical_pct_bp: 3421, gap_bp: -1520, exceeds_red: false, window_hours: 480, window_days: 20, orders_in_window: 441, costed_pct_bp: 9926 },
      ],
    }
    getControlHealthSustainedMock.mockResolvedValue(data)
    renderWithProviders(<SustainedHealthTab storeId={1} />)

    expect(
      await screen.findByRole("heading", {
        name: "En la última ventana el real queda 15,2 puntos por debajo del teórico: lejos del rojo (4,0 puntos)",
      }),
    ).toBeInTheDocument()
    expect(screen.getByText("Sin historial suficiente")).toBeInTheDocument()
    // Con `null`, el motivo del servidor ya explica las ventanas saltadas: no se repite.
    expect(screen.getByText("sin historial suficiente")).toBeInTheDocument()
    expect(screen.queryByTestId("ventanas-saltadas")).not.toBeInTheDocument()
  })
})
