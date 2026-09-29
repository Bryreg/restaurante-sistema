import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Me } from "@/api/auth";
import type { OpeningInfo, OpeningPreview, OpeningPreviewIn } from "@/api/shifts";
import { renderWithProviders } from "@/test/utils";

import { CashOpeningForm } from "../CashOpeningForm";

vi.mock("@/api/employees", async () => {
  const actual = await vi.importActual<typeof import("@/api/employees")>("@/api/employees");
  return {
    ...actual,
    listDeviceEmployees: vi.fn().mockResolvedValue([{ id: 7, name: "Ana", role: "operator" }]),
  };
});

const { previewMock, openShiftMock } = vi.hoisted(() => ({ previewMock: vi.fn(), openShiftMock: vi.fn() }));

vi.mock("@/api/shifts", async () => {
  const actual = await vi.importActual<typeof import("@/api/shifts")>("@/api/shifts");
  return { ...actual, previewOpening: previewMock, openShift: openShiftMock };
});

const ME: Me = {
  kind: "device",
  store: { id: 1, name: "Sede Centro", cutoff_hour: 6, active_channels: [] },
  employee: { id: 7, name: "Ana", role: "operator", can_charge: true },
  organization: { id: 1, name: "Organización de prueba" },
  features: { "money.deposits": true, "cash.reserve": true },
};

const INFO: OpeningInfo = {
  mode: "envelopes",
  envelopes: [
    { shift_id: 11, business_date: "2026-09-21", outstanding: 50_000 },
    { shift_id: 12, business_date: "2026-09-22", outstanding: 74_000 },
  ],
  pending_count: null,
  reserve_available: false,
};

/**
 * Un servidor de mentira que responde lo que calcularía el de verdad. Las
 * cifras salen de acá, nunca de la pantalla: `expected` no es la suma que
 * haría un cliente (lleva un número imposible de adivinar), para que el test
 * falle si la pantalla sumara por su cuenta.
 */
function servidor(body: OpeningPreviewIn): OpeningPreview {
  const ids = body.carried_shift_ids ?? [11, 12];
  const expected = ids.length === 2 ? 124_001 : ids.includes(12) ? 74_001 : ids.includes(11) ? 50_001 : 0;
  const counted = body.counted ? body.counted.total : null;
  const difference = counted === null ? null : counted - expected;
  return {
    mode: "envelopes",
    days: [
      { shift_id: 11, business_date: "2026-09-21", outstanding: 50_000, selected: ids.includes(11) },
      { shift_id: 12, business_date: "2026-09-22", outstanding: 74_000, selected: ids.includes(12) },
    ],
    fixed_base: 0,
    carried_total: expected,
    expected,
    counted,
    difference,
    surplus_consignable: difference === null ? null : Math.max(0, difference),
    shortage: difference === null ? null : Math.max(0, -difference),
    requires_justification: difference !== null && difference !== 0,
    blocks_empty: counted === 0 && expected > 0,
  };
}

beforeEach(() => {
  previewMock.mockReset().mockImplementation((body: OpeningPreviewIn) => Promise.resolve(servidor(body)));
  openShiftMock.mockReset();
});

describe("CashOpeningForm — la apertura igual al café", () => {
  it("arranca con todos los días marcados y muestra «Debería haber» que calculó el servidor", async () => {
    renderWithProviders(<CashOpeningForm info={INFO} />, { me: ME });

    const dias = screen.getAllByRole("button", { pressed: true, name: /sep\s*\$/ });
    expect(dias).toHaveLength(2);
    await waitFor(() => expect(screen.getByTestId("opening-expected")).toHaveTextContent("$ 124.001"));
    expect(previewMock).toHaveBeenCalledWith({ carried_shift_ids: [11, 12], counted: undefined });
    expect(screen.getByRole("button", { name: /Contá el efectivo primero/ })).toBeDisabled();
  });

  it("desmarcar un día cambia lo que debería haber (lo vuelve a pedir al servidor)", async () => {
    const user = userEvent.setup();
    renderWithProviders(<CashOpeningForm info={INFO} />, { me: ME });

    await user.click(screen.getByRole("button", { name: /sep\s*\$ 50\.000/ }));
    await waitFor(() => expect(screen.getByTestId("opening-expected")).toHaveTextContent("$ 74.001"));
    expect(previewMock).toHaveBeenLastCalledWith({ carried_shift_ids: [12], counted: undefined });
  });

  it("con diferencia en vivo pide causa y motivo, y abre con lo marcado y lo contado", async () => {
    openShiftMock.mockResolvedValue({ id: 99 });
    const user = userEvent.setup();
    renderWithProviders(<CashOpeningForm info={INFO} />, { me: ME });
    await screen.findByText("$ 124.001");

    // Contar $ 100.000 con el teclado de denominaciones.
    await user.click(screen.getByRole("button", { name: /^Sumar .*\$ 100\.000$/ }));
    expect(await screen.findByText(/Faltan \$ 24\.001/)).toBeInTheDocument();

    const abrir = screen.getByRole("button", { name: /Elegí la causa de la diferencia/ });
    expect(abrir).toBeDisabled();
    await user.click(screen.getByRole("radio", { name: "Error de conteo" }));
    expect(screen.getByRole("button", { name: /Escribí el motivo de la diferencia/ })).toBeDisabled();
    await user.type(screen.getByLabelText("Motivo (obligatorio)"), "Faltaba plata del lunes");

    await user.click(screen.getByRole("button", { name: /Confirmar cuadre y abrir el turno/ }));
    await waitFor(() => expect(openShiftMock).toHaveBeenCalled());
    const body = openShiftMock.mock.calls[0]![0];
    expect(body.carried_shift_ids).toEqual([11, 12]);
    expect(body.opening_cash.total).toBe(100_000);
    expect(body.opening_cause).toBe("counting_error");
    expect(body.opening_note).toBe("Faltaba plata del lunes");
  });

  it("si cuadra no pide nada: «✓ Cuadra» y abre", async () => {
    previewMock.mockImplementation((body: OpeningPreviewIn) => {
      const r = servidor(body);
      return Promise.resolve(r.counted === null ? r : { ...r, difference: 0, requires_justification: false });
    });
    openShiftMock.mockResolvedValue({ id: 99 });
    const user = userEvent.setup();
    renderWithProviders(<CashOpeningForm info={INFO} />, { me: ME });
    await screen.findByText("$ 124.001");

    await user.click(screen.getByRole("button", { name: /^Sumar .*\$ 100\.000$/ }));
    expect(await screen.findByText("✓ Cuadra")).toBeInTheDocument();
    await user.click(await screen.findByRole("button", { name: /Confirmar cuadre y abrir el turno/ }));
    await waitFor(() => expect(openShiftMock).toHaveBeenCalled());
    expect(openShiftMock.mock.calls[0]![0].opening_cause).toBeUndefined();
  });
});
