/**
 * Inventario › Conteo por área (admin). Lo que no se negocia:
 *
 * - la pestaña vive en «Más» y sólo con `inventory.shift_counts`;
 * - el historial pinta las cifras del servidor (faltante, fuera del umbral),
 *   y `null` es «—», nunca «$ 0»;
 * - el detalle muestra la derivación de cada renglón tal como llega;
 * - llegar con `?conteo=ID` (desde Hoy) abre ese detalle.
 */
import { screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"

import type { AreaCountDetailOut, AreaCountOut } from "@/api/areaCounts"
import { buildMe, renderWithProviders } from "@/test/utils"

import { InventoryAdminPage } from "../InventoryAdminPage"

vi.mock("@/app/storeContext", () => ({
  useStoreSelection: () => ({ stores: [{ id: 1, name: "Sede Centro" }], loading: false, activeStoreId: 1, setActiveStoreId: vi.fn() }),
}))

const mocks = vi.hoisted(() => ({
  listCountAreas: vi.fn(),
  listAreaCounts: vi.fn(),
  getAreaCount: vi.fn(),
  listAreaRecounts: vi.fn(),
  getAreaCountSettings: vi.fn(),
  getAreaCountStatus: vi.fn(),
}))

vi.mock("@/api/areaCounts", async () => {
  const actual = await vi.importActual<typeof import("@/api/areaCounts")>("@/api/areaCounts")
  return { ...actual, ...mocks }
})
vi.mock("@/api/inventory", async () => {
  const actual = await vi.importActual<typeof import("@/api/inventory")>("@/api/inventory")
  return { ...actual, listIngredients: vi.fn().mockResolvedValue([]) }
})
vi.mock("@/api/employees", async () => {
  const actual = await vi.importActual<typeof import("@/api/employees")>("@/api/employees")
  return { ...actual, listEmployees: vi.fn().mockResolvedValue([]) }
})

function count(overrides: Partial<AreaCountOut> = {}): AreaCountOut {
  return {
    id: 31,
    area_id: 2,
    area_name: "Cocina",
    moment: "closing",
    window: "shift",
    counted_at: "2026-09-15T03:00:00Z",
    business_date: "2026-09-14",
    employee_name: "Beto",
    reference_count_id: 30,
    reference_counted_at: "2026-09-14T14:00:00Z",
    reference_employee_name: "Ana",
    reason: null,
    superseded: false,
    lines_count: 2,
    flagged_count: 1,
    shortage_value_total: 16000,
    unvalued_lines: 0,
    scope: "short",
    people: ["Beto"],
    last_counted_at: "2026-09-15T03:00:00Z",
    ...overrides,
  }
}

const DETAIL: AreaCountDetailOut = {
  ...count(),
  lines: [
    {
      ingredient_id: 2,
      ingredient_name: "Carne",
      base_unit: "g",
      entered_qty: "10.8",
      entered_unit: "kg",
      counted_qty: "10800",
      reference_qty: "9500",
      inflow_qty: "5000",
      outflow_qty: "3200",
      expected_qty: "11300",
      shortage_qty: "500",
      shortage_value: 15000,
      shortage_pct_bp: 442,
      flagged: true,
      null_reason: null,
      employee_name: "Beto",
      counted_at: "2026-09-15T03:00:00Z",
      history: [
        {
          employee_name: "Ana",
          counted_at: "2026-09-15T02:50:00Z",
          entered_qty: "11",
          entered_unit: "kg",
          counted_qty: "11000",
        },
      ],
    },
  ],
}

function me(on = true) {
  return buildMe({ features: { "inventory.perpetual": true, "inventory.shift_counts": on } })
}

describe("Inventario › Conteo por área", () => {
  beforeEach(() => {
    mocks.listCountAreas.mockResolvedValue([
      {
        id: 2,
        name: "Cocina",
        active: true,
        members: [{ employee_id: 5, employee_name: "Beto" }],
        items: [],
        categories: ["Proteínas"],
        full_count_items: 9,
      },
    ])
    mocks.getAreaCountStatus.mockResolvedValue({
      business_date: "2026-09-15",
      full_count_today: false,
      areas: [
        {
          area_id: 2,
          area_name: "Cocina",
          scope: "short",
          mine: false,
          items: [
            {
              ingredient_id: 2, name: "Carne", base_unit: "g", entry_mode: "weight", entry_unit: "kg",
              opening: { employee_name: "Kevin", counted_at: "2026-09-15T12:10:00Z", entries: 1 },
              closing: null,
            },
            {
              ingredient_id: 3, name: "Huevos", base_unit: "unit", entry_mode: "unit", entry_unit: "unidad",
              opening: null, closing: null,
            },
          ],
          opening: { counted: 1, total: 2, complete: false, completed_at: null, people: ["Kevin"] },
          closing: { counted: 0, total: 2, complete: false, completed_at: null, people: [] },
        },
      ],
    })
    mocks.listAreaCounts.mockResolvedValue([count(), count({ id: 32, area_name: "Bar", flagged_count: 0, shortage_value_total: null, reason: "Nadie contó esta área al abrir" })])
    mocks.getAreaCount.mockResolvedValue(DETAIL)
    mocks.listAreaRecounts.mockResolvedValue([])
    mocks.getAreaCountSettings.mockResolvedValue({
      store_id: 1, threshold_pct_bp: 200, threshold_amount: 20000, reading: "Se marca un artículo cuando…",
      monthly_full_count_day: 1, monthly_reading: "El día 1 de cada mes…", full_count_today: false,
    })
  })

  it("la pestaña está en «Más» sólo con la función", async () => {
    const user = userEvent.setup()
    const features = (on: boolean) =>
      buildMe({ features: { "inventory.perpetual": true, "inventory.counts": true, "inventory.shift_counts": on } })
    const { unmount } = renderWithProviders(<InventoryAdminPage />, { me: features(false), route: "/admin/inventario" })
    await user.click(await screen.findByRole("button", { name: "Más" }))
    expect(await screen.findByRole("menuitem", { name: "Movimientos y mermas" })).toBeInTheDocument()
    expect(screen.queryByRole("menuitem", { name: "Conteo por área" })).not.toBeInTheDocument()
    unmount()
    renderWithProviders(<InventoryAdminPage />, { me: features(true), route: "/admin/inventario" })
    await user.click(await screen.findByRole("button", { name: "Más" }))
    expect(await screen.findByRole("menuitem", { name: "Conteo por área" })).toBeInTheDocument()
  })

  it("el historial pinta las cifras del servidor, y sin comparar no es $ 0", async () => {
    renderWithProviders(<InventoryAdminPage />, { me: me(), route: "/admin/inventario?tab=por-area" })
    const tabla = await screen.findByRole("table", { name: "Conteos cortos por área" })
    const cocina = (await within(tabla).findByRole("button", { name: /conteo de Cocina/ })).closest("tr") as HTMLElement
    expect(cocina.textContent).toContain("1 de 2")
    expect(cocina.textContent).toContain("16.000")
    expect(cocina.textContent).toContain("Cierre · del turno")
    const bar = within(tabla).getByRole("button", { name: /conteo de Bar/ }).closest("tr") as HTMLElement
    expect(bar.textContent).toContain("sin comparar")
    expect(bar.textContent).not.toContain("$ 0")
  })

  it("?conteo=ID abre el detalle con la derivación de cada renglón", async () => {
    renderWithProviders(<InventoryAdminPage />, { me: me(), route: "/admin/inventario?tab=por-area&conteo=31" })
    const dialogo = await screen.findByRole("dialog")
    await waitFor(() => expect(mocks.getAreaCount).toHaveBeenCalledWith(1, 31))
    const fila = (await within(dialogo).findByText("Carne")).closest("tr") as HTMLElement
    expect(fila.textContent).toContain("faltan 500 g")
    expect(fila.textContent).toContain("15.000")
    expect(within(dialogo).getByText(/contra lo que contó Ana/)).toBeInTheDocument()
    // Quién contó cada artículo y a qué hora; el recuento anterior queda en el historial.
    expect(fila.textContent).toContain("Beto · 22:00")
    expect(fila.textContent).toContain("recontado")
  })

  it("hoy, artículo por artículo: quién contó y cuándo, y la apertura que falta en rojo", async () => {
    renderWithProviders(<InventoryAdminPage />, { me: me(), route: "/admin/inventario?tab=por-area" })
    const tabla = await screen.findByRole("table", { name: "Conteo de hoy de Cocina" })
    const carne = within(tabla).getByText("Carne").closest("tr") as HTMLElement
    expect(carne.textContent).toContain("Contado por Kevin · 7:10")
    const huevos = within(tabla).getByText("Huevos").closest("tr") as HTMLElement
    expect(huevos.textContent).toContain("Sin contar")
    expect(screen.getByText(/Apertura 1 de 2.*falta \(es obligatoria\)/)).toBeInTheDocument()
  })

  it("configura las categorías del conteo completo y el día del mes", async () => {
    renderWithProviders(<InventoryAdminPage />, { me: me(), route: "/admin/inventario?tab=por-area" })
    const areas = await screen.findByRole("table", { name: "Áreas de conteo" })
    expect((await within(areas).findByText(/Proteínas · 9 insumos/)).closest("tr")).not.toBeNull()
    expect(await screen.findByText("El día 1 de cada mes…")).toBeInTheDocument()
    expect(screen.getByRole("combobox", { name: "Día del conteo completo" })).toBeInTheDocument()
  })
})
