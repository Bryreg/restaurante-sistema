import { screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

import { renderWithProviders } from "@/test/utils"
import type { CountOut } from "@/api/inventory"

import { CountsTab } from "../CountsTab"

const { listCountsMock, voidCountMock } = vi.hoisted(() => ({ listCountsMock: vi.fn(), voidCountMock: vi.fn() }))

vi.mock("@/api/inventory", async () => {
  const actual = await vi.importActual<typeof import("@/api/inventory")>("@/api/inventory")
  return { ...actual, listCounts: listCountsMock, voidCount: voidCountMock }
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
    const user = userEvent.setup()
    renderWithProviders(<CountsTab storeId={1} />)

    await waitFor(() => expect(screen.getByText("#11")).toBeInTheDocument())
    expect(within(screen.getByRole("table")).getByText("Aplicado")).toBeInTheDocument()
    expect(screen.queryByText("(parcial)")).not.toBeInTheDocument()
    // Quién lo aplicó va detrás de «Más columnas» (regla 3): a un toque, no perdido.
    await user.click(screen.getByRole("button", { name: /Más columnas/ }))
    expect(screen.getByText(/Carlos/)).toBeInTheDocument()
  })

  it("el filtro de alcance se manda al servidor", async () => {
    listCountsMock.mockResolvedValue([])
    renderWithProviders(<CountsTab storeId={5} />)
    await waitFor(() => expect(listCountsMock).toHaveBeenCalledWith(expect.objectContaining({ storeId: 5 })))
  })

  it("un conteo se anula con motivo y PIN desde el «⋯», y el anulado lo dice con su motivo", async () => {
    const applied: CountOut = { ...OPEN_COUNT, id: 5, status: "applied", lines_counted: 10 }
    listCountsMock.mockResolvedValue([applied, { ...OPEN_COUNT, id: 3, status: "voided", void_reason: "Demo duplicada" }])
    voidCountMock.mockResolvedValue({ ...applied, status: "voided" })
    const user = userEvent.setup()
    renderWithProviders(<CountsTab storeId={1} />)

    await waitFor(() => expect(screen.getByText("#5")).toBeInTheDocument())
    expect(within(screen.getByRole("table")).getByText("Anulado")).toBeInTheDocument()
    expect(screen.getByText(/Demo duplicada/)).toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: /conteo #5/ }))
    await user.click(await screen.findByRole("menuitem", { name: /Anular con motivo/ }))
    await user.type(screen.getByLabelText("Motivo"), "Conteo cargado dos veces")
    for (const d of "9999") await user.click(screen.getByRole("button", { name: `Dígito ${d}` }))
    await waitFor(() =>
      expect(voidCountMock).toHaveBeenCalledWith(
        5,
        1,
        { reason: "Conteo cargado dos veces", authorizer_pin: "9999" },
        expect.any(String),
      ),
    )
  })
})
