import { screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

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
