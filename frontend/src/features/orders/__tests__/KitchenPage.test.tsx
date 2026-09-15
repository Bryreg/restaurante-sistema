import { screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

import { renderWithProviders } from "@/test/utils"

import { KitchenPage } from "../KitchenPage"
import { buildKitchenRound, deviceMe } from "./fixtures"

const { listKitchenRoundsMock } = vi.hoisted(() => ({ listKitchenRoundsMock: vi.fn() }))

vi.mock("@/api/kitchen", async () => {
  const actual = await vi.importActual<typeof import("@/api/kitchen")>("@/api/kitchen")
  return { ...actual, listKitchenRounds: listKitchenRoundsMock }
})

const { markReadyMock } = vi.hoisted(() => ({ markReadyMock: vi.fn() }))

vi.mock("@/api/orders", async () => {
  const actual = await vi.importActual<typeof import("@/api/orders")>("@/api/orders")
  return { ...actual, markReady: markReadyMock }
})

describe("KitchenPage", () => {
  it("sin kitchen.view muestra el mensaje de función apagada", () => {
    renderWithProviders(<KitchenPage />, { me: deviceMe({ "kitchen.view": false }) })

    expect(screen.getByText(/la vista de cocina no está habilitada/i)).toBeInTheDocument()
    expect(listKitchenRoundsMock).not.toHaveBeenCalled()
  })

  it("pinta la ronda con tiempo transcurrido y semáforo, y marca listo con Idempotency-Key", async () => {
    listKitchenRoundsMock.mockResolvedValue([buildKitchenRound()])
    markReadyMock.mockResolvedValue({})

    const user = userEvent.setup()
    renderWithProviders(<KitchenPage />, { me: deviceMe({ "kitchen.view": true }) })

    await waitFor(() => expect(screen.getByText(/limonada de coco/i)).toBeInTheDocument())
    expect(screen.getByText(/a tiempo/i)).toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: /marcar listo: limonada de coco/i }))

    await waitFor(() => expect(markReadyMock).toHaveBeenCalledWith(501, 1, expect.any(String)))
  })

  it("no navega a ninguna otra pantalla (no hay enlaces ni botones de navegación)", async () => {
    listKitchenRoundsMock.mockResolvedValue([buildKitchenRound()])

    renderWithProviders(<KitchenPage />, { me: deviceMe({ "kitchen.view": true }) })

    await waitFor(() => expect(screen.getByText(/limonada de coco/i)).toBeInTheDocument())
    expect(screen.queryAllByRole("link")).toHaveLength(0)
  })
})
