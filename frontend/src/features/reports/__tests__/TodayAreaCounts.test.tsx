/**
 * Hoy · «Conteo por área» (`inventory.shift_counts`). Lo que no se negocia:
 *
 * - con la función apagada no hay aviso;
 * - un área sin conteo de apertura es un aviso que dice que no bloquea;
 * - cada artículo fuera del umbral es un aviso que dice si fue de noche o en
 *   el turno, con la plata y la cantidad TAL COMO las manda el servidor, y
 *   lleva al detalle del conteo;
 * - un recuento dentro del umbral no es aviso.
 *
 * Cambio intencional (decisión del dueño, 2026-09-29): la tarjeta «Conteo
 * por área» salió de Hoy (Hoy muestra sólo venta, cifras, ventas por hora,
 * top productos, entradas de mercancía y los avisos). El conteo sigue en
 * Inventario › Conteo por área; en Hoy quedan sus avisos del riel.
 */
import { screen, waitFor, within } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import type { AreaCountFlagOut } from "@/api/reports"
import { buildMe, renderWithProviders } from "@/test/utils"

import { TodayPage } from "../TodayPage"

vi.mock("@/app/storeContext", () => ({
  useStoreSelection: () => ({ stores: [{ id: 1, name: "Sede Centro" }], loading: false, activeStoreId: 1, setActiveStoreId: vi.fn() }),
}))

const { getTodayMock } = vi.hoisted(() => ({ getTodayMock: vi.fn() }))

vi.mock("@/api/reports", async () => {
  const actual = await vi.importActual<typeof import("@/api/reports")>("@/api/reports")
  return { ...actual, getToday: getTodayMock }
})

function baseToday(overrides: Record<string, unknown> = {}) {
  return {
    store_id: 1,
    business_date: "2026-09-15",
    sales_by_hour: [],
    gross: 0,
    net: 0,
    tax: 0,
    tips_total: 0,
    tips_by_method: [],
    orders: 0,
    covers: null,
    avg_ticket: null,
    avg_per_cover: null,
    tables_occupied: 0,
    tables_total: 0,
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

function flag(overrides: Partial<AreaCountFlagOut> = {}): AreaCountFlagOut {
  return {
    count_id: 31,
    area_name: "Cocina",
    window: "night",
    ingredient_id: 2,
    ingredient_name: "Carne",
    base_unit: "g",
    shortage_qty: "500",
    shortage_value: 15000,
    flagged: true,
    counted_at: "2026-09-15T14:00:00Z",
    employee_name: "Beto",
    ...overrides,
  }
}

describe("TodayPage · Conteo por área", () => {
  it("con la función apagada no dibuja tarjeta ni avisos", async () => {
    getTodayMock.mockResolvedValue(baseToday({ area_counts_enabled: false }))
    renderWithProviders(<TodayPage />, { me: buildMe() })
    await screen.findByText("Requiere tu atención")
    expect(screen.queryByRole("heading", { name: "Conteo por área" })).not.toBeInTheDocument()
    expect(screen.queryByText(/sin conteo de apertura/)).not.toBeInTheDocument()
  })

  it("un aviso por el área sin apertura y uno por artículo fuera del umbral; la tarjeta ya no está en Hoy", async () => {
    getTodayMock.mockResolvedValue(
      baseToday({
        area_counts_enabled: true,
        area_counts_areas: [
          { area_id: 1, area_name: "Bar", opening: null, closing: null },
          {
            area_id: 2,
            area_name: "Cocina",
            opening: { count_id: 31, counted_at: "2026-09-15T14:00:00Z", employee_name: "Beto" },
            closing: null,
          },
        ],
        area_counts_flags: [
          flag(),
          flag({
            count_id: 40,
            window: "spot",
            area_name: "Bar",
            ingredient_id: 9,
            ingredient_name: "Ron",
            base_unit: "ml",
            shortage_qty: "-250",
            shortage_value: -15000,
            flagged: false,
          }),
        ],
        area_recounts_pending_count: 1,
      }),
    )
    renderWithProviders(<TodayPage />, { me: buildMe() })

    await screen.findByText("Requiere tu atención")
    expect(screen.queryByRole("heading", { name: "Conteo por área" })).not.toBeInTheDocument()

    // El riel: el área sin apertura (no bloquea) y el artículo de noche, con su plata.
    await waitFor(() => expect(screen.getByText("1 área sin conteo de apertura")).toBeInTheDocument())
    expect(screen.getByText(/No bloquea el turno/)).toBeInTheDocument()
    const aviso = screen.getByText("Faltan 500 g de Carne de noche").closest("li") as HTMLElement
    expect(aviso.textContent).toContain("15.000")
    expect(within(aviso).getByRole("link").getAttribute("href")).toBe("/admin/inventario?tab=por-area&conteo=31")
    // El recuento dentro del umbral no es aviso.
    expect(screen.queryByText(/Sobran 250 ml de Ron en un recuento/)).not.toBeInTheDocument()
  })
})
