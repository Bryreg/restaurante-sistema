import { screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { ApiError } from "@/api/client"
import type { PayableOut } from "@/api/purchases"
import { formatCOP } from "@/lib/money"
import { renderWithProviders } from "@/test/utils"

import { PayableDetailDialog } from "../PayableDetailDialog"

const { approvePayableMock, createPaymentMock, voidPaymentMock, listPayablePaymentsMock } = vi.hoisted(() => ({
  approvePayableMock: vi.fn(),
  createPaymentMock: vi.fn(),
  voidPaymentMock: vi.fn(),
  listPayablePaymentsMock: vi.fn().mockResolvedValue([]),
}))

vi.mock("@/api/purchases", async () => {
  const actual = await vi.importActual<typeof import("@/api/purchases")>("@/api/purchases")
  return {
    ...actual,
    approvePayable: approvePayableMock,
    createPayment: createPaymentMock,
    voidPayment: voidPaymentMock,
    listPayablePayments: listPayablePaymentsMock,
  }
})

const PENDING: PayableOut = {
  id: 7,
  store_id: 1,
  supplier_id: 3,
  reception_id: 42,
  amount: 120000,
  balance: 120000,
  status: "pending_review",
  due_date: "2026-10-01",
  overdue: false,
  approved_at: null,
  approved_by_employee_name: null,
  business_date: "2026-09-16",
}

const APPROVED: PayableOut = { ...PENDING, status: "approved", approved_at: "2026-09-16T11:00:00Z", approved_by_employee_name: "Admin" }

// El historial es una lectura compartida por todos los tests de este
// archivo: sin reponerla, el `mockResolvedValue` de uno se filtra al
// siguiente y el orden de ejecución decide el resultado.
beforeEach(() => {
  listPayablePaymentsMock.mockReset().mockResolvedValue([])
})

async function openDialog(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Ver" }))
  await screen.findByRole("dialog")
}

describe("PayableDetailDialog — el botón de pagar NO EXISTE mientras está pendiente de revisión", () => {
  it("pending_review: no hay ningún formulario de pago, sólo la aprobación", async () => {
    const user = userEvent.setup()
    renderWithProviders(<PayableDetailDialog payable={PENDING} supplierLabel="Avícola del Valle" />)

    await openDialog(user)

    expect(screen.getByText(/control mínimo entre quien recibió/)).toBeInTheDocument()
    expect(screen.queryByLabelText("Monto")).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /registrar pago/i })).not.toBeInTheDocument()
  })

  it("aprobar con PIN llama a approvePayable con ese id", async () => {
    approvePayableMock.mockResolvedValue({ ...PENDING, status: "approved" })
    const user = userEvent.setup()
    renderWithProviders(<PayableDetailDialog payable={PENDING} supplierLabel="Avícola del Valle" />)

    await openDialog(user)
    for (const digit of "1234") {
      await user.click(screen.getByRole("button", { name: `Dígito ${digit}` }))
    }

    await waitFor(() => expect(approvePayableMock).toHaveBeenCalledWith(7, { authorizer_pin: "1234" }))
  })

  it("approved con saldo: el formulario de pago existe y muestra el saldo del servidor, nunca uno propio", async () => {
    const user = userEvent.setup()
    renderWithProviders(<PayableDetailDialog payable={APPROVED} supplierLabel="Avícola del Valle" />)

    await openDialog(user)
    expect(screen.getByText(`Saldo pendiente: ${formatCOP(120000)}`)).toBeInTheDocument()
    expect(screen.getByLabelText("Monto")).toBeInTheDocument()
  })

  it('"409 NO_OPEN_SHIFT" dice que hay que abrir turno, no "error inesperado"', async () => {
    createPaymentMock.mockRejectedValueOnce(
      new ApiError(409, "NO_OPEN_SHIFT", "No hay un turno abierto en esta sede; abrí un turno para pagar en efectivo desde el cajón, o registrá el pago por otro medio"),
    )
    const user = userEvent.setup()
    renderWithProviders(<PayableDetailDialog payable={APPROVED} supplierLabel="Avícola del Valle" />)

    await openDialog(user)
    await user.type(screen.getByLabelText("Monto"), "50000")
    // El `Switch` de base-ui también trae un input nativo oculto
    // (`aria-hidden="true"`); `getByRole` ya lo excluye, a diferencia de
    // `getByLabelText`.
    await user.click(screen.getByRole("switch", { name: "Desde el cajón" }))
    for (const digit of "1234") {
      await user.click(screen.getByRole("button", { name: `Dígito ${digit}` }))
    }

    expect(await screen.findByText(/no hay un turno abierto en esta sede/i)).toBeInTheDocument()
  })

  it("cancelled: explica que la recepción se revirtió, sin ofrecer aprobar ni pagar", async () => {
    const user = userEvent.setup()
    renderWithProviders(<PayableDetailDialog payable={{ ...PENDING, status: "cancelled" }} supplierLabel="Avícola del Valle" />)

    await openDialog(user)
    expect(screen.getByText(/la recepción que la originó se revirtió/)).toBeInTheDocument()
    expect(screen.queryByLabelText("Monto")).not.toBeInTheDocument()
  })
})

