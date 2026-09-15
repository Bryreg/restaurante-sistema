import { screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

import { renderWithProviders } from "@/test/utils"

import { OrdersAdminPage } from "../OrdersAdminPage"
import { adminMe } from "./fixtures"

vi.mock("@/app/storeContext", () => ({
  useStoreSelection: () => ({ stores: [{ id: 1, name: "Sede Centro" }], loading: false, activeStoreId: 1, setActiveStoreId: vi.fn() }),
}))

const { adminListOrdersMock } = vi.hoisted(() => ({ adminListOrdersMock: vi.fn() }))

vi.mock("@/api/orders", async () => {
  const actual = await vi.importActual<typeof import("@/api/orders")>("@/api/orders")
  return { ...actual, adminListOrders: adminListOrdersMock }
})

describe("OrdersAdminPage", () => {
  it("lista comandas con estado, canal, tiempos y anulaciones", async () => {
    adminListOrdersMock.mockResolvedValue([
      {
        id: 501,
        business_date: "2026-09-15",
        shift_id: 7,
        channel: "dine_in",
        tables: ["5"],
        covers: 4,
        status: "paid",
        opened_by: "Ana",
        opened_at: "2026-09-15T18:00:00Z",
        bill_presented_at: "2026-09-15T19:00:00Z",
        paid_at: "2026-09-15T19:05:00Z",
        items_count: 3,
        total: 45000,
        voided_items: 1,
        voids_after_bill: 0,
        courtesies: 0,
        discount_total: 0,
        sent_at_payment_items: 0,
        transferred: false,
      },
    ])

    renderWithProviders(<OrdersAdminPage />, { me: adminMe({}) })

    await waitFor(() => expect(screen.getByText("501")).toBeInTheDocument())
    expect(screen.getByText("Mesa")).toBeInTheDocument()
    expect(screen.getByRole("cell", { name: "Pagada" })).toBeInTheDocument()
  })

  it("el filtro de anuladas manda flags=voided a la API", async () => {
    adminListOrdersMock.mockResolvedValue([])
    const user = userEvent.setup()

    renderWithProviders(<OrdersAdminPage />, { me: adminMe({}) })

    await waitFor(() => expect(adminListOrdersMock).toHaveBeenCalled())
    await user.click(screen.getByRole("button", { name: "Anuladas" }))

    await waitFor(() =>
      expect(adminListOrdersMock).toHaveBeenCalledWith(expect.objectContaining({ flags: "voided" })),
    )
  })
})
