import { screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

import type { ComboAdminOut } from "@/api/catalog"
import { setComboToday } from "@/api/catalog"
import { renderWithProviders } from "@/test/utils"

import { DailyMenuTab } from "./DailyMenuTab"

const { COMBO } = vi.hoisted(() => ({
  COMBO: {
    id: 1,
    name: "Corrientazo del día",
    price: 18_000,
    active: true,
    active_now: true,
    schedule: { days: [0, 1, 2, 3, 4, 5], from: "11:30", to: "15:00" },
    groups: [
      {
        id: 10,
        name: "Sopa",
        sort_order: 0,
        options: [
          { id: 101, name: "Sancocho de gallina", product_id: 1, available_today: true, active_today: true },
          { id: 102, name: "Ajiaco santafereño", product_id: 2, available_today: true, active_today: false },
        ],
      },
    ],
  } satisfies ComboAdminOut,
}))

vi.mock("@/api/catalog", async () => {
  const actual = await vi.importActual<typeof import("@/api/catalog")>("@/api/catalog")
  return {
    ...actual,
    listCombos: vi.fn().mockResolvedValue([COMBO]),
    setComboToday: vi.fn().mockResolvedValue(COMBO),
    setComboOptionAvailability: vi.fn(),
  }
})

describe("DailyMenuTab", () => {
  it("«armar el menú de hoy» envía los active_option_ids correctos", async () => {
    const user = userEvent.setup()
    renderWithProviders(<DailyMenuTab storeId={1} />, { me: { kind: "admin", features: {} } })

    // Con un solo combo, se elige solo (sin exigir un clic extra en el
    // selector): "armar el menú de hoy en menos de dos minutos".
    // Estado inicial: sólo "Sancocho de gallina" (101) viene activo hoy.
    const sancocho = await screen.findByRole("checkbox", { name: "Sancocho de gallina" })
    const ajiaco = screen.getByRole("checkbox", { name: "Ajiaco santafereño" })
    expect(sancocho).toBeChecked()
    expect(ajiaco).not.toBeChecked()

    // El admin arma el menú de hoy: saca el sancocho, agrega el ajiaco.
    await user.click(sancocho)
    await user.click(ajiaco)

    await user.click(screen.getByRole("button", { name: "Guardar menú de hoy" }))

    await waitFor(() => expect(setComboToday).toHaveBeenCalledWith(1, [102]))
  })
})