describe("PayableDetailDialog — anular un pago desde el cajón sin turno abierto (H-1 de backend-compras, ronda 2)", () => {
  it('409 NO_OPEN_SHIFT en la anulación se muestra tal cual, y el pago sigue vigente (no queda pintado como anulado)', async () => {
    const PAGO = {
      id: 501,
      payable_id: APPROVED.id,
      amount: 50000,
      method: "cash" as const,
      paid_at: "2026-09-16T20:00",
      reference: null,
      from_cash_drawer: true,
      cash_movement_id: 999,
      employee_name: "Admin",
      authorized_by_employee_name: "Admin",
      created_at: "2026-09-16T20:00:00Z",
      voided_at: null,
      voided_reason: null,
      voided_by_employee_name: null,
    }
    createPaymentMock.mockResolvedValueOnce(PAGO)
    // La pantalla ya NO guarda el pago en memoria: lo vuelve a leer del
    // servidor después de registrarlo. Primera lectura vacía, la de después
    // del pago ya lo trae.
    listPayablePaymentsMock.mockResolvedValueOnce([]).mockResolvedValue([PAGO])
    voidPaymentMock.mockRejectedValueOnce(
      new ApiError(
        409,
        "NO_OPEN_SHIFT",
        "No hay un turno abierto en esta sede; abrí un turno para anular un pago hecho desde el cajón",
      ),
    )

    const user = userEvent.setup()
    renderWithProviders(<PayableDetailDialog payable={APPROVED} supplierLabel="Avícola del Valle" />)
    await openDialog(user)

    // Registra un pago "desde el cajón" para tener algo que anular.
    await user.type(screen.getByLabelText("Monto"), "50000")
    await user.click(screen.getByRole("switch", { name: "Desde el cajón" }))
    for (const digit of "1234") {
      await user.click(screen.getByRole("button", { name: `Dígito ${digit}` }))
    }
    await screen.findByRole("button", { name: "Anular" })

    await user.click(screen.getByRole("button", { name: "Anular" }))
    await user.type(await screen.findByLabelText("Motivo"), "Pago registrado por error")
    await user.type(screen.getByLabelText("PIN de administrador"), "9999")
    await user.click(screen.getByRole("button", { name: "Anular pago" }))

    // El mensaje del servidor tal cual — nunca "error inesperado" ni un
    // texto inventado por esta pantalla.
    expect(await screen.findByText(/no hay un turno abierto en esta sede/i)).toBeInTheDocument()

    // La anulación NO ocurrió: el pago sigue mostrándose como vigente. No
    // hay ningún camino que lo dé por anulado sin que el backend lo haya
    // confirmado.
    expect(screen.queryByText("Anulado")).not.toBeInTheDocument()
    expect(screen.getByText("Vigente")).toBeInTheDocument()
    expect(screen.getByText(formatCOP(50000))).toBeInTheDocument()
  })
})

