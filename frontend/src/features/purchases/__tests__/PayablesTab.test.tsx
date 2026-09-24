import { screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"

import type { PayableOut, PayablesSummaryOut, SupplierOut } from "@/api/purchases"
import { renderWithProviders } from "@/test/utils"

import { PayablesTab } from "../PayablesTab"

const { listPayablesMock, getPayablesSummaryMock } = vi.hoisted(() => ({
  listPayablesMock: vi.fn(),
  getPayablesSummaryMock: vi.fn(),
}))

vi.mock("@/api/purchases", async () => {
  const actual = await vi.importActual<typeof import("@/api/purchases")>("@/api/purchases")
  return { ...actual, listPayables: listPayablesMock, getPayablesSummary: getPayablesSummaryMock }
})

/** La respuesta real de la simulación al 23 sep. */
const SUMMARY: PayablesSummaryOut = {
  store_id: 1,
  as_of: "2026-09-23",
  total_open: 2_855_739,
  total_overdue: 1_500_506,
  due_next_7_days: 464_469,
  open_count: 24,
  overdue_count: 5,
  aging: [
    { bucket: "current", amount: 1_355_233, count: 19 },
    { bucket: "1_30", amount: 1_500_506, count: 5 },
    { bucket: "31_60", amount: 0, count: 0 },
    { bucket: "over_60", amount: 0, count: 0 },
  ],
  by_supplier: [
    { supplier_id: 7, name: "Pescadería Pacífico Azul", open: 798_964, overdue: 394_247 },
    { supplier_id: 3, name: "Avícola del Valle", open: 576_782, overdue: 576_782 },
  ],
}

beforeEach(() => {
  getPayablesSummaryMock.mockResolvedValue(SUMMARY)
})

const AVICOLA: SupplierOut = {
  id: 3,
  store_id: 1,
  name: "Avícola del Valle",
  nit: null,
  payment_term_days: 15,
  contact_name: null,
  contact_phone: null,
  invoices_required: true,
  active: true,
}

const PAYABLE: PayableOut = {
  id: 7,
  store_id: 1,
  supplier_id: 3,
  reception_id: 42,
  amount: 120000,
  balance: 80000,
  status: "approved",
  due_date: "2026-08-01",
  overdue: true,
  approved_at: "2026-09-10T10:00:00Z",
  approved_by_employee_name: "Admin",
  business_date: "2026-09-10",
}

describe("PayablesTab — el saldo mostrado es EXACTAMENTE el que manda el servidor", () => {
  it("lista con proveedor resuelto, saldo del servidor, vencida marcada, y exporta CSV", async () => {
    listPayablesMock.mockResolvedValue([PAYABLE])
    renderWithProviders(<PayablesTab storeId={1} suppliers={[AVICOLA]} />)

    await waitFor(() => expect(listPayablesMock).toHaveBeenCalled())
    expect(await screen.findByText("Avícola del Valle")).toBeInTheDocument()
    // Igual que arriba: «Vencida» es el badge de la fila y además un
    // término de la leyenda del pie.
    expect(within(screen.getByRole("table")).getByText("Vencida")).toBeInTheDocument()

    const csvLink = screen.getByRole("link", { name: /exportar csv/i })
    expect(csvLink.getAttribute("href")).toContain("format=csv")
    expect(csvLink.getAttribute("href")).toContain("/api/v1/admin/payables")
  })

  it("sin cuentas por pagar en el rango, dice que una recepción confirmada crea una automáticamente", async () => {
    listPayablesMock.mockResolvedValue([])
    renderWithProviders(<PayablesTab storeId={1} suppliers={[AVICOLA]} />)

    expect(await screen.findByText(/una recepción confirmada crea una automáticamente/i)).toBeInTheDocument()
  })
})

describe("PayablesTab — cuánto se debe, arriba y con cifras del servidor (informe #8)", () => {
  it("«Debés $X» es la cifra protagonista, con lo vencido y lo que vence en 7 días al lado, todo del resumen", async () => {
    listPayablesMock.mockResolvedValue([PAYABLE])
    renderWithProviders(<PayablesTab storeId={1} suppliers={[AVICOLA]} />)

    // Regla 1 del mapa de pantallas: una sola cifra grande, la del servidor.
    const protagonista = await screen.findByTestId("payables-headline")
    expect(protagonista).toHaveTextContent("Debés en total")
    expect(within(protagonista).getByText("$ 2.855.739")).toHaveClass("text-4xl", "tabular-nums")
    expect(screen.getByText("Vencido").closest("div")?.parentElement).toHaveTextContent("$ 1.500.506")
    expect(screen.getByText("Vence en 7 días").closest("div")?.parentElement).toHaveTextContent("$ 464.469")
    expect(getPayablesSummaryMock).toHaveBeenCalledWith(1)
    // La antigüedad: el tramo más viejo con plata vencida es el que se nombra.
    expect(screen.getByText(/5 cuentas vencidas; la más vieja cae en «1 a 30 días vencida»/)).toBeInTheDocument()
    // Por proveedor, el primero es al que más se le debe.
    expect(screen.getByText("A Pescadería Pacífico Azul es a quien más se le debe: $ 798.964")).toBeInTheDocument()
  })

  it("la antigüedad tiene su tabla gemela con los cuatro tramos, aunque estén en cero", async () => {
    listPayablesMock.mockResolvedValue([])
    const user = userEvent.setup()
    renderWithProviders(<PayablesTab storeId={1} suppliers={[AVICOLA]} />)

    await screen.findByTestId("payables-headline")
    await user.click(screen.getAllByRole("button", { name: "Ver tabla" })[0])
    const tabla = screen.getByRole("table", { name: /la más vieja/ })
    expect(within(tabla).getByText("Al día").closest("tr")).toHaveTextContent("$ 1.355.233")
    expect(within(tabla).getByText("Más de 60 días vencida").closest("tr")).toHaveTextContent("$ 0")
  })

  it("por defecto las vencidas van primero, aunque el servidor las mande después", async () => {
    listPayablesMock.mockResolvedValue([
      { ...PAYABLE, id: 1, overdue: false, due_date: "2026-09-25" },
      { ...PAYABLE, id: 2, overdue: true, due_date: "2026-09-10" },
      { ...PAYABLE, id: 3, overdue: false, due_date: "2026-09-24" },
      { ...PAYABLE, id: 4, overdue: false, balance: 0, due_date: "2026-09-12" },
    ])
    renderWithProviders(<PayablesTab storeId={1} suppliers={[AVICOLA]} />)

    await screen.findByText("#2")
    const ids = screen.getAllByText(/^#\d+$/).map((el) => el.textContent)
    // Vencida, después con saldo por vencimiento, y la ya pagada al final.
    expect(ids).toEqual(["#2", "#3", "#1", "#4"])
  })

  it("«Sólo vencidas» llega puesto desde la URL (`?vencidas=1`), que es a donde lleva la tarjeta Vencido", async () => {
    listPayablesMock.mockResolvedValue([PAYABLE])
    renderWithProviders(<PayablesTab storeId={1} suppliers={[AVICOLA]} />, {
      route: "/admin/compras?tab=cuentas-por-pagar&vencidas=1",
    })

    await waitFor(() => expect(listPayablesMock).toHaveBeenCalledWith(expect.objectContaining({ overdue: true })))
    expect(screen.getByRole("checkbox", { name: "Sólo vencidas" })).toBeChecked()
  })
})
