import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AdjustOpeningPreview, CuadreShift, CuadresResponse } from "@/api/shifts";
import { renderWithProviders } from "@/test/utils";

import { CuadresScreen } from "../CuadresScreen";

vi.mock("@/app/storeContext", () => ({
  useStoreSelection: () => ({
    stores: [
      { id: 1, name: "Sede Centro" },
      { id: 2, name: "Sede Norte" },
    ],
    loading: false,
    activeStoreId: 1,
    setActiveStoreId: vi.fn(),
  }),
}));

const { listCuadresMock, summaryMock, formMock, previewMock, adjustMock } = vi.hoisted(() => ({
  listCuadresMock: vi.fn(),
  summaryMock: vi.fn(),
  formMock: vi.fn(),
  previewMock: vi.fn(),
  adjustMock: vi.fn(),
}));

vi.mock("@/api/shifts", async () => {
  const actual = await vi.importActual<typeof import("@/api/shifts")>("@/api/shifts");
  return {
    ...actual,
    listCuadres: listCuadresMock,
    getAdminShiftsSummary: summaryMock,
    getAdjustOpeningForm: formMock,
    previewAdjustOpening: previewMock,
    adminAdjustOpening: adjustMock,
  };
});

/** Un turno como lo manda el servidor: cifras que no pueden salir de ningún otro lado. */
const SABADO: CuadreShift = {
  shift_id: 7,
  business_date: "2026-09-19",
  status: "closed",
  opened_at: "2026-09-19T12:00:00Z",
  closed_at: "2026-09-20T02:30:00Z",
  opened_by: "Ana",
  cash_responsible: { id: 3, name: "Ana" },
  is_stale: false,
  opening_mode: "envelopes",
  opening_cash_total: 500_000,
  sales_total: 612_300,
  sales_cash: 197_900,
  sales_card: 414_400,
  sales_transfer: 0,
  sales_other: 0,
  expected_cash: 697_900,
  counted_cash: 692_900,
  difference: -5_000,
  closed_without_count: false,
  to_deposit: 697_900,
  close_photo: "/api/v1/photos/9",
  cuadres: [
    {
      kind: "opening",
      label: "Inicial",
      at: "2026-09-19T12:00:00Z",
      employee_name: "Ana",
      counted: 500_000,
      expected: 0,
      difference: 500_000,
      desglose: { carried_days: [], expected: 0, counted: 500_000, difference: 500_000, surplus_consignable: 500_000 },
    },
    {
      kind: "close",
      label: "Cierre",
      at: "2026-09-20T02:30:00Z",
      employee_name: "Ana",
      counted: 692_900,
      expected: 697_900,
      difference: -5_000,
      photo: "/api/v1/photos/9",
      desglose: {
        base: 500_000,
        cash_sales: 197_900,
        incomes: 30_000,
        expenses: 30_000,
        expense_lines: [{ at: "2026-09-19T15:00:00Z", concept: "Pago a proveedor", note: "Leche", amount: 30_000 }],
        pickups: 0,
        deposits: 0,
        expected: 697_900,
        counted: 692_900,
        difference: -5_000,
        reserve_apart: 100_000,
      },
    },
  ],
  people: [{ employee_id: 3, name: "Ana", in_at: "2026-09-19T12:00:00Z", out_at: "2026-09-20T02:30:00Z" }],
  movements: [
    {
      at: "2026-09-19T15:00:00Z",
      direction: "out",
      kind: "movement",
      concept: "Pago a proveedor",
      supplier_name: "Lácteos del Valle",
      employee_name: "Ana",
      photo: "/api/v1/photos/4",
      note: "Leche",
      amount: -30_000,
    },
  ],
  adjustments: 0,
};

const RESPUESTA: CuadresResponse = {
  shifts: [SABADO],
  performance: [{ employee_id: 3, name: "Ana", cuadres: 2, with_difference: 2, diff_total: 495_000, worst_difference: 500_000 }],
};

