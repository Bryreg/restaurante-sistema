import { screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

import { buildMe, renderWithProviders } from "@/test/utils"

import { TodayPage } from "../TodayPage"

/**
 * Leído no es resuelto (0042): un aviso de la campana sigue en «Requiere tu
 * atención» aunque ya se haya visto, y sale con «Resolver» (o cuando la
 * condición se apaga, que lo decide el servidor).
 */

vi.mock("@/app/storeContext", () => ({
  useStoreSelection: () => ({ stores: [{ id: 1, name: "Sede Centro" }], loading: false, activeStoreId: 1, setActiveStoreId: vi.fn() }),
}))

const m = vi.hoisted(() => ({ getToday: vi.fn(), resolveNotifications: vi.fn() }))

vi.mock("@/api/reports", async () => {
  const actual = await vi.importActual<typeof import("@/api/reports")>("@/api/reports")
  return { ...actual, getToday: m.getToday }
})
vi.mock("@/api/notifications", async () => {
  const actual = await vi.importActual<typeof import("@/api/notifications")>("@/api/notifications")
  return { ...actual, resolveNotifications: m.resolveNotifications }
})

function baseToday(overrides: Record<string, unknown> = {}) {
  return {
    store_id: 1,
    business_date: "2026-09-15",
    sales_by_hour: [{ hour: 12, gross: 100000, net: 92593 }],
    gross: 100000,
    net: 92593,
    tax: 7407,
    tips_total: 0,
    tips_by_method: [],
    orders: 5,
    covers: 12,
    avg_ticket: 18519,
    avg_per_cover: 7716,
    tables_occupied: 0,
    tables_total: 8,
    open_orders: [],
    unsent_count: 0,
    unpaid_count: 0,
    expected_cash: 250000,
    unavailable_products: [],
    pending_refunds_count: 0,
    unreviewed_closes_count: 0,
    alerts: [],
    ingredients_below_min: [],
    ingredients_negative: [],
    preps_without_production: [],
    products_discounting_nothing: [],
    ...overrides,
  }
}

const PIN = {
  type: "pin_locked",
  level: "warning",
  title: "PIN bloqueado",
  body: "Luz Marina erró el PIN cinco veces.",
  created_at: "2026-09-15T12:00:00Z",
  payload: null,
  notification_ids: [41],
}

function aviso(title: string): HTMLElement {
  const item = screen.getByText(title).closest("li")
  if (!item) throw new Error(`sin aviso «${title}»`)
  return item
}

describe("Resolver un aviso del riel", () => {
  it("un aviso de la campana trae «Resolver», que lo resuelve a nombre de quien lo toca", async () => {
    m.getToday.mockResolvedValue(baseToday({ alerts: [PIN] }))
    m.resolveNotifications.mockResolvedValue({ resolved: 1 })
    renderWithProviders(<TodayPage />, { me: buildMe() })

    await screen.findByText("PIN bloqueado")
    // Lo que el servidor manda después: ya resuelto, fuera del riel.
    m.getToday.mockResolvedValue(baseToday({ alerts: [] }))
    await userEvent.click(within(aviso("PIN bloqueado")).getByRole("button", { name: "Resolver" }))

    await waitFor(() => expect(m.resolveNotifications).toHaveBeenCalledTimes(1))
    const [ids, key] = m.resolveNotifications.mock.calls[0] as [number[], string]
    expect(ids).toEqual([41])
    expect(key).toBeTruthy()
    await waitFor(() => expect(screen.queryByText("PIN bloqueado")).not.toBeInTheDocument())
  })

  it("un aviso que no sale de la campana no ofrece «Resolver»", async () => {
    m.getToday.mockResolvedValue(baseToday({ alerts: [{ ...PIN, notification_ids: [] }] }))
    renderWithProviders(<TodayPage />, { me: buildMe() })

    await screen.findByText("PIN bloqueado")
    expect(within(aviso("PIN bloqueado")).queryByRole("button", { name: "Resolver" })).not.toBeInTheDocument()
  })

  it("los avisos de insumo bajo el mínimo o en negativo no se repiten en el riel: ya tienen su tarjeta", async () => {
    m.getToday.mockResolvedValue(
      baseToday({
        alerts: [
          { ...PIN, type: "ingredient_below_min", title: "Insumo bajo el mínimo", notification_ids: [7] },
          { ...PIN, type: "ingredient_negative", title: "Insumo en negativo", notification_ids: [8] },
        ],
      }),
    )
    renderWithProviders(<TodayPage />, { me: buildMe() })

    await waitFor(() => expect(screen.getByText("Todo al día")).toBeInTheDocument())
    expect(screen.queryByText("Insumo bajo el mínimo")).not.toBeInTheDocument()
    expect(screen.queryByText("Insumo en negativo")).not.toBeInTheDocument()
  })
})
