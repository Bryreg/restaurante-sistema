import { screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
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
      is_delivery_fee: false,
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
  it("muestra los precios formateados y dice 'Igual que mesa' cuando falta el opcional", async () => {
    renderWithProviders(<ProductsTab storeId={1} />, { me: { kind: "admin", features: {} } })

    await waitFor(() => expect(screen.getByText("Bandeja paisa")).toBeInTheDocument())

    const row = screen.getByText("Bandeja paisa").closest("tr")
    expect(row).not.toBeNull()
    const cells = row!.querySelectorAll("td")
    // Cinco a la vista (regla 3): Nombre, Mesa, Domicilio, Plataforma,
    // Disponible, y la columna de acciones.
    expect(cells).toHaveLength(6)
    expect(cells[1].textContent).toContain("38.000")
    // No un "—" ambiguo (SPEC-NEGOCIO §4.3): un precio opcional vacío CAE al
    // de mesa, nunca a 0 ni a "sin dato" a secas.
    expect(cells[2].textContent).toBe("Igual que mesa")
    expect(cells[3].textContent).toBe("Igual que mesa")
    expect(row!.textContent).not.toContain("35.000")

    // Para llevar vive detrás de «Más columnas», con su precio tal cual.
    await userEvent.setup().click(screen.getByRole("button", { name: "Más columnas (1)" }))
    const todas = screen.getByText("Bandeja paisa").closest("tr")!.querySelectorAll("td")
    // Nombre, Mesa, Para llevar, Domicilio, Plataforma, Disponible, acciones.
    expect(todas[2].textContent).toContain("35.000")
    expect(todas[3].textContent).toBe("Igual que mesa")
    expect(todas[4].textContent).toBe("Igual que mesa")
  })

  it("«Editar» abre el formulario del producto de esa fila", async () => {
    const user = userEvent.setup()
    renderWithProviders(<ProductsTab storeId={1} />, { me: { kind: "admin", features: {} } })

    await waitFor(() => expect(screen.getByText("Bandeja paisa")).toBeInTheDocument())
    await user.click(screen.getByRole("button", { name: "Editar" }))
    expect(await screen.findByRole("dialog", { name: "Editar Bandeja paisa" })).toBeInTheDocument()
  })

  it("marca el producto que es el cargo de domicilio de la sede", async () => {
    renderWithProviders(<ProductsTab storeId={1} />, { me: { kind: "admin", features: {} } })

    await waitFor(() => expect(screen.getByText("Bandeja paisa")).toBeInTheDocument())
    expect(screen.queryByText("Cargo de domicilio")).not.toBeInTheDocument()
  })
})
