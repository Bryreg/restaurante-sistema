import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { Me } from "@/api/auth";
import type { ShiftCurrent, ShiftSummary } from "@/api/shifts";
import { renderWithProviders } from "@/test/utils";

import ShiftPage from "../ShiftPage";

/**
 * Inicio por rol (2026-09-25): las acciones de plata sólo para quien puede
 * manejar la caja; Entrada / Salida, Solicitudes, Novedades y el conteo del
 * área (si la persona es de un área) para todos.
 */

const { SHIFT, SUMMARY, AREA } = vi.hoisted(() => ({
  SHIFT: {
    id: 42,
    business_date: "2026-09-14",
    opened_at: "2026-09-14T13:00:00Z",
    cash_responsible: { id: 1, name: "Ana" },
    roster: [{ employee_id: 1, employee_name: "Ana", in_at: "2026-09-14T13:00:00Z", out_at: null }],
    is_stale: false,
    cash_over_threshold: false,
  } satisfies ShiftCurrent,
  SUMMARY: {
    id: 42,
    business_date: "2026-09-14",
    status: "open",
    opened_at: "2026-09-14T13:00:00Z",
    cash_responsible: { id: 1, name: "Ana" },
    opening_cash_total: 200_000,
    cash_reserve: 50_000,
    roster: [],
    movements: [],
    swaps: [],
    pickups: [],
    handovers: [],
  } satisfies ShiftSummary,
  AREA: { area_id: null as number | null },
}));

vi.mock("@/api/shifts", async () => {
  const actual = await vi.importActual<typeof import("@/api/shifts")>("@/api/shifts");
  return { ...actual, getCurrentShift: vi.fn().mockResolvedValue(SHIFT), getShiftSummary: vi.fn().mockResolvedValue(SUMMARY) };
});
vi.mock("@/api/areaCounts", async () => {
  const actual = await vi.importActual<typeof import("@/api/areaCounts")>("@/api/areaCounts");
  return {
    ...actual,
    getDeviceAreaCount: vi.fn(async () => ({
      area_id: AREA.area_id,
      area_name: AREA.area_id ? "Cocina" : null,
      reason: AREA.area_id ? null : "Sin área",
      business_date: "2026-09-14",
      items: [],
      suggested_moment: "opening",
      opening_done: null,
      closing_done: null,
      recounts: [],
    })),
  };
});

const TODAS = {
  "cash.swaps": true,
  "cash.pickups": true,
  "pos.delivery": true,
  "money.deposits": true,
  "cash.handovers": true,
  purchases: true,
  "pos.requests": true,
  "pos.novelties": true,
  "inventory.shift_counts": true,
};

function deviceMe(employee: NonNullable<Me["employee"]>): Me {
  return {
    kind: "device",
    store: { id: 1, name: "Sede Centro", cutoff_hour: 6, active_channels: [] },
    employee,
    employee_expires_at: null,
    organization: { id: 1, name: "Organización de prueba" },
    features: TODAS,
  };
}

const MESERO = { id: 3, name: "Beto", role: "operator", can_charge: false };
const CAJERA = { id: 4, name: "Luz", role: "operator", can_charge: true };

async function rotulos(): Promise<string[]> {
  const seccion = (await screen.findByRole("heading", { name: "Acciones del turno" })).closest("section");
  return within(seccion as HTMLElement)
    .getAllByRole("button")
    .map((b) => b.getAttribute("aria-label") ?? "");
}

describe("ShiftPage — inicio por rol", () => {
  it("el mesero sin área ve Entrada / Salida, Solicitudes y Novedades; nada de plata ni cierre", async () => {
    AREA.area_id = null;
    renderWithProviders(<ShiftPage />, { me: deviceMe(MESERO) });

    await waitFor(async () =>
      expect(await rotulos()).toEqual(["Entrada / Salida", "Solicitudes", "Novedades"]),
    );
    expect(screen.queryByRole("button", { name: /Cerrar turno/ })).not.toBeInTheDocument();
    expect(screen.queryByText("Base fija")).not.toBeInTheDocument();
  });

  it("el mesero de un área también ve el conteo de su área", async () => {
    AREA.area_id = 7;
    renderWithProviders(<ShiftPage />, { me: deviceMe(MESERO) });

    expect(await rotulos()).toContain("Conteo de mi área");
  });

  it("?accion=cierre no abre nada para quien no maneja la caja", async () => {
    AREA.area_id = null;
    renderWithProviders(<ShiftPage />, { me: deviceMe(MESERO), route: "/pos/turno?accion=cierre" });

    await rotulos();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("quien puede cobrar ve todas las acciones de caja y el cierre", async () => {
    AREA.area_id = null;
    renderWithProviders(<ShiftPage />, { me: deviceMe(CAJERA) });

    const grilla = await rotulos();
    for (const rotulo of ["Movimientos", "Cambio", "Retiros", "Domicilios", "Consignar", "Relevo", "Recibir mercancía"]) {
      expect(grilla).toContain(rotulo);
    }
    expect(screen.getByRole("button", { name: /Cerrar turno/ })).toBeInTheDocument();
    expect(screen.getByText("Base fija")).toBeInTheDocument();
  });
});
