import { screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"

import type { StorePanelOut } from "@/api/panel"
import { buildMe, renderWithProviders } from "@/test/utils"

import { TodayPage } from "../TodayPage"

/**
 * «Requiere tu atención» con las acciones en el mismo lugar (handoff,
 * `AdminHoy` variante A): cada acción es optimista, deja el rastro «✓ …
 * por ti · hora» con «Reversar con motivo», y vuelve atrás si el servidor
 * la rechaza.
 */

const m = vi.hoisted(() => ({
  getToday: vi.fn(),
  getPanel: vi.fn(),
  getDeposits: vi.fn(),
  confirmDeposit: vi.fn(),
  unconfirmDeposit: vi.fn(),
  reverseDeposit: vi.fn(),
  listAdminRequests: vi.fn(),
  approveRequest: vi.fn(),
  rejectRequest: vi.fn(),
  reopenRequest: vi.fn(),
  listAdminNovelties: vi.fn(),
  resolveNoveltyAsAdmin: vi.fn(),
  reopenNoveltyAsAdmin: vi.fn(),
  fixAttendanceExit: vi.fn(),
  toastError: vi.fn(),
}))

vi.mock("@/app/storeContext", () => ({
  useStoreSelection: () => ({ stores: [{ id: 1, name: "Chapinero" }], loading: false, activeStoreId: 1, setActiveStoreId: vi.fn() }),
}))
vi.mock("@/api/reports", async () => {
  const actual = await vi.importActual<typeof import("@/api/reports")>("@/api/reports")
  return { ...actual, getToday: m.getToday }
})
vi.mock("@/api/panel", async () => {
  const actual = await vi.importActual<typeof import("@/api/panel")>("@/api/panel")
  return { ...actual, getPanel: m.getPanel }
})
vi.mock("@/api/banking", async () => {
  const actual = await vi.importActual<typeof import("@/api/banking")>("@/api/banking")
  return {
    ...actual,
    getDeposits: m.getDeposits,
    confirmDeposit: m.confirmDeposit,
    unconfirmDeposit: m.unconfirmDeposit,
    reverseDeposit: m.reverseDeposit,
  }
})
vi.mock("@/api/requests", async () => {
  const actual = await vi.importActual<typeof import("@/api/requests")>("@/api/requests")
  return {
    ...actual,
    listAdminRequests: m.listAdminRequests,
    approveRequest: m.approveRequest,
    rejectRequest: m.rejectRequest,
    reopenRequest: m.reopenRequest,
  }
})
vi.mock("@/api/novelties", async () => {
  const actual = await vi.importActual<typeof import("@/api/novelties")>("@/api/novelties")
  return {
    ...actual,
    listAdminNovelties: m.listAdminNovelties,
    resolveNoveltyAsAdmin: m.resolveNoveltyAsAdmin,
    reopenNoveltyAsAdmin: m.reopenNoveltyAsAdmin,
  }
})
vi.mock("@/api/attendance", async () => {
  const actual = await vi.importActual<typeof import("@/api/attendance")>("@/api/attendance")
  return { ...actual, fixAttendanceExit: m.fixAttendanceExit }
})
vi.mock("sonner", async () => {
  const actual = await vi.importActual<typeof import("sonner")>("sonner")
  return { ...actual, toast: Object.assign(vi.fn(), { error: m.toastError, success: vi.fn() }) }
})

function today(overrides: Record<string, unknown> = {}) {
  return {
    store_id: 1,
    business_date: "2026-09-27",
    sales_by_hour: [],
    gross: 0,
    net: 0,
    tax: 0,
    tips_total: 0,
    tips_by_method: [],
    orders: 0,
    covers: null,
    avg_ticket: null,
    avg_per_cover: null,
    tables_occupied: 0,
    tables_total: 0,
    open_orders: [],
    unsent_count: 0,
    unpaid_count: 0,
    expected_cash: 200_000,
    unavailable_products: [],
    pending_refunds_count: 0,
    unreviewed_closes_count: 0,
    alerts: [],
    ingredients_below_min: [],
    ingredients_negative: [],
    preps_without_production: [],
    products_discounting_nothing: [],
    ...overrides,
  }
}

function panel(overrides: Partial<StorePanelOut> = {}): StorePanelOut {
  return {
    store_id: 1,
    store_name: "Chapinero",
    business_date: "2026-09-27",
    light: "amber",
    reasons: [{ key: "deposits_to_confirm", level: "warning", text: "1 consignación por confirmar." }],
    closed: false,
    cash: null,
    staff: { present: [], pending_review: [], reason: null },
    area_counts: { enabled: false, areas_total: 0, opening_done: 0, opening_missing: 0, closing_done: 0, flagged: 0, pending_recounts: 0 },
    salon: { tables_occupied: 0, tables_total: 0, open_orders: 0, unsent: 0, unpaid: 0 },
    kitchen: { enabled: false, in_kitchen: 0, late: 0, very_late: 0, oldest_late_minutes: null },
    pending: {
      deposits_to_confirm: 1,
      requests_pending: 0,
      novelties_open: 0,
      novelties_urgent: 0,
      unreviewed_closes: 0,
      reserve_loans_open: 0,
      reserve_loans_total: null,
      attendance_review: 0,
    },
    ...overrides,
  }
}

const DEPOSITO = {
  id: 41,
  store_id: 1,
  business_date: "2026-09-26",
  deposited_at: "2026-09-27T16:05:00Z",
  amount: 1_240_000,
  bank_name: "Bancolombia",
  receipt_photo: "/api/v1/photos/9",
  employee_name: "Kevin Ruiz",
  status: "live",
  source: "pos",
  from_shift_id: 12,
  needs_confirmation: true,
}

function riel(): HTMLElement {
  return screen.getByRole("complementary", { name: "Requiere tu atención" })
}

beforeEach(() => {
  for (const f of Object.values(m)) f.mockReset()
  m.getPanel.mockResolvedValue({ scope: "store", generated_at: "2026-09-27T17:53:00Z", stores: [panel()] })
})

describe("Requiere tu atención — acciones en el lugar", () => {
  it("confirmar una consignación la deja confirmada con el rastro, y se reversa con motivo", async () => {
    m.getToday.mockResolvedValue(today({ deposits_to_confirm_count: 1 }))
    m.getDeposits.mockResolvedValue([DEPOSITO])
    m.confirmDeposit.mockResolvedValue({ ...DEPOSITO, needs_confirmation: false, confirmed_at: "2026-09-27T17:55:00Z" })
    m.unconfirmDeposit.mockResolvedValue({ ...DEPOSITO })
    const user = userEvent.setup()
    renderWithProviders(<TodayPage />, { me: buildMe() })

    const titulo = await within(await screen.findByRole("complementary", { name: "Requiere tu atención" })).findByText(
      "Consignación del sáb 26 sep por confirmar",
    )
    const aviso = titulo.closest("li") as HTMLElement
    // El agregado «1 consignación por confirmar» quedó reemplazado por el aviso con la foto.
    expect(within(riel()).queryByText("1 consignación por confirmar")).not.toBeInTheDocument()
    expect(within(aviso).getByText("$ 1.240.000")).toBeInTheDocument()
    const foto = within(aviso).getByRole("button", { name: /Ampliar la foto del comprobante/ })
    expect(within(foto).getByRole("img")).toHaveAttribute("src", "/api/v1/photos/9")
    await user.click(foto)
    expect(within(aviso).getByRole("button", { name: /Achicar/ })).toHaveAttribute("aria-expanded", "true")

    await user.click(within(aviso).getByRole("button", { name: "Confirmar consignación" }))
    expect(m.confirmDeposit).toHaveBeenCalledWith(41)
    // La hora es la que anotó el servidor (12:55 p. m. en Bogotá).
    expect(await within(aviso).findByText("✓ Confirmada por ti · 12:55 p. m.")).toBeInTheDocument()

    await user.click(within(aviso).getByRole("button", { name: "Reversar con motivo" }))
    await user.type(within(aviso).getByLabelText(/Motivo de la reversa/), "Confirmé la equivocada")
    await user.click(within(aviso).getByRole("button", { name: "Reversar" }))
    await waitFor(() =>
      expect(m.unconfirmDeposit).toHaveBeenCalledWith(41, { reason: "Confirmé la equivocada" }, expect.any(String)),
    )
    // Reabierta: vuelven los botones.
    expect(await within(riel()).findByRole("button", { name: "Confirmar consignación" })).toBeInTheDocument()
  })

  it("«No coincide» pide el motivo, rechaza con la reversa y deja el rastro sin reversa", async () => {
    m.getToday.mockResolvedValue(today({ deposits_to_confirm_count: 1 }))
    m.getDeposits.mockResolvedValue([DEPOSITO])
    m.reverseDeposit.mockResolvedValue({ ...DEPOSITO, status: "reversed", reversed_at: "2026-09-27T18:00:00Z" })
    const user = userEvent.setup()
    renderWithProviders(<TodayPage />, { me: buildMe() })

    const aviso = (await screen.findByText("Consignación del sáb 26 sep por confirmar")).closest("li") as HTMLElement
    await user.click(within(aviso).getByRole("button", { name: "No coincide" }))
    const motivo = within(aviso).getByLabelText(/Qué no coincide/)
    // Sin motivo no se manda.
    expect(within(aviso).getByRole("button", { name: "Rechazar la consignación" })).toBeDisabled()
    await user.type(motivo, "El banco dice $ 1.200.000")
    await user.click(within(aviso).getByRole("button", { name: "Rechazar la consignación" }))
    expect(m.reverseDeposit).toHaveBeenCalledWith(41, { reason: "El banco dice $ 1.200.000" }, expect.any(String))
    expect(await within(aviso).findByText(/Rechazada: la plata vuelve a figurar por consignar · 1:00 p\. m\./)).toBeInTheDocument()
    expect(within(aviso).queryByRole("button", { name: "Reversar con motivo" })).not.toBeInTheDocument()
    expect(within(aviso).getByText(/no se reabre/)).toBeInTheDocument()
  })

  it("aprobar un sencillo es optimista y vuelve atrás si el servidor lo rechaza", async () => {
    m.getToday.mockResolvedValue(today({ requests_pending_count: 1 }))
    m.listAdminRequests.mockResolvedValue([
      {
        id: 7,
        kind: "change",
        status: "pending",
        shift_id: 12,
        business_date: "2026-09-27",
        requested_by: { id: 3, name: "Kevin Ruiz" },
        requested_at: "2026-09-27T17:31:00Z",
        note: null,
        reason: "Se acabaron los de $ 10.000",
        lines: [],
        requested_denominations: [{ value: 10_000, count: 20 }],
        requested_total: 200_000,
        approved_denominations: null,
        approved_total: null,
        resolved_by: null,
        resolved_at: null,
        resolution_note: null,
        closed_by: null,
        closed_at: null,
        cash_swap_id: null,
      },
    ])
    let rechazar: (e: Error) => void = () => {}
    m.approveRequest.mockReturnValue(new Promise((_ok, no) => (rechazar = no)))
    const user = userEvent.setup()
    renderWithProviders(<TodayPage />, { me: buildMe() })

    const aviso = (await screen.findByText("Kevin Ruiz pide sencillo")).closest("li") as HTMLElement
    expect(within(aviso).getByText("$ 200.000")).toBeInTheDocument()
    expect(within(aviso).getByText(/20 de \$ 10\.000 · pedido a las 12:31 p\. m\./)).toBeInTheDocument()
    await user.click(within(aviso).getByRole("button", { name: "Aprobar" }))
    // Optimista: el rastro aparece antes de que conteste el servidor.
    expect(within(aviso).getByRole("status")).toHaveTextContent(/Aprobada · Kevin Ruiz la ve en la tablet/)
    rechazar(new Error("Esta solicitud ya se resolvió; recargá la bandeja"))
    // Rollback: los botones vuelven y el mensaje del servidor se dice.
    expect(await within(riel()).findByRole("button", { name: "Aprobar" })).toBeInTheDocument()
    expect(m.toastError).toHaveBeenCalledWith("Esta solicitud ya se resolvió; recargá la bandeja")
  })

  it("revisar una novedad pide cómo se resolvió, y su reversa la reabre con motivo", async () => {
    m.getToday.mockResolvedValue(today({ novelties_open_count: 1 }))
    m.listAdminNovelties.mockResolvedValue([
      {
        id: 5,
        store_id: 1,
        shift_id: 12,
        business_date: "2026-09-27",
        title: "faltan $ 2.000 en el sobre del jue 25 sep",
        detail: "Esperado $ 980.000 · contado $ 978.000.",
        category: "incident",
        level: "important",
        requires_follow_up: true,
        photo: null,
        employee_id: 3,
        employee_name: "Kevin Ruiz",
        created_at: "2026-09-27T12:05:00Z",
        open: true,
        resolved_at: null,
        resolved_by_employee_name: null,
        resolution_note: null,
      },
    ])
    m.resolveNoveltyAsAdmin.mockResolvedValue({ id: 5, resolved_at: "2026-09-27T18:10:00Z" })
    m.reopenNoveltyAsAdmin.mockResolvedValue({ id: 5, resolved_at: null })
    const user = userEvent.setup()
    renderWithProviders(<TodayPage />, { me: buildMe() })

    const aviso = (await screen.findByText("Novedad: faltan $ 2.000 en el sobre del jue 25 sep")).closest("li") as HTMLElement
    expect(within(aviso).getByRole("link", { name: "Ficha de Kevin" })).toHaveAttribute("href", "/admin/personal/persona/3")
    await user.click(within(aviso).getByRole("button", { name: "Revisar novedad" }))
    await user.type(within(aviso).getByLabelText(/Cómo se resolvió/), "Se descontó del sobre")
    await user.click(within(aviso).getByRole("button", { name: "Marcar revisada" }))
    expect(m.resolveNoveltyAsAdmin).toHaveBeenCalledWith(1, 5, "Se descontó del sobre", expect.any(String))
    expect(await within(aviso).findByText(/Revisada · queda en la ficha de Kevin · 1:10 p\. m\./)).toBeInTheDocument()

    await user.click(within(aviso).getByRole("button", { name: "Reversar con motivo" }))
    await user.type(within(aviso).getByLabelText(/Motivo de la reversa/), "No era eso")
    await user.click(within(aviso).getByRole("button", { name: "Reversar" }))
    await waitFor(() => expect(m.reopenNoveltyAsAdmin).toHaveBeenCalledWith(1, 5, "No era eso", expect.any(String)))
  })

  it("una salida olvidada se marca con la hora y el motivo, y dice que no se reversa desde acá", async () => {
    m.getToday.mockResolvedValue(today({ attendance_pending_review_count: 1 }))
    m.getPanel.mockResolvedValue({
      scope: "store",
      generated_at: "2026-09-27T17:53:00Z",
      stores: [
        panel({
          staff: {
            present: [],
            pending_review: [
              { entry_id: 88, employee_id: 9, name: "Jhon Pérez", business_date: "2026-09-26", in_at: "2026-09-26T21:10:00Z" },
            ],
            reason: null,
          },
        }),
      ],
    })
    m.fixAttendanceExit.mockResolvedValue({ id: 88, out_at: "2026-09-27T04:00:00Z" })
    const user = userEvent.setup()
    renderWithProviders(<TodayPage />, { me: buildMe() })

    const aviso = (await screen.findByText("Jhon Pérez no marcó salida ayer")).closest("li") as HTMLElement
    expect(within(aviso).getByText(/Entró a las 4:10 p\. m\./)).toBeInTheDocument()
    await user.click(within(aviso).getByRole("button", { name: "Marcar salida" }))
    expect(within(aviso).getByLabelText("Hora de salida")).toHaveValue("2026-09-26T23:00")
    await user.type(within(aviso).getByLabelText(/Motivo de la corrección/), "Cerró la tablet a las 11")
    await user.click(within(aviso).getByRole("button", { name: "Marcar salida" }))
    expect(m.fixAttendanceExit).toHaveBeenCalledWith(88, {
      store_id: 1,
      out_at: "2026-09-26T23:00",
      reason: "Cerró la tablet a las 11",
    })
    expect(await within(aviso).findByText(/Salida marcada por ti con motivo/)).toBeInTheDocument()
    expect(within(aviso).getByText(/no se reversa desde acá/)).toBeInTheDocument()
  })

  it("si la lista no se pudo leer, queda el aviso agregado de siempre", async () => {
    m.getToday.mockResolvedValue(today({ deposits_to_confirm_count: 2 }))
    m.getDeposits.mockRejectedValue(new Error("sin red"))
    renderWithProviders(<TodayPage />, { me: buildMe() })

    expect(await screen.findByText("2 consignaciones por confirmar")).toBeInTheDocument()
  })
})
