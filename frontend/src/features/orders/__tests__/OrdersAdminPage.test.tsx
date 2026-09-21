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
    adminListOrdersMock.mockResolvedValue({
      rows: [
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
          closed_at: "2026-09-15T19:05:00Z",
          table_minutes: 65,
          bill_to_paid_minutes: 5,
          items_count: 3,
          total: 45000,
          voided_items: 1,
          voids_after_bill: 0,
          void_details: [{ item_id: 9, reason: "kitchen_error", after_bill: false, minutes_since_sent: 4, authorized_by: null }],
          courtesies: 0,
          discount_total: 0,
          sent_at_payment_items: 0,
          sent_at_payment_ratio: 0,
          is_staff_meal: false,
          transferred: false,
          payment_methods: ["cash"],
        },
      ],
      kitchen_times_by_station: [{ station: "grill", p50_seconds: 300, p90_seconds: 600, samples: 4 }],
      sent_at_payment_ratio: 0.1,
    })

    renderWithProviders(<OrdersAdminPage />, { me: adminMe({}) })

    // El número de comanda se escribe como UNA palabra, `#501`
    // (`docs/PATRONES-ADMIN.md` § 8: nunca `50` / `1`).
    await waitFor(() => expect(screen.getByText("#501")).toBeInTheDocument())
    expect(screen.getByText("Mesa")).toBeInTheDocument()
    expect(screen.getByRole("cell", { name: "Pagada" })).toBeInTheDocument()
    expect(screen.getAllByText("grill").length).toBeGreaterThan(0)
  })

  it("el filtro de anuladas manda flags=voided a la API", async () => {
    adminListOrdersMock.mockResolvedValue({ rows: [], kitchen_times_by_station: [], sent_at_payment_ratio: null })
    const user = userEvent.setup()

    renderWithProviders(<OrdersAdminPage />, { me: adminMe({}) })

    await waitFor(() => expect(adminListOrdersMock).toHaveBeenCalled())
    await user.click(screen.getByRole("button", { name: "Anuladas" }))

    await waitFor(() =>
      expect(adminListOrdersMock).toHaveBeenCalledWith(expect.objectContaining({ flags: "voided" })),
    )
  })
})
