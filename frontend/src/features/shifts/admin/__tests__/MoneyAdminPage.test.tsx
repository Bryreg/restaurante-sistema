import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ShiftCashSummary } from "@/api/shifts";
import { renderWithProviders } from "@/test/utils";

import { cashSummaryHeadline, moneyTabFromParam } from "../lib";
import { MoneyAdminPage } from "../MoneyAdminPage";

vi.mock("@/app/storeContext", () => ({
  useStoreSelection: () => ({ stores: [{ id: 1, name: "Sede Centro" }], loading: false, activeStoreId: 1, setActiveStoreId: vi.fn() }),
}));

const { listAdminShiftsMock, getAdminShiftsSummaryMock } = vi.hoisted(() => ({
  listAdminShiftsMock: vi.fn(),
  getAdminShiftsSummaryMock: vi.fn(),
}));

vi.mock("@/api/shifts", async () => {
  const actual = await vi.importActual<typeof import("@/api/shifts")>("@/api/shifts");
  return { ...actual, listAdminShifts: listAdminShiftsMock, getAdminShiftsSummary: getAdminShiftsSummaryMock };
});

/** La respuesta real de la simulación (8 al 21 sep), recortada a cuatro días. */
const SUMMARY: ShiftCashSummary = {
  store_id: 1,
  date_from: null,
  date_to: null,
  closed_count: 14,
  counted_count: 14,
  uncounted_count: 0,
  diff_total: -65_000,
  shortage_total: -68_000,
  overage_total: 3_000,
  shortage_count: 7,
  overage_count: 1,
  exact_count: 6,
  tolerance: 20_000,
  beyond_tolerance_count: 0,
  by_person: [
    {
      employee_id: 7,
      name: "Luz Marina Gómez",
      closes: 14,
      diff_total: -65_000,
      shortage_count: 7,
      overage_count: 1,
      current_streak: 3,
    },
  ],
  by_day: [
    { business_date: "2026-09-08", closes: 1, diff_total: -18_000 },
    { business_date: "2026-09-09", closes: 1, diff_total: 0 },
    { business_date: "2026-09-13", closes: 1, diff_total: -18_000 },
    { business_date: "2026-09-21", closes: 1, diff_total: 3_000 },
  ],
};

beforeEach(() => {
  listAdminShiftsMock.mockResolvedValue([]);
  getAdminShiftsSummaryMock.mockResolvedValue(SUMMARY);
});

describe("MoneyAdminPage — la pestaña la decide la URL", () => {
  it("?tab=historial abre Historial (el aviso de caja de Hoy enlaza ahí)", async () => {
    renderWithProviders(<MoneyAdminPage />, { route: "/admin/dinero?tab=historial" });

    expect(screen.getByRole("tab", { name: "Historial", selected: true })).toBeInTheDocument();
    expect(await screen.findByTestId("cash-summary-headline")).toBeInTheDocument();
  });

  it("sin pestaña (o con una que no existe) abre Operacional", () => {
    renderWithProviders(<MoneyAdminPage />, { route: "/admin/dinero?tab=cualquiera" });
    expect(screen.getByRole("tab", { name: "Operacional", selected: true })).toBeInTheDocument();
    expect(getAdminShiftsSummaryMock).not.toHaveBeenCalled();
  });

  it("cambiar de pestaña la deja en la URL y trae el resumen", async () => {
    const user = userEvent.setup();
    renderWithProviders(<MoneyAdminPage />, { route: "/admin/dinero" });
    await user.click(screen.getByRole("tab", { name: "Historial" }));
    expect(screen.getByRole("tab", { name: "Historial", selected: true })).toBeInTheDocument();
    await waitFor(() => expect(getAdminShiftsSummaryMock).toHaveBeenCalledWith({ storeId: 1, from: undefined, to: undefined }));
  });

  it("moneyTabFromParam acepta el nombre en español y el interno viejo", () => {
    expect(moneyTabFromParam("historial")).toBe("historial");
    expect(moneyTabFromParam("history")).toBe("historial");
    expect(moneyTabFromParam(null)).toBe("operacional");
  });
});

describe("Dinero › Historial — ¿la caja cuadra? (informe #10)", () => {
  it("el titular dice cuántos cierres con faltante y por cuánto, con las cifras del servidor", async () => {
    renderWithProviders(<MoneyAdminPage />, { route: "/admin/dinero?tab=historial" });

    const titular = await screen.findByTestId("cash-summary-headline");
    expect(titular).toHaveTextContent("7 de 14 cierres con faltante, −$ 68.000");
    expect(screen.getByText(/Diferencia neta −\$ 65\.000 · 1 con sobrante \(\+\$ 3\.000\) · 6 cuadraron/)).toBeInTheDocument();
  });

  it("por día, barras divergentes: faltante ▼ en rojo, sobrante ▲, cero «cuadra»", async () => {
    renderWithProviders(<MoneyAdminPage />, { route: "/admin/dinero?tab=historial" });

    expect(await screen.findByText("El faltante más grande fue el mar 8 sep: −$ 18.000")).toBeInTheDocument();
    const faltante = document.querySelector('[data-fila="2026-09-08"]') as HTMLElement;
    expect(within(faltante).getByText("−$ 18.000")).toBeInTheDocument();
    expect(faltante.querySelector('[data-barra="falta"]')).not.toBeNull();
    const sobrante = document.querySelector('[data-fila="2026-09-21"]') as HTMLElement;
    expect(within(sobrante).getByText("+$ 3.000")).toBeInTheDocument();
    expect(sobrante.querySelector('[data-barra="sobra"]')).not.toBeNull();
    expect(within(document.querySelector('[data-fila="2026-09-09"]') as HTMLElement).getByText("cuadra")).toBeInTheDocument();
  });

  it("por persona, con la racha en el titular", async () => {
    renderWithProviders(<MoneyAdminPage />, { route: "/admin/dinero?tab=historial" });

    expect(await screen.findByText("Luz Marina Gómez lleva 3 cierres seguidos fuera de tolerancia")).toBeInTheDocument();
    expect(screen.getByText("Luz Marina Gómez · 14 cierres · racha de 3")).toBeInTheDocument();
  });

  it("los cierres sin contar no son $0: se dicen aparte", () => {
    expect(cashSummaryHeadline({ ...SUMMARY, counted_count: 0, shortage_count: 0, uncounted_count: 3 })).toBe(
      "Ningún cierre del período se contó todavía",
    );
    expect(cashSummaryHeadline({ ...SUMMARY, shortage_count: 0, overage_count: 0 })).toBe("Los 14 cierres contados cuadraron");
  });
});
