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

describe("OpenShiftForm — base y sobres de días anteriores, aparte (auditoría de tablet)", () => {
  const CANDIDATES = [
    { shift_id: 11, business_date: "2026-09-21", outstanding: 350_000 },
    { shift_id: 12, business_date: "2026-09-22", outstanding: 74_000 },
  ];

  it("cada sobre se confirma con un botón grande «Está · monto del servidor», ninguno confirmado de entrada", async () => {
    getCarryCandidatesMock.mockResolvedValue(CANDIDATES);
    renderWithProviders(<OpenShiftForm />, { me: deviceMe({ "money.deposits": true }) });

    expect(await screen.findByText("Sobres de días anteriores")).toBeInTheDocument();
    const esta = screen.getAllByRole("button", { name: /^Está · / });
    expect(esta).toHaveLength(2);
    for (const b of esta) expect(b).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: "Está · $ 350.000" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Está · $ 74.000" })).toBeInTheDocument();
    // Ni casillas de 16 px ni un total armado en el cliente.
    expect(screen.queryAllByRole("checkbox")).toHaveLength(0);
    expect(screen.queryByText("$ 424.000")).not.toBeInTheDocument();
  });

  it("manda la base sola con los días confirmados y `carried_counted_apart`", async () => {
    getCarryCandidatesMock.mockResolvedValue(CANDIDATES);
    openShiftMock.mockResolvedValue({ id: 99 });
    const user = userEvent.setup();
    renderWithProviders(<OpenShiftForm />, { me: deviceMe({ "money.deposits": true }) });

    await screen.findByText("Sobres de días anteriores");
    await screen.findByRole("radio", { name: /ana, operador/i });
    // La base con el teclado en pantalla: 4 billetes de $50.000.
    await user.click(screen.getByRole("button", { name: /^\$ 50\.000: sin contar/ }));
    await user.click(screen.getByRole("button", { name: "4" }));
    await user.click(screen.getByRole("button", { name: "Está · $ 74.000" }));
    expect(screen.getByRole("button", { name: "Está · $ 74.000" })).toHaveAttribute("aria-pressed", "true");
    await user.click(screen.getByRole("button", { name: "Abrir turno" }));

    await waitFor(() => expect(openShiftMock).toHaveBeenCalledTimes(1));
    expect(openShiftMock.mock.calls[0]?.[0]).toMatchObject({
      opening_cash: { total: 200_000 },
      carried_shift_ids: [12],
      carried_counted_apart: true,
    });
  });

  it("si la base no cuadra: mensaje del servidor, causa con botones, y el error se borra al corregir", async () => {
    getCarryCandidatesMock.mockResolvedValue(CANDIDATES);
    const serverMessage =
      "La base contada ($ 0) no coincide con la base fija ($ 200.000). Volvé a contarla o elegí una causa para poder abrir el turno";
    openShiftMock.mockRejectedValue(new ApiError(400, "OPENING_DIFFERENCE_NEEDS_CAUSE", serverMessage));
    const user = userEvent.setup();
    renderWithProviders(<OpenShiftForm />, { me: deviceMe({ "money.deposits": true }) });

    await screen.findByText("Sobres de días anteriores");
    await screen.findByRole("radio", { name: /ana, operador/i });
    await user.click(screen.getByRole("button", { name: "Abrir turno" }));

    expect(await screen.findByText(serverMessage)).toBeInTheDocument();
    const causa = screen.getByRole("radio", { name: "Error de conteo" });
    await user.click(causa);
    expect(causa).toHaveAttribute("aria-checked", "true");

    // Corrige el conteo: el error viejo desaparece.
    await user.click(screen.getByRole("button", { name: "Sumar un billete de $ 50.000" }));
    expect(screen.queryByText(serverMessage)).not.toBeInTheDocument();
    expect(screen.queryByRole("radio", { name: "Error de conteo" })).not.toBeInTheDocument();
  });

  it("con Consignaciones apagada no pide la lista ni muestra la sección", async () => {
    renderWithProviders(<OpenShiftForm />, { me: deviceMe({ "money.deposits": false }) });

    await screen.findByRole("radio", { name: /ana, operador/i });
    expect(getCarryCandidatesMock).not.toHaveBeenCalled();
    expect(screen.queryByText("Sobres de días anteriores")).not.toBeInTheDocument();
  });

  it("con Consignaciones encendida pero sin días por consignar, no hay sobres", async () => {
    getCarryCandidatesMock.mockResolvedValue([]);
    renderWithProviders(<OpenShiftForm />, { me: deviceMe({ "money.deposits": true }) });

    await waitFor(() => expect(getCarryCandidatesMock).toHaveBeenCalled());
    expect(screen.queryByText("Sobres de días anteriores")).not.toBeInTheDocument();
    expect(screen.queryAllByRole("button", { name: /^Está · / })).toHaveLength(0);
  });
});
