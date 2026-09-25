import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { Me } from "@/api/auth";
import type { ShiftCurrent, ShiftSummary } from "@/api/shifts";
import { renderWithProviders } from "@/test/utils";

import ShiftPage from "../ShiftPage";

/**
 * «Conteo de mi área» en la grilla del turno (`inventory.shift_counts`,
 * 2026-09-25): aparece sólo con su función, abre su panel en la hoja y se
 * puede enlazar con `?accion=conteo`. Lo que el panel hace adentro lo prueba
 * `features/inventory/__tests__/AreaCountPanel.test.tsx`.
 */

const { SHIFT, SUMMARY } = vi.hoisted(() => ({
  SUMMARY: {
    id: 42,
    business_date: "2026-09-14",
    status: "open",
    opened_at: "2026-09-14T13:00:00Z",
    cash_responsible: { id: 1, name: "Ana" },
    opening_cash_total: 200_000,
    cash_reserve: 0,
    roster: [],
    movements: [],
    swaps: [],
    pickups: [],
    handovers: [],
  } satisfies ShiftSummary,
  SHIFT: {
    id: 42,
    business_date: "2026-09-14",
    opened_at: "2026-09-14T13:00:00Z",
    cash_responsible: { id: 1, name: "Ana" },
    roster: [],
    is_stale: false,
    cash_over_threshold: false,
  } satisfies ShiftCurrent,
}));

vi.mock("@/api/shifts", async () => {
  const actual = await vi.importActual<typeof import("@/api/shifts")>("@/api/shifts");
  return { ...actual, getCurrentShift: vi.fn().mockResolvedValue(SHIFT), getShiftSummary: vi.fn().mockResolvedValue(SUMMARY) };
});
vi.mock("@/features/inventory/AreaCountPanel", () => ({ AreaCountPanel: () => <p>panel-conteo</p> }));

function deviceMe(features: Record<string, boolean>): Me {
  return {
    kind: "device",
    store: { id: 1, name: "Sede Centro", cutoff_hour: 6, active_channels: [] },
    employee: { id: 1, name: "Ana", role: "operator", can_charge: false },
    employee_expires_at: null,
    organization: { id: 1, name: "Organización de prueba" },
    features,
  };
}

async function rotulos(): Promise<string[]> {
  const seccion = (await screen.findByRole("heading", { name: "Acciones del turno" })).closest("section");
  return within(seccion as HTMLElement)
    .getAllByRole("button")
    .map((b) => b.getAttribute("aria-label") ?? "");
}

describe("ShiftPage — Conteo de mi área", () => {
  it("sólo aparece con inventory.shift_counts", async () => {
    const { unmount } = renderWithProviders(<ShiftPage />, { me: deviceMe({}) });
    expect(await rotulos()).not.toContain("Conteo de mi área");
    unmount();
    renderWithProviders(<ShiftPage />, { me: deviceMe({ "inventory.shift_counts": true }) });
    expect(await rotulos()).toContain("Conteo de mi área");
  });

  it("el botón abre el panel en la hoja", async () => {
    const user = userEvent.setup();
    renderWithProviders(<ShiftPage />, { me: deviceMe({ "inventory.shift_counts": true }) });
    await user.click(await screen.findByRole("button", { name: "Conteo de mi área" }));
    const hoja = await screen.findByRole("dialog", { name: "Conteo de mi área" });
    expect(within(hoja).getByText("panel-conteo")).toBeInTheDocument();
  });

  it("?accion=conteo abre directo; con la función apagada se ignora", async () => {
    const { unmount } = renderWithProviders(<ShiftPage />, {
      me: deviceMe({ "inventory.shift_counts": true }),
      route: "/pos/turno?accion=conteo",
    });
    expect(within(await screen.findByRole("dialog", { name: "Conteo de mi área" })).getByText("panel-conteo")).toBeInTheDocument();
    unmount();
    renderWithProviders(<ShiftPage />, { me: deviceMe({}), route: "/pos/turno?accion=conteo" });
    await rotulos();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
