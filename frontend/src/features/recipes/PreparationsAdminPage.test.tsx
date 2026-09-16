import { screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

import type { Me } from "@/api/auth"
import type { PreparationAdminOut } from "@/api/recipes"
import { renderWithProviders } from "@/test/utils"

import { PreparationsAdminPage } from "./PreparationsAdminPage"

vi.mock("@/app/storeContext", () => ({
  useStoreSelection: () => ({
    stores: [{ id: 1, name: "Sede Centro" }],
    loading: false,
    activeStoreId: 1,
    setActiveStoreId: vi.fn(),
  }),
}))

const { listPreparationsMock, listIngredientOptionsMock, createPreparationMock } = vi.hoisted(() => ({
  listPreparationsMock: vi.fn(),
  listIngredientOptionsMock: vi.fn().mockResolvedValue([]),
  createPreparationMock: vi.fn(),
}))

vi.mock("@/api/recipes", async () => {
  const actual = await vi.importActual<typeof import("@/api/recipes")>("@/api/recipes")
  return {
    ...actual,
    listPreparations: listPreparationsMock,
    listIngredientOptions: listIngredientOptionsMock,
    createPreparation: createPreparationMock,
  }
})

function adminMe(features: Record<string, boolean>): Me {
  return {
    kind: "admin",
    user: { id: 1, name: "Admin de prueba", role: "admin" },
    organization: { id: 1, name: "Organización de prueba" },
    features,
  }
}

const CALDO: PreparationAdminOut = {
  id: 1,
  name: "Caldo base",
  mode: "batch",
  standard_yield_qty: "5",
  standard_yield_unit: "l",
  process_loss_pct: 5,
  shelf_life_days: 3,
  active: true,
  current_stock: "2.500",
  unit_cost: null,
  cost_source: "none",
  lines: [],
}

const HOGAO: PreparationAdminOut = {
  id: 2,
  name: "Hogao",
  mode: "exploded",
  standard_yield_qty: "2",
  standard_yield_unit: "g",
  process_loss_pct: 0,
  shelf_life_days: null,
  active: true,
  current_stock: null,
  // `unit_cost` viaja como string decimal (ronda 2 del contrato: precisión
  // completa, no entero) — nunca un número JSON.
  unit_cost: "1200",
  cost_source: "estimated",
  lines: [],
}

/** Salsa cuyo costo real por unidad es sub-peso ($0,003) — la sal del seed.
 * Redondeado a peso entero publicaría "$ 0" con origen "official": el cero
 * mudo que la spec prohíbe. Motivo de la ronda 2 del contrato. */
const SAL: PreparationAdminOut = {
  id: 3,
  name: "Sal de mesa",
  mode: "exploded",
  standard_yield_qty: "1000",
  standard_yield_unit: "g",
  process_loss_pct: 0,
  shelf_life_days: null,
  active: true,
  current_stock: null,
  unit_cost: "0.003",
  cost_source: "official",
  lines: [],
}

function renderPage(features: Record<string, boolean>) {
  return renderWithProviders(<PreparationsAdminPage />, {
    me: adminMe(features),
    route: "/admin/preparaciones",
  })
}

describe("PreparationsAdminPage", () => {
  it("sin catalog.preps explica qué la prende, no una pantalla rota", () => {
    renderPage({ "catalog.preps": false })
    expect(screen.getByText(/preparaciones no está habilitada/i)).toBeInTheDocument()
    expect(listPreparationsMock).not.toHaveBeenCalled()
  })

  it("un costo null se dice «Sin costo»; un costo con origen se ve formateado", async () => {
    listPreparationsMock.mockResolvedValue([CALDO, HOGAO])
    renderPage({ "catalog.preps": true, multi_store: false })

    await waitFor(() => expect(screen.getByText("Caldo base")).toBeInTheDocument())
    expect(screen.getByText("Hogao")).toBeInTheDocument()

    // Caldo base: sin costo todavía (nunca "$0").
    expect(screen.getByText("Sin costo")).toBeInTheDocument()
    expect(screen.queryByText("$ 0")).not.toBeInTheDocument()

    // Hogao: costo estimado, formateado con su origen visible.
    expect(screen.getByText("$ 1.200")).toBeInTheDocument()
    expect(screen.getByText("estimado")).toBeInTheDocument()

    // Modo visible en español.
    expect(screen.getByText("Por lote")).toBeInTheDocument()
    expect(screen.getByText("Explotada")).toBeInTheDocument()
  })

  it("un costo sub-peso con origen oficial (la sal, $0,003) no se pinta «$ 0»", async () => {
    listPreparationsMock.mockResolvedValue([SAL])
    renderPage({ "catalog.preps": true, multi_store: false })

    await waitFor(() => expect(screen.getByText("Sal de mesa")).toBeInTheDocument())
    expect(screen.queryByText("$ 0")).not.toBeInTheDocument()
    expect(screen.queryByText("Sin costo")).not.toBeInTheDocument()
    expect(screen.getByText("oficial")).toBeInTheDocument()
  })

  it("explica por qué explotada es el default antes de que alguien cree nada", async () => {
    listPreparationsMock.mockResolvedValue([])
    renderPage({ "catalog.preps": true })

    await waitFor(() => expect(listPreparationsMock).toHaveBeenCalled())
    expect(screen.getByText(/una preparación en modo lote queda negativa/i)).toBeInTheDocument()
  })

  it("crear una preparación nueva manda mode e ingredient_id/preparation_id XOR, nunca los dos", async () => {
    listPreparationsMock.mockResolvedValue([])
    createPreparationMock.mockResolvedValue(CALDO)
    listIngredientOptionsMock.mockResolvedValue([{ id: 7, name: "Papa criolla", base_unit: "g" }])

    const user = userEvent.setup()
    renderPage({ "catalog.preps": true })

    await waitFor(() => expect(listPreparationsMock).toHaveBeenCalled())
    await user.click(screen.getByRole("button", { name: "Nueva preparación" }))

    await screen.findByRole("dialog")
    await user.type(screen.getByLabelText("Nombre"), "Sofrito")
    await user.clear(screen.getByLabelText("Rendimiento estándar"))
    await user.type(screen.getByLabelText("Rendimiento estándar"), "1")

    await user.click(screen.getByRole("combobox", { name: "Insumo" }))
    await user.click(await screen.findByRole("option", { name: "Papa criolla (g)" }))
    await user.type(screen.getByLabelText("Cantidad"), "500")

    await user.click(screen.getByRole("button", { name: "Crear" }))

    await waitFor(() => expect(createPreparationMock).toHaveBeenCalledTimes(1))
    const [, body] = createPreparationMock.mock.calls[0]!
    expect(body.name).toBe("Sofrito")
    expect(body.mode).toBe("exploded") // default de la spec §4.2
    expect(body.lines).toEqual([{ ingredient_id: 7, preparation_id: undefined, qty: "500", unit: "g" }])
    // Al crear con éxito, el diálogo se cierra solo (no queda una pantalla muerta pidiendo cerrar a mano).
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())
  })
})
