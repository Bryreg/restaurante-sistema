/**
 * La bandeja de Hoy y el histórico del admin: piden lo abierto (o todo) de la
 * sede que les pasan, en el orden del servidor, y resuelven por la ruta de
 * admin con la sede.
 */
import { screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"

import type { Novelty } from "@/api/novelties"
import { buildMe, renderWithProviders } from "@/test/utils"

import { NoveltiesHistory } from "../NoveltiesHistory"
import { NoveltiesTray } from "../NoveltiesTray"

const mocks = vi.hoisted(() => ({
  listAdminNovelties: vi.fn(),
  resolveNoveltyAsAdmin: vi.fn(),
}))

vi.mock("@/api/novelties", async () => {
  const actual = await vi.importActual<typeof import("@/api/novelties")>("@/api/novelties")
  return { ...actual, ...mocks }
})

function novelty(overrides: Partial<Novelty> = {}): Novelty {
  return {
    id: 1,
    store_id: 7,
    shift_id: null,
    business_date: "2026-09-24",
    title: "Se dañó la nevera",
    detail: "No enfría",
    category: "equipment",
    level: "important",
    requires_follow_up: true,
    photo: null,
    employee_id: 4,
    employee_name: "Ana",
    created_at: "2026-09-24T20:00:00Z",
    open: true,
    resolved_at: null,
    resolved_by_employee_name: null,
    resolution_note: null,
    ...overrides,
  }
}

describe("NoveltiesTray", () => {
  beforeEach(() => {
    mocks.listAdminNovelties.mockReset()
    mocks.resolveNoveltyAsAdmin.mockReset()
  })

  it("pide las abiertas de la sede y cuenta las urgentes", async () => {
    mocks.listAdminNovelties.mockResolvedValue([
      novelty({ id: 2, title: "Fuga de gas", level: "urgent" }),
      novelty({ id: 1 }),
    ])
    renderWithProviders(<NoveltiesTray storeId={7} />, { me: buildMe() })
    expect(await screen.findByText("Fuga de gas")).toBeInTheDocument()
    expect(mocks.listAdminNovelties).toHaveBeenCalledWith({ storeId: 7, status: "open" })
    expect(screen.getByRole("heading", { name: /Novedades abiertas \(2\)/ })).toHaveTextContent("1 urgente")
  })

  it("sin abiertas lo dice, no deja una bandeja muda", async () => {
    mocks.listAdminNovelties.mockResolvedValue([])
    renderWithProviders(<NoveltiesTray storeId={7} />, { me: buildMe() })
    expect(await screen.findByText(/Sin novedades abiertas/)).toBeInTheDocument()
  })

  it("resuelve por la ruta de admin, con la sede y la nota", async () => {
    mocks.listAdminNovelties.mockResolvedValue([novelty()])
    mocks.resolveNoveltyAsAdmin.mockResolvedValue(novelty({ open: false }))
    const user = userEvent.setup()
    renderWithProviders(<NoveltiesTray storeId={7} />, { me: buildMe() })

    await user.click(await screen.findByRole("button", { name: "Resolver «Se dañó la nevera»" }))
    await user.type(screen.getByLabelText("¿Cómo se resolvió?"), "Se llamó al técnico")
    await user.click(screen.getByRole("button", { name: "Confirmar resuelta" }))
    await waitFor(() => expect(mocks.resolveNoveltyAsAdmin).toHaveBeenCalledTimes(1))
    expect(mocks.resolveNoveltyAsAdmin.mock.calls[0]!.slice(0, 3)).toEqual([7, 1, "Se llamó al técnico"])
  })
})

describe("NoveltiesHistory", () => {
  it("pide todas por defecto y muestra quién la resolvió y cómo", async () => {
    mocks.listAdminNovelties.mockResolvedValue([
      novelty({
        open: false,
        resolved_at: "2026-09-25T10:00:00Z",
        resolved_by_employee_name: "Luis",
        resolution_note: "Cambiaron el relé",
      }),
    ])
    renderWithProviders(<NoveltiesHistory storeId={7} />, { me: buildMe() })
    expect(await screen.findByText(/Cambiaron el relé/)).toBeInTheDocument()
    expect(screen.getByText(/Resuelta por Luis/)).toBeInTheDocument()
    expect(mocks.listAdminNovelties).toHaveBeenCalledWith(expect.objectContaining({ storeId: 7, status: "all" }))
  })
})
