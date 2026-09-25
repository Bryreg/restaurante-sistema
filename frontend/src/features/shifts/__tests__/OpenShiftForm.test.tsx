import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "@/api/client";

import type { Me } from "@/api/auth";
import { renderWithProviders } from "@/test/utils";

import { OpenShiftForm } from "../OpenShiftForm";

vi.mock("@/api/employees", async () => {
  const actual = await vi.importActual<typeof import("@/api/employees")>("@/api/employees");
  return {
    ...actual,
    listDeviceEmployees: vi.fn().mockResolvedValue([
      { id: 7, name: "Ana", role: "operator" },
      { id: 9, name: "Beto", role: "supervisor" },
    ]),
  };
});

const { getCarryCandidatesMock, openShiftMock } = vi.hoisted(() => ({
  getCarryCandidatesMock: vi.fn(),
  openShiftMock: vi.fn(),
}));

vi.mock("@/api/shifts", async () => {
  const actual = await vi.importActual<typeof import("@/api/shifts")>("@/api/shifts");
  return { ...actual, getCarryCandidates: getCarryCandidatesMock, openShift: openShiftMock };
});

beforeEach(() => {
  getCarryCandidatesMock.mockReset();
  openShiftMock.mockReset();
});

function deviceMe(features: Record<string, boolean>): Me {
  return {
    kind: "device",
    store: { id: 1, name: "Sede Centro", cutoff_hour: 6, active_channels: [] },
    employee: { id: 7, name: "Ana", role: "operator", can_charge: false },
    organization: { id: 1, name: "Organización de prueba" },
    features,
  };
}

describe("OpenShiftForm — la reserva se muestra aparte de la base", () => {
  it("con cash.reserve encendida, la reserva es un campo propio con su leyenda", () => {
    renderWithProviders(<OpenShiftForm />, { me: deviceMe({ "cash.reserve": true }) });

    expect(screen.getByText("Base contada")).toBeInTheDocument();
    expect(screen.getByLabelText("Reserva de caja")).toBeInTheDocument();
    expect(screen.getByText(/no entra al cuadre/i)).toBeInTheDocument();
  });

  it("con cash.reserve apagada, no se pide la reserva", () => {
    renderWithProviders(<OpenShiftForm />, { me: deviceMe({ "cash.reserve": false }) });

    expect(screen.queryByLabelText("Reserva de caja")).not.toBeInTheDocument();
  });

  it("precarga el responsable de caja con quien está identificado, elegido con EmployeePicker (sin input numérico)", async () => {
    renderWithProviders(<OpenShiftForm />, { me: deviceMe({}) });

    expect(await screen.findByRole("radio", { name: /ana, operador/i })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(screen.getByRole("radio", { name: /beto, supervisor/i })).toHaveAttribute("aria-checked", "false");
    expect(screen.queryByLabelText(/responsable de caja \(número de empleado\)/i)).not.toBeInTheDocument();
  });
});

describe("OpenShiftForm — la plata de días anteriores que está en la caja (2026-09-24)", () => {
  const CANDIDATES = [
    { shift_id: 11, business_date: "2026-09-21", outstanding: 350_000 },
    { shift_id: 12, business_date: "2026-09-22", outstanding: 410_000 },
  ];

  it("lista los días con su saldo del servidor, TODOS desmarcados, con la ayuda corta", async () => {
    getCarryCandidatesMock.mockResolvedValue(CANDIDATES);
    renderWithProviders(<OpenShiftForm />, { me: deviceMe({ "money.deposits": true }) });

    expect(await screen.findByText("¿La plata de qué días está en la caja?")).toBeInTheDocument();
    expect(screen.getByText("Marcá solo los días cuya plata está físicamente acá.")).toBeInTheDocument();
    const boxes = screen.getAllByRole("checkbox");
    expect(boxes).toHaveLength(2);
    for (const box of boxes) expect(box).not.toBeChecked();
    expect(screen.getByText("$ 350.000")).toBeInTheDocument();
    expect(screen.getByText("$ 410.000")).toBeInTheDocument();
    // Ningún total armado en el cliente: ni la suma de los dos días, ni base + días.
    expect(screen.queryByText("$ 760.000")).not.toBeInTheDocument();
  });

  it("sin marcar nada manda carried_shift_ids: []; marcando un día, manda sólo ese id", async () => {
    getCarryCandidatesMock.mockResolvedValue(CANDIDATES);
    openShiftMock.mockResolvedValue({ id: 99 });
    const user = userEvent.setup();
    renderWithProviders(<OpenShiftForm />, { me: deviceMe({ "money.deposits": true }) });

    await screen.findByText("¿La plata de qué días está en la caja?");
    await screen.findByRole("radio", { name: /ana, operador/i });
    await user.click(screen.getByRole("button", { name: "Abrir turno" }));
    await waitFor(() => expect(openShiftMock).toHaveBeenCalledTimes(1));
    expect(openShiftMock.mock.calls[0]?.[0]).toMatchObject({ carried_shift_ids: [] });

    await user.click(screen.getByRole("checkbox", { name: /\$ 410\.000/ }));
    await user.click(screen.getByRole("button", { name: "Abrir turno" }));
    await waitFor(() => expect(openShiftMock).toHaveBeenCalledTimes(2));
    expect(openShiftMock.mock.calls[1]?.[0]).toMatchObject({ carried_shift_ids: [12] });
  });

  it("si no cuadra, muestra el mensaje del servidor (que trae el total esperado), sin calcularlo acá", async () => {
    getCarryCandidatesMock.mockResolvedValue(CANDIDATES);
    const serverMessage =
      "Lo contado ($ 0) no coincide: la base fija ($ 200.000) más lo marcado de días anteriores ($ 350.000) da $ 550.000. Elegí una causa para poder abrir el turno";
    openShiftMock.mockRejectedValue(
      new ApiError(400, "OPENING_DIFFERENCE_NEEDS_CAUSE", serverMessage),
    );
    const user = userEvent.setup();
    renderWithProviders(<OpenShiftForm />, { me: deviceMe({ "money.deposits": true }) });

    await screen.findByText("¿La plata de qué días está en la caja?");
    await screen.findByRole("radio", { name: /ana, operador/i });
    await user.click(screen.getByRole("checkbox", { name: /\$ 350\.000/ }));
    await user.click(screen.getByRole("button", { name: "Abrir turno" }));

    expect(await screen.findByText(serverMessage)).toBeInTheDocument();
    expect(screen.getByText(/base fija más los días marcados/)).toBeInTheDocument();
  });

  it("con Consignaciones apagada no pide la lista ni muestra la sección", async () => {
    renderWithProviders(<OpenShiftForm />, { me: deviceMe({ "money.deposits": false }) });

    await screen.findByRole("radio", { name: /ana, operador/i });
    expect(getCarryCandidatesMock).not.toHaveBeenCalled();
    expect(screen.queryByText("¿La plata de qué días está en la caja?")).not.toBeInTheDocument();
  });

  it("con Consignaciones encendida pero sin días por consignar, la pantalla queda como estaba", async () => {
    getCarryCandidatesMock.mockResolvedValue([]);
    renderWithProviders(<OpenShiftForm />, { me: deviceMe({ "money.deposits": true }) });

    await waitFor(() => expect(getCarryCandidatesMock).toHaveBeenCalled());
    expect(screen.queryByText("¿La plata de qué días está en la caja?")).not.toBeInTheDocument();
    expect(screen.queryAllByRole("checkbox")).toHaveLength(0);
  });
});
