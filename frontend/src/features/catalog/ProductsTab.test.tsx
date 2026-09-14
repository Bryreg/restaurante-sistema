import { screen, waitFor } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import type { ProductAdminOut } from "@/api/catalog"
import { renderWithProviders } from "@/test/utils"

import { ProductsTab } from "./ProductsTab"

// `vi.mock` se hoistea sobre los imports: los datos de prueba que usa la
// factory tienen que declararse con `vi.hoisted`, si no, referenciar un
// `const` normal de más abajo revienta con "Cannot access before initialization".
const { PRODUCTS } = vi.hoisted(() => ({
  PRODUCTS: [
    {
      id: 1,
      category_id: 1,
      name: "Bandeja paisa",
      description: null,
      station: "hot_kitchen",
      default_course: "main",
      prices: { dine_in: 38_000, takeout: 35_000, delivery: null, platform: null },
      tax_code: "inc_8",
      active: true,
      available: true,
      daily_count: null,
      daily_remaining: null,
      modifier_groups: [],
    },
  ] satisfies ProductAdminOut[],
}))

vi.mock("@/api/catalog", async () => {
  const actual = await vi.importActual<typeof import("@/api/catalog")>("@/api/catalog")
  return {
    ...actual,
    listCategories: vi.fn().mockResolvedValue([{ id: 1, name: "Platos Fuertes", sort_order: 0, active: true }]),
    listProducts: vi.fn().mockResolvedValue(PRODUCTS),
  }
})

describe("ProductsTab", () => {
  it("muestra los precios formateados y '—' cuando falta el opcional", async () => {
    renderWithProviders(<ProductsTab storeId={1} />, { me: { kind: "admin", features: {} } })

    await waitFor(() => expect(screen.getByText("Bandeja paisa")).toBeInTheDocument())

    const row = screen.getByText("Bandeja paisa").closest("tr")
    expect(row).not.toBeNull()
    const cells = row!.querySelectorAll("td")
    // Nombre, Mesa, Para llevar, Domicilio, Plataforma, Disponible, acciones.
    expect(cells[1].textContent).toContain("38.000")
    expect(cells[2].textContent).toContain("35.000")
    expect(cells[3].textContent).toBe("—")
    expect(cells[4].textContent).toBe("—")
  })
})
