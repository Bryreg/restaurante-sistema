import { screen, waitFor, within } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import { renderWithProviders } from "@/test/utils"
import type { CountOut } from "@/api/inventory"

import { CountsTab } from "../CountsTab"

const { listCountsMock } = vi.hoisted(() => ({ listCountsMock: vi.fn() }))

vi.mock("@/api/inventory", async () => {
  const actual = await vi.importActual<typeof import("@/api/inventory")>("@/api/inventory")
  return { ...actual, listCounts: listCountsMock }
})

const OPEN_COUNT: CountOut = {
  id: 12,
  scope: "key_items",
  status: "open",
  opened_at: "2026-09-15T13:07:00Z",
  business_date: "2026-09-15",
  opened_by_employee_id: 3,
  opened_by_employee_name: "Ana",
  applied_at: null,
  applied_by_employee_id: null,
  applied_by_employee_name: null,
  lines_total: 10,
  lines_counted: 4,
}

describe("CountsTab", () => {
  it("lista conteos con enlace a la captura y avisa cuando el conteo está parcial", async () => {
    listCountsMock.mockResolvedValue([OPEN_COUNT])
    renderWithProviders(<CountsTab storeId={1} />)

    await waitFor(() => expect(screen.getByText("#12")).toBeInTheDocument())
    expect(screen.getByRole("link", { name: "#12" })).toHaveAttribute("href", "/admin/inventario/conteos/12")
    expect(screen.getByText("(parcial)")).toBeInTheDocument()
    expect(within(screen.getByRole("table")).getByText("Abierto")).toBeInTheDocument()
  })

  it("un conteo aplicado muestra quién y cuándo, sin «(parcial)»", async () => {
    listCountsMock.mockResolvedValue([
      {
        ...OPEN_COUNT,
        id: 11,
        status: "applied",
        lines_counted: 10,
        applied_at: "2026-09-14T09:00:00Z",
        applied_by_employee_id: 1,
        applied_by_employee_name: "Carlos",
      },
    ])
    renderWithProviders(<CountsTab storeId={1} />)

    await waitFor(() => expect(screen.getByText("#11")).toBeInTheDocument())
    expect(within(screen.getByRole("table")).getByText("Aplicado")).toBeInTheDocument()
    expect(screen.queryByText("(parcial)")).not.toBeInTheDocument()
    expect(screen.getByText(/Carlos/)).toBeInTheDocument()
  })

  it("el filtro de alcance se manda al servidor", async () => {
    listCountsMock.mockResolvedValue([])
    renderWithProviders(<CountsTab storeId={5} />)
    await waitFor(() => expect(listCountsMock).toHaveBeenCalledWith(expect.objectContaining({ storeId: 5 })))
  })
})
