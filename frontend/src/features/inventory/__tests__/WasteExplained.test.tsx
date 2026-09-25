/**
 * Consumo interno y traslado a otra sede en el formulario de merma del POS
 * (rutina del turno). Lo que no se negocia:
 *
 * - el consumo interno no se confirma sin decir quién, y viaja con el
 *   empleado o con el texto;
 * - «Traslado a otra sede» no aparece si la organización tiene una sola sede,
 *   y cuando aparece exige la sede destino y viaja con ella;
 * - «consumo de personal» sigue sin existir como tipo.
 */
import { screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { buildMe, renderWithProviders } from "@/test/utils"

import { WastePage } from "../WastePage"

const mocks = vi.hoisted(() => ({
  listDeviceIngredients: vi.fn(),
  listTransferStores: vi.fn(),
  postWaste: vi.fn(),
  listDevicePreparations: vi.fn(),
  listDeviceEmployees: vi.fn(),
}))

vi.mock("@/api/inventory", async () => {
  const actual = await vi.importActual<typeof import("@/api/inventory")>("@/api/inventory")
  return {
    ...actual,
    listDeviceIngredients: mocks.listDeviceIngredients,
    listTransferStores: mocks.listTransferStores,
    postWaste: mocks.postWaste,
  }
})
vi.mock("@/api/recipes", async () => {
  const actual = await vi.importActual<typeof import("@/api/recipes")>("@/api/recipes")
  return { ...actual, listDevicePreparations: mocks.listDevicePreparations }
})
vi.mock("@/api/employees", async () => {
  const actual = await vi.importActual<typeof import("@/api/employees")>("@/api/employees")
  return { ...actual, listDeviceEmployees: mocks.listDeviceEmployees }
})

const me = buildMe({ kind: "device", features: { "inventory.waste": true } })

async function fillBase(user: ReturnType<typeof userEvent.setup>, typeLabel: string) {
  await user.click(await screen.findByRole("button", { name: "Queso" }))
  await user.type(screen.getByLabelText("Cantidad"), "2")
  await user.click(screen.getByRole("button", { name: typeLabel }))
}

async function typePin(user: ReturnType<typeof userEvent.setup>) {
  for (const d of ["1", "2", "3", "4"]) await user.click(screen.getByRole("button", { name: `Dígito ${d}` }))
}

describe("WastePage — salidas explicadas", () => {
  beforeEach(() => {
    for (const m of Object.values(mocks)) m.mockReset()
    mocks.listDeviceIngredients.mockResolvedValue([
      { id: 1, name: "Queso", base_unit: "g", entry_mode: "weight", entry_unit: "kg" },
    ])
    mocks.listDevicePreparations.mockResolvedValue([])
    mocks.listDeviceEmployees.mockResolvedValue([{ id: 9, name: "Luisa", role: "operator" }])
    mocks.postWaste.mockResolvedValue({ id: 1 })
  })

  it("con una sola sede no ofrece «Traslado a otra sede», y sí «Consumo interno»", async () => {
    mocks.listTransferStores.mockResolvedValue([])
    renderWithProviders(<WastePage />, { me })

    const group = await screen.findByRole("group", { name: "Tipo" })
    expect(within(group).getByRole("button", { name: "Consumo interno" })).toBeInTheDocument()
    const options = within(group)
      .getAllByRole("button")
      .map((o) => o.textContent)
    expect(options).not.toContain("Traslado a otra sede")
    expect(options.some((label) => /personal/i.test(label ?? ""))).toBe(false)
  })

  it("el consumo interno no se confirma sin quién; con texto viaja consumer_name", async () => {
    mocks.listTransferStores.mockResolvedValue([])
    const user = userEvent.setup()
    renderWithProviders(<WastePage />, { me })

    await fillBase(user, "Consumo interno")
    expect(screen.getByRole("button", { name: "Dígito 1" })).toBeDisabled()

    await user.click(screen.getByRole("combobox", { name: "¿Quién?" }))
    await user.click(await screen.findByRole("option", { name: "Otra persona (escribir)" }))
    await user.type(screen.getByLabelText("Nombre o motivo"), "Dueño")
    await typePin(user)

    await waitFor(() => expect(mocks.postWaste).toHaveBeenCalledTimes(1))
    const body = mocks.postWaste.mock.calls[0]![0]
    expect(body).toMatchObject({
      type: "internal_use",
      consumer_name: "Dueño",
      ingredient_id: 1,
      qty: "2",
      entry_unit: "kg",
    })
    expect(body.consumer_employee_id).toBeUndefined()
  })

  it("el consumo interno de una persona del equipo viaja con su id", async () => {
    mocks.listTransferStores.mockResolvedValue([])
    const user = userEvent.setup()
    renderWithProviders(<WastePage />, { me })

    await fillBase(user, "Consumo interno")
    await user.click(screen.getByRole("combobox", { name: "¿Quién?" }))
    await user.click(await screen.findByRole("option", { name: "Luisa" }))
    await typePin(user)

    await waitFor(() => expect(mocks.postWaste).toHaveBeenCalledTimes(1))
    expect(mocks.postWaste.mock.calls[0]![0]).toMatchObject({ type: "internal_use", consumer_employee_id: 9 })
  })

  it("el traslado exige la sede destino y viaja con ella", async () => {
    mocks.listTransferStores.mockResolvedValue([{ id: 4, name: "Sede Norte" }])
    const user = userEvent.setup()
    renderWithProviders(<WastePage />, { me })

    await fillBase(user, "Traslado a otra sede")
    expect(screen.getByRole("button", { name: "Dígito 1" })).toBeDisabled()
    await user.click(screen.getByRole("combobox", { name: "Sede destino" }))
    await user.click(await screen.findByRole("option", { name: "Sede Norte" }))
    await typePin(user)

    await waitFor(() => expect(mocks.postWaste).toHaveBeenCalledTimes(1))
    expect(mocks.postWaste.mock.calls[0]![0]).toMatchObject({ type: "transfer_out", destination_store_id: 4 })
  })
})