describe("PayableDetailDialog — el historial de pagos viene del servidor, no de la memoria de la sesión", () => {
  it("muestra los pagos de sesiones anteriores, que es lo que hacía inusable la anulación al día siguiente", async () => {
    listPayablePaymentsMock.mockResolvedValue([
      {
        id: 300,
        payable_id: APPROVED.id,
        amount: 40000,
        method: "transfer" as const,
        paid_at: "2026-09-10T15:00:00Z",
        reference: "TRF-88",
        from_cash_drawer: false,
        cash_movement_id: null,
        employee_name: "Admin",
        authorized_by_employee_name: "Admin",
        created_at: "2026-09-10T15:00:00Z",
        voided_at: null,
        voided_reason: null,
        voided_by_employee_name: null,
      },
    ])

    const user = userEvent.setup()
    renderWithProviders(<PayableDetailDialog payable={APPROVED} supplierLabel="Avícola del Valle" />)
    await openDialog(user)

    // Un pago de hace seis días, que esta pantalla nunca registró.
    expect(await screen.findByText(formatCOP(40000))).toBeInTheDocument()
    expect(listPayablePaymentsMock).toHaveBeenCalledWith(APPROVED.id)
    // Y con el pago a la vista, se lo puede anular: el `payment_id` ya no
    // vive solamente en la respuesta del POST que lo creó.
    expect(screen.getByRole("button", { name: "Anular" })).toBeInTheDocument()
  })

  it("un pago anulado NO desaparece del historial: queda marcado, con motivo y con quién lo anuló", async () => {
    listPayablePaymentsMock.mockResolvedValue([
      {
        id: 301,
        payable_id: APPROVED.id,
        amount: 25000,
        method: "cash" as const,
        paid_at: "2026-09-11T15:00:00Z",
        reference: null,
        from_cash_drawer: true,
        cash_movement_id: 77,
        employee_name: "Admin",
        authorized_by_employee_name: "Admin",
        created_at: "2026-09-11T15:00:00Z",
        voided_at: "2026-09-12T09:00:00Z",
        voided_reason: "Duplicado",
        voided_by_employee_name: "Supervisora",
      },
    ])

    const user = userEvent.setup()
    renderWithProviders(<PayableDetailDialog payable={APPROVED} supplierLabel="Avícola del Valle" />)
    await openDialog(user)

    // Nada financiero se borra (regla dura): el pago anulado sigue ahí.
    expect(await screen.findByText(formatCOP(25000))).toBeInTheDocument()
    expect(screen.getByText("Anulado")).toBeInTheDocument()
    // Anular un pago a proveedor devuelve plata al cajón, y eso tiene
    // responsable: el historial tiene que decir quién.
    expect(screen.getByText(/Duplicado.*Supervisora/)).toBeInTheDocument()
    // Y no se ofrece anularlo dos veces.
    expect(screen.queryByRole("button", { name: "Anular" })).not.toBeInTheDocument()
  })

  it("si el historial no carga lo dice, en vez de dibujar una tabla vacía que parece «no hay pagos»", async () => {
    listPayablePaymentsMock.mockRejectedValue(new ApiError(500, "INTERNAL", "boom"))

    const user = userEvent.setup()
    renderWithProviders(<PayableDetailDialog payable={APPROVED} supplierLabel="Avícola del Valle" />)
    await openDialog(user)

    expect(await screen.findByRole("alert")).toHaveTextContent(/no se pudieron cargar los pagos/i)
    expect(screen.queryByText(/todavía no se registró ningún pago/i)).not.toBeInTheDocument()
  })
})
