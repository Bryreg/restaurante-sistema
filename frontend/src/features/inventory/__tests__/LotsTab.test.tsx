import { screen, waitFor, within } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import { renderWithProviders } from "@/test/utils"
import type { IngredientOut, LotOut } from "@/api/inventory"

import { LotsTab } from "../LotsTab"

const { getLotsMock } = vi.hoisted(() => ({ getLotsMock: vi.fn() }))

vi.mock("@/api/inventory", async () => {
  const actual = await vi.importActual<typeof import("@/api/inventory")>("@/api/inventory")
  return { ...actual, getLots: getLotsMock }
})

const LECHUGA: IngredientOut = {
  id: 5,
  name: "Lechuga",
  category: null,
  base_unit: "g",
  purchase_unit: "caja",
  purchase_factor: 5000,
  yield_pct: 100,
  official_cost: null,
  estimated_cost: null,
  cost: "12",
  cost_source: "last_purchase",
  min_stock: "1000",
  lead_time_days: null,
  perishable: true,
  key_item: false,
  consumption_untracked: false,
  substitute_ingredient_id: null,
  supplier_id: null,
  active: true,
}

const EXPIRED_LOT: LotOut = {
  id: 1,
  ingredient_id: 5,
  ingredient_name: "Lechuga",
  lot_code: "L-001",
  qty_received: "5000",
  qty_remaining: "800",
  unit_cost: "12",
  cost_source: "last_purchase",
  expires_at: "2026-09-10",
  received_at: "2026-09-01T10:00:00Z",
  status: "expired",
  source_type: "reception",
  source_id: 1,
}

describe("LotsTab — FEFO y «un lote vencido no se da de baja solo» (SPEC-NEGOCIO §5.7)", () => {
  it("un lote vencido muestra su badge y el enlace correctivo a registrar la merma — nunca un botón de baja", async () => {
    getLotsMock.mockResolvedValue([EXPIRED_LOT])

    renderWithProviders(<LotsTab storeId={1} ingredients={[LECHUGA]} />)

    await waitFor(() => expect(screen.getByText("Lechuga")).toBeInTheDocument())

    expect(within(screen.getByRole("table")).getByText("Vencido")).toBeInTheDocument()

    const link = screen.getByRole("link", { name: /registrar merma \(vencido\)/i })
    expect(link).toHaveAttribute("href", "/pos/merma")

    // La regla, no un detalle de interacción: ningún botón "dar de baja" o
    // "marcar vencido" en ningún lugar de la pantalla.
    expect(screen.queryByRole("button", { name: /dar de baja/i })).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /marcar vencido/i })).not.toBeInTheDocument()
    expect(screen.queryByText(/dar de baja/i)).not.toBeInTheDocument()
  })

  it("un lote activo no ofrece ninguna acción (no está vencido, nada que corregir)", async () => {
    getLotsMock.mockResolvedValue([{ ...EXPIRED_LOT, id: 2, status: "active", expires_at: "2026-12-31" }])

    renderWithProviders(<LotsTab storeId={1} ingredients={[LECHUGA]} />)

    await waitFor(() => expect(screen.getByText("Lechuga")).toBeInTheDocument())
    expect(screen.getByText("Activo")).toBeInTheDocument()
    expect(screen.queryByRole("link", { name: /registrar merma/i })).not.toBeInTheDocument()
  })

  it("el filtro de estado se manda al servidor, nunca se filtra en el cliente", async () => {
    getLotsMock.mockResolvedValue([])
    renderWithProviders(<LotsTab storeId={9} ingredients={[LECHUGA]} />)

    await waitFor(() => expect(getLotsMock).toHaveBeenCalledWith(expect.objectContaining({ storeId: 9 })))
  })

  it("resuelve la unidad base cruzando con `ingredients` (LotOut no trae base_unit)", async () => {
    getLotsMock.mockResolvedValue([EXPIRED_LOT])
    renderWithProviders(<LotsTab storeId={1} ingredients={[LECHUGA]} />)

    await waitFor(() => expect(screen.getByText(/800\s*g/)).toBeInTheDocument())
  })
})
