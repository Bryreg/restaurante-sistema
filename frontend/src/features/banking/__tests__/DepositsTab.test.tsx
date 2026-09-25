/**
 * Caja › Banco › Consignaciones con las consignaciones hechas desde el POS
 * (2026-09-24): las que esperan confirmación van primero, marcadas «Por
 * confirmar», con su filtro; el «⋯» de la fila las confirma o las rechaza
 * (rechazar = reversar con motivo obligatorio). Una reversada no tiene
 * acciones.
 */
import { screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"

import type { DepositOut } from "@/api/banking"
import { renderWithProviders } from "@/test/utils"

import { DepositsTab } from "../DepositsTab"

const { getDepositsMock, confirmDepositMock, reverseDepositMock } = vi.hoisted(() => ({
  getDepositsMock: vi.fn(),
  confirmDepositMock: vi.fn(),
  reverseDepositMock: vi.fn(),
}))

vi.mock("@/api/banking", async () => {
  const actual = await vi.importActual<typeof import("@/api/banking")>("@/api/banking")
  return {
    ...actual,
    getDeposits: getDepositsMock,
    confirmDeposit: confirmDepositMock,
    reverseDeposit: reverseDepositMock,
  }
})

const ADMIN_DEPOSIT: DepositOut = {
  id: 1,
  business_date: "2026-09-20",
  amount: 500_000,
  status: "live",
  source: "admin",
  receipt_photo: "/api/v1/photos/1",
  allocations: [{ shift_id: 8, amount: 500_000 }],
  needs_confirmation: false,
}

const POS_DEPOSIT: DepositOut = {
  id: 2,
  business_date: "2026-09-23",
  amount: 150_000,
  status: "live",
  source: "pos",
  from_shift_id: 42,
  receipt_photo: "/api/v1/photos/2",
  allocations: [{ shift_id: 11, amount: 150_000 }],
  needs_confirmation: true,
  confirmed_at: null,
}

const REVERSED: DepositOut = {
  ...ADMIN_DEPOSIT,
  id: 3,
  amount: 70_000,
  status: "reversed",
  reversed_reason: "Duplicada",
}

beforeEach(() => {
  getDepositsMock.mockReset()
  confirmDepositMock.mockReset()
  reverseDepositMock.mockReset()
})

/** Los rótulos también viven en la leyenda plegada: se buscan dentro de la tabla. */
async function inTable(text: string): Promise<HTMLElement> {
  const table = await screen.findByRole("table")
  return within(table).findByText(text)
}

async function openMenu(user: ReturnType<typeof userEvent.setup>, amountText: string): Promise<void> {
  await user.click(screen.getByRole("button", { name: `Acciones de la consignación de ${amountText}` }))
}

describe("DepositsTab — consignaciones desde el POS", () => {
  it("las que esperan confirmación van primero, con «Por confirmar» y «Desde el POS», y un filtro con su recuento", async () => {
    getDepositsMock.mockResolvedValue([ADMIN_DEPOSIT, POS_DEPOSIT])
    const user = userEvent.setup()
    renderWithProviders(<DepositsTab storeId={1} />)

    await inTable("Por confirmar")
    expect(await inTable("Desde el POS")).toBeInTheDocument()

    const table = screen.getByRole("table")
    const rows = within(table).getAllByRole("row").slice(1)
    expect(rows[0]).toHaveTextContent("$ 150.000")
    expect(rows[1]).toHaveTextContent("$ 500.000")

    const filter = screen.getByRole("button", { name: "Por confirmar (1)" })
    await user.click(filter)
    expect(filter).toHaveAttribute("aria-pressed", "true")
    expect(within(screen.getByRole("table")).getAllByRole("row").slice(1)).toHaveLength(1)
  })

  it("«Confirmar» desde el ⋯ llama a POST /admin/deposits/{id}/confirm", async () => {
    getDepositsMock.mockResolvedValue([POS_DEPOSIT])
    confirmDepositMock.mockResolvedValue({ ...POS_DEPOSIT, needs_confirmation: false, confirmed_at: "2026-09-24T15:00:00Z" })
    const user = userEvent.setup()
    renderWithProviders(<DepositsTab storeId={1} />)

    await inTable("Por confirmar")
    await openMenu(user, "$ 150.000")
    await user.click(await screen.findByRole("menuitem", { name: "Confirmar" }))

    await waitFor(() => expect(confirmDepositMock).toHaveBeenCalledWith(2))
  })

  it("«Rechazar» desde el ⋯ pide el motivo (obligatorio) y reversa con él", async () => {
    getDepositsMock.mockResolvedValue([POS_DEPOSIT])
    reverseDepositMock.mockResolvedValue({ ...POS_DEPOSIT, status: "reversed", needs_confirmation: false })
    const user = userEvent.setup()
    renderWithProviders(<DepositsTab storeId={1} />)

    await inTable("Por confirmar")
    await openMenu(user, "$ 150.000")
    await user.click(await screen.findByRole("menuitem", { name: "Rechazar" }))

    const dialog = await screen.findByRole("alertdialog")
    const submit = within(dialog).getByRole("button", { name: "Rechazar" })
    // Sin motivo no se puede rechazar.
    expect(submit).toBeDisabled()
    await user.type(within(dialog).getByLabelText("Motivo"), "El comprobante no se lee")
    await user.click(submit)

    await waitFor(() => expect(reverseDepositMock).toHaveBeenCalledTimes(1))
    const [id, body, key] = reverseDepositMock.mock.calls[0] ?? []
    expect(id).toBe(2)
    expect(body).toEqual({ reason: "El comprobante no se lee" })
    expect(typeof key).toBe("string")
  })

  it("una consignación ya confirmada o cargada desde acá no ofrece «Confirmar», sólo «Reversar»", async () => {
    getDepositsMock.mockResolvedValue([ADMIN_DEPOSIT])
    const user = userEvent.setup()
    renderWithProviders(<DepositsTab storeId={1} />)

    await inTable("$ 500.000")
    await openMenu(user, "$ 500.000")
    expect(await screen.findByRole("menuitem", { name: "Reversar" })).toBeInTheDocument()
    expect(screen.queryByRole("menuitem", { name: "Confirmar" })).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /Por confirmar \(/ })).not.toBeInTheDocument()
  })

  it("una reversada no tiene acciones", async () => {
    getDepositsMock.mockResolvedValue([REVERSED])
    renderWithProviders(<DepositsTab storeId={1} />)

    await inTable("Reversada")
    expect(screen.queryByRole("button", { name: /Acciones de la consignación/ })).not.toBeInTheDocument()
  })
})
