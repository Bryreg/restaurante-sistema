import { screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ShiftCashSummary } from "@/api/shifts";
import { renderWithProviders } from "@/test/utils";

import { cashSummaryHeadline } from "../lib";
import { MoneyAdminPage } from "../MoneyAdminPage";

vi.mock("@/app/storeContext", () => ({
  useStoreSelection: () => ({ stores: [{ id: 1, name: "Sede Centro" }], loading: false, activeStoreId: 1, setActiveStoreId: vi.fn() }),
}));

const { listCuadresMock, getAdminShiftsSummaryMock } = vi.hoisted(() => ({
  listCuadresMock: vi.fn(),
  getAdminShiftsSummaryMock: vi.fn(),
}));

vi.mock("@/api/shifts", async () => {
  const actual = await vi.importActual<typeof import("@/api/shifts")>("@/api/shifts");
  return { ...actual, listCuadres: listCuadresMock, getAdminShiftsSummary: getAdminShiftsSummaryMock };
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
  listCuadresMock.mockResolvedValue({ shifts: [], performance: [] });
  getAdminShiftsSummaryMock.mockResolvedValue(SUMMARY);
});

describe("Dinero › Cuadres — la URL elige el estado (las pestañas viejas siguen llevando a algún lado)", () => {
  it("?tab=historial abre los cerrados (el aviso de caja de Hoy enlaza ahí)", async () => {
    renderWithProviders(<MoneyAdminPage />, { route: "/admin/dinero?tab=historial" });
    expect(await screen.findByRole("button", { name: "Cerrados", pressed: true })).toBeInTheDocument();
    await waitFor(() => expect(listCuadresMock).toHaveBeenCalledWith(expect.objectContaining({ storeId: 1, status: "closed" })));
  });

  it("sin estado abre todos, del primer día del mes a hoy", async () => {
    renderWithProviders(<MoneyAdminPage />, { route: "/admin/dinero" });
    expect(screen.getByRole("button", { name: "Todos", pressed: true })).toBeInTheDocument();
    await waitFor(() => expect(listCuadresMock).toHaveBeenCalled());
    const filtros = listCuadresMock.mock.calls[0]![0];
    expect(filtros.status).toBe("all");
    expect(filtros.from).toMatch(/^\d{4}-\d{2}-01$/);
  });
});

describe("Dinero › Cuadres — ¿la caja cuadra? (informe #10)", () => {
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
