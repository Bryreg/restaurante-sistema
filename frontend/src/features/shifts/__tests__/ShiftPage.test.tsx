import { screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { Me } from "@/api/auth";
import type { ShiftCurrent, ShiftSummary } from "@/api/shifts";
import { renderWithProviders } from "@/test/utils";

import ShiftPage from "../ShiftPage";

const { SHIFT, SUMMARY } = vi.hoisted(() => ({
  SHIFT: {
    id: 42,
    business_date: "2026-09-14",
    opened_at: "2026-09-14T13:00:00Z",
    cash_responsible: { id: 1, name: "Ana" },
    roster: [],
    is_stale: false,
    cash_over_threshold: false,
    // `expected_cash` deliberadamente AUSENTE: el operador no es el
    // responsable de caja en este `me`, así que el servidor no lo manda.
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
}));

vi.mock("@/api/shifts", async () => {
  const actual = await vi.importActual<typeof import("@/api/shifts")>("@/api/shifts");
  return {
    ...actual,
    getCurrentShift: vi.fn().mockResolvedValue(SHIFT),
    getShiftSummary: vi.fn().mockResolvedValue(SUMMARY),
  };
});

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

describe("ShiftPage — pestañas opcionales por flag", () => {
  it('no muestra "Relevo" con cash.handovers apagado', async () => {
    renderWithProviders(<ShiftPage />, { me: deviceMe({ "cash.handovers": false }) });

    await waitFor(() => expect(screen.getByText("Resumen")).toBeInTheDocument());
    expect(screen.queryByText("Relevo")).not.toBeInTheDocument();
  });

  it('muestra "Relevo" con cash.handovers encendido', async () => {
    renderWithProviders(<ShiftPage />, { me: deviceMe({ "cash.handovers": true }) });

    await waitFor(() => expect(screen.getByRole("tab", { name: "Relevo" })).toBeInTheDocument());
  });

  it('la reserva se muestra aparte de la base fija, y el esperado ausente se muestra "—"', async () => {
    renderWithProviders(<ShiftPage />, { me: deviceMe({}) });

    // `GET /shifts/{id}` (el resumen con `opening_cash_total`/`cash_reserve`)
    // llega después del render inicial: se espera a que el dato asincrónico
    // aparezca en pantalla antes de leer las filas.
    await waitFor(() =>
      expect(screen.getByText("Base fija").parentElement?.textContent).toContain("200.000"),
    );

    const reserveLabel = screen.getByText(/Reserva \(aparte/i);
    const reserveRow = reserveLabel.parentElement as HTMLElement;
    expect(reserveRow.textContent).toContain("50.000");

    const baseLabel = screen.getByText("Base fija");
    const baseRow = baseLabel.parentElement as HTMLElement;
    expect(baseRow.textContent).toContain("200.000");
    // La reserva no está sumada dentro de la fila de la base.
    expect(baseRow.textContent).not.toContain("50.000");

    const expectedLabel = screen.getByText("Esperado");
    const expectedRow = expectedLabel.parentElement as HTMLElement;
    expect(expectedRow.textContent).toContain("—");
    expect(expectedRow.textContent).not.toContain("0");
  });
});