beforeEach(() => {
  listCuadresMock.mockReset().mockResolvedValue(RESPUESTA);
  summaryMock.mockReset().mockResolvedValue({
    store_id: 1,
    date_from: null,
    date_to: null,
    closed_count: 0,
    counted_count: 0,
    uncounted_count: 0,
    diff_total: 0,
    shortage_total: 0,
    overage_total: 0,
    shortage_count: 0,
    overage_count: 0,
    exact_count: 0,
    tolerance: 0,
    beyond_tolerance_count: 0,
    by_person: [],
    by_day: [],
  });
  formMock.mockReset();
  previewMock.mockReset();
  adjustMock.mockReset();
});

describe("Cuadres — la tarjeta del turno", () => {
  it("muestra abrió→cerró, la línea de números, los cuadres «contó / debía» y los movimientos con proveedor", async () => {
    renderWithProviders(<CuadresScreen storeId={1} />);

    const card = await screen.findByRole("article", { name: /Turno del/ });
    expect(within(card).getByText(/Abrió .* → cerró/)).toBeInTheDocument();
    const numeros = within(card).getByTestId("cuadre-numeros");
    expect(numeros).toHaveTextContent("Base $ 500.000");
    expect(numeros).toHaveTextContent("Ventas $ 612.300");
    expect(numeros).toHaveTextContent("Tarjeta $ 414.400");
    expect(numeros).toHaveTextContent("Cierre −$ 5.000");
    expect(within(card).getByText(/contó \$ 500\.000 \/ debía \$ 0/)).toBeInTheDocument();
    expect(within(card).getByText(/contó \$ 692\.900 \/ debía \$ 697\.900/)).toBeInTheDocument();
    expect(within(card).getByText("Sobra +$ 500.000")).toBeInTheDocument();
    expect(within(card).getByText("Falta −$ 5.000")).toBeInTheDocument();

    const movimientos = within(card).getByRole("region", { name: "Movimientos de caja" });
    expect(within(movimientos).getByText("Pago a proveedor")).toBeInTheDocument();
    expect(within(movimientos).getByText(/Lácteos del Valle/)).toBeInTheDocument();
    expect(within(movimientos).getByText("−$ 30.000")).toBeInTheDocument();
    expect(within(movimientos).getByRole("link", { name: "Foto de Pago a proveedor" })).toHaveAttribute("href", "/api/v1/photos/4");

    expect(within(card).getByRole("button", { name: "Reabrir cierre" })).toBeInTheDocument();
    expect(within(card).getByRole("link", { name: "Ficha" })).toHaveAttribute("href", "/admin/dinero/turno/7");
    expect(within(card).getByRole("link", { name: "Ana" })).toHaveAttribute("href", "/admin/personal/persona/3");
  });

  it("marca abandonado y ofrece «Cerrar turno pendiente» en un turno abierto de otro día", async () => {
    listCuadresMock.mockResolvedValue({
      shifts: [{ ...SABADO, status: "open", closed_at: null, is_stale: true, cuadres: [SABADO.cuadres[0]!] }],
      performance: [],
    });
    renderWithProviders(<CuadresScreen storeId={1} />);

    const card = await screen.findByRole("article", { name: /Turno del/ });
    expect(within(card).getByText(/^Abandonado · /)).toBeInTheDocument();
    expect(within(card).getByRole("button", { name: "Cerrar turno pendiente" })).toBeInTheDocument();
    expect(within(card).queryByRole("button", { name: "Reabrir cierre" })).not.toBeInTheDocument();
  });

  it("despliega el desglose del cierre con las salidas una por una y la base de respaldo aparte", async () => {
    const user = userEvent.setup();
    renderWithProviders(<CuadresScreen storeId={1} />);

    const card = await screen.findByRole("article", { name: /Turno del/ });
    await user.click(within(card).getByRole("button", { name: /Cierre contó/ }));
    const desglose = within(card).getByRole("region", { name: "Desglose del cuadre Cierre" });
    expect(within(desglose).getByText("Con lo que empezó (base)")).toBeInTheDocument();
    expect(within(desglose).getByText(/Pago a proveedor — Leche/)).toBeInTheDocument();
    expect(within(desglose).getByText("= Debería haber")).toBeInTheDocument();
    expect(within(desglose).getByText("$ 697.900")).toBeInTheDocument();
    expect(within(desglose).getByText(/Base de respaldo aparte \(no cuenta\): \$ 100\.000/)).toBeInTheDocument();
  });

  it("filtra por estado y pie de desempeño por responsable con su descarga", async () => {
    const user = userEvent.setup();
    renderWithProviders(<CuadresScreen storeId={1} />);

    await screen.findByRole("article", { name: /Turno del/ });
    await user.click(screen.getByRole("button", { name: "Abiertos" }));
    await waitFor(() => expect(listCuadresMock).toHaveBeenLastCalledWith(expect.objectContaining({ status: "open" })));

    expect(screen.getByText("Desempeño por responsable")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Descargar desempeño" }).getAttribute("href")).toContain("export=performance");
    expect(screen.getByRole("link", { name: "Descargar cuadres" }).getAttribute("href")).toContain("format=csv");
    expect(screen.getByRole("group", { name: "Sede" })).toBeInTheDocument();
  });
});

describe("Cuadres — Ajustar apertura como el café", () => {
  it("rehace los días del cajón y muestra la vista previa del servidor antes de guardar", async () => {
    formMock.mockResolvedValue({
      shift_id: 7,
      opening_mode: "envelopes",
      opening_cash_total: 500_000,
      cash_reserve: 0,
      days: [{ shift_id: 6, business_date: "2026-09-18", amount: 500_000, selected: false }],
    });
    const antes: AdjustOpeningPreview = {
      opening_cash_total: 500_000,
      carried_total_before: 0,
      carried_total_after: 0,
      opening_expected_after: 0,
      opening_difference_after: 500_000,
      close_expected_before: 697_900,
      close_expected_after: 697_900,
      close_difference_before: 0,
      close_difference_after: 0,
      to_deposit_before: 697_900,
      to_deposit_after: 697_900,
    };
    const despues: AdjustOpeningPreview = { ...antes, carried_total_after: 500_000, opening_expected_after: 500_000, opening_difference_after: 0, to_deposit_after: 197_900 };
    previewMock.mockImplementation((_id: number, body: { carried_shift_ids?: number[] }) =>
      Promise.resolve(body.carried_shift_ids?.length ? despues : antes),
    );
    adjustMock.mockResolvedValue({ id: 7 });
    const user = userEvent.setup();
    renderWithProviders(<CuadresScreen storeId={1} />);

    const card = await screen.findByRole("article", { name: /Turno del/ });
    await user.click(within(card).getByRole("button", { name: "Ajustar apertura" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).queryByLabelText(/Reserva/)).not.toBeInTheDocument();

    await user.click(await within(dialog).findByRole("button", { name: /\$ 500\.000/ }));
    const preview = within(dialog).getByTestId("adjust-preview");
    await waitFor(() => expect(preview).toHaveTextContent("Consignable queda en $ 197.900 (antes $ 697.900)"));
    expect(preview).toHaveTextContent("Va a quedar esperando $ 500.000 de días anteriores");

    const guardar = within(dialog).getByRole("button", { name: "Guardar ajuste" });
    expect(guardar).toBeDisabled();
    await user.type(within(dialog).getByLabelText("Motivo (obligatorio)"), "El cajón tenía la venta del viernes");
    await user.click(guardar);
    await waitFor(() =>
      expect(adjustMock).toHaveBeenCalledWith(7, {
        opening_cash_total: 500_000,
        carried_shift_ids: [6],
        cash_reserve: undefined,
        reason: "El cajón tenía la venta del viernes",
      }),
    );
  }, 15_000);
});
