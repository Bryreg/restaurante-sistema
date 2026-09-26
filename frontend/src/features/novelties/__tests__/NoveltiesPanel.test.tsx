/**
 * El panel de novedades del POS. Lo que no se negocia:
 *
 * - con la función apagada no consulta nada y dice qué la prende;
 * - «Novedades sin resolver (n)» pinta lo que manda el servidor, en su orden,
 *   y el número es el del servidor;
 * - registrar manda título, categoría, nivel, seguimiento y foto; una urgente
 *   viaja con seguimiento aunque nadie marque la casilla;
 * - resolver exige una nota y la manda tal cual.
 */
import { screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"

import type { Novelty, NoveltyBoard } from "@/api/novelties"
import { buildMe, renderWithProviders } from "@/test/utils"

import { NoveltiesPanel } from "../NoveltiesPanel"

const mocks = vi.hoisted(() => ({
  getNoveltyBoard: vi.fn(),
  createNovelty: vi.fn(),
  resolveNovelty: vi.fn(),
}))

vi.mock("@/api/novelties", async () => {
  const actual = await vi.importActual<typeof import("@/api/novelties")>("@/api/novelties")
  return { ...actual, ...mocks }
})

function novelty(overrides: Partial<Novelty> = {}): Novelty {
  return {
    id: 1,
    store_id: 1,
    shift_id: 3,
    business_date: "2026-09-24",
    title: "Se dañó la nevera",
    detail: null,
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

function me(on = true) {
  return buildMe({ kind: "device", features: { "pos.novelties": on } })
}

describe("NoveltiesPanel", () => {
  beforeEach(() => {
    for (const m of Object.values(mocks)) m.mockReset()
  })

  it("con pos.novelties apagada no consulta y dice qué la prende", () => {
    renderWithProviders(<NoveltiesPanel />, { me: me(false) })
    expect(screen.getByText(/no están habilitadas/i)).toBeInTheDocument()
    expect(mocks.getNoveltyBoard).not.toHaveBeenCalled()
  })

  it("muestra las sin resolver de turnos anteriores con el número del servidor", async () => {
    const board: NoveltyBoard = {
      open: [
        novelty({ id: 2, title: "Fuga de gas", level: "urgent", category: "security" }),
        novelty({ id: 1, title: "Se dañó la nevera" }),
      ],
      this_shift: [novelty({ id: 5, title: "Llegó el pedido", level: "info", requires_follow_up: false, open: false })],
      open_count: 2,
    }
    mocks.getNoveltyBoard.mockResolvedValue(board)
    renderWithProviders(<NoveltiesPanel />, { me: me() })

    expect(await screen.findByRole("heading", { name: "Novedades sin resolver (2)" })).toBeInTheDocument()
    const abiertas = screen.getByRole("heading", { name: /sin resolver/ }).parentElement as HTMLElement
    const titulos = within(abiertas).getAllByText(/Fuga de gas|Se dañó la nevera/).map((e) => e.textContent)
    expect(titulos).toEqual(["Fuga de gas", "Se dañó la nevera"])
    expect(screen.getByText("Llegó el pedido")).toBeInTheDocument()
  })

  it("registrar una urgente la manda con seguimiento aunque la casilla no se toque", async () => {
    mocks.getNoveltyBoard.mockResolvedValue({ open: [], this_shift: [], open_count: 0 })
    mocks.createNovelty.mockResolvedValue(novelty())
    const user = userEvent.setup()
    renderWithProviders(<NoveltiesPanel />, { me: me() })

    await user.type(await screen.findByLabelText("¿Qué pasó?"), "  Se fue la luz  ")
    // Categoría y nivel son botones de un toque; «Urgente» es un botón aparte, en rojo.
    await user.click(screen.getByRole("radio", { name: "Incidente" }))
    expect(screen.getByRole("radio", { name: "Incidente" })).toHaveAttribute("aria-checked", "true")
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument()
    await user.click(screen.getByRole("radio", { name: "Urgente" }))
    await user.click(screen.getByRole("button", { name: "Registrar novedad" }))

    await waitFor(() => expect(mocks.createNovelty).toHaveBeenCalledTimes(1))
    const [body, key] = mocks.createNovelty.mock.calls[0]!
    expect(body).toMatchObject({ title: "Se fue la luz", category: "incident", level: "urgent", requires_follow_up: true })
    expect(typeof key).toBe("string")
  })

  it("no deja registrar sin qué pasó ni categoría", async () => {
    mocks.getNoveltyBoard.mockResolvedValue({ open: [], this_shift: [], open_count: 0 })
    renderWithProviders(<NoveltiesPanel />, { me: me() })
    expect(await screen.findByRole("button", { name: "Registrar novedad" })).toBeDisabled()
  })

  it("resolver pide la nota y la manda", async () => {
    mocks.getNoveltyBoard.mockResolvedValue({ open: [novelty()], this_shift: [], open_count: 1 })
    mocks.resolveNovelty.mockResolvedValue(novelty({ open: false, resolved_at: "2026-09-25T10:00:00Z" }))
    const user = userEvent.setup()
    renderWithProviders(<NoveltiesPanel />, { me: me() })

    await user.click(await screen.findByRole("button", { name: "Resolver «Se dañó la nevera»" }))
    const confirmar = screen.getByRole("button", { name: "Confirmar resuelta" })
    expect(confirmar).toBeDisabled()
    await user.type(screen.getByLabelText("¿Cómo se resolvió?"), "Vino el técnico")
    await user.click(confirmar)

    await waitFor(() => expect(mocks.resolveNovelty).toHaveBeenCalledTimes(1))
    expect(mocks.resolveNovelty.mock.calls[0]!.slice(0, 2)).toEqual([1, "Vino el técnico"])
  })
})
