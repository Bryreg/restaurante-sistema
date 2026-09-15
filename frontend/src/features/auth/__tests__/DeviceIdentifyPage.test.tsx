import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "@/api/client";
import { renderWithProviders } from "@/test/utils";

import DeviceIdentifyPage from "../DeviceIdentifyPage";

const listDeviceEmployeesMock = vi.fn();
const deviceIdentifyMock = vi.fn();

vi.mock("@/api/employees", async () => {
  const actual = await vi.importActual<typeof import("@/api/employees")>("@/api/employees");
  return { ...actual, listDeviceEmployees: () => listDeviceEmployeesMock() };
});

vi.mock("@/api/auth", async () => {
  const actual = await vi.importActual<typeof import("@/api/auth")>("@/api/auth");
  return { ...actual, deviceIdentify: (...args: Parameters<typeof actual.deviceIdentify>) => deviceIdentifyMock(...args) };
});

describe("DeviceIdentifyPage — Quién opera", () => {
  beforeEach(() => {
    listDeviceEmployeesMock.mockReset();
    deviceIdentifyMock.mockReset();
    listDeviceEmployeesMock.mockResolvedValue([
      { id: 7, name: "Ana Pérez", role: "operator" },
      { id: 9, name: "Beto Ruiz", role: "supervisor" },
    ]);
  });

  it("no tiene ningún input numérico: se elige la persona en la grilla", async () => {
    renderWithProviders(<DeviceIdentifyPage />);

    await screen.findByRole("radio", { name: "Ana Pérez, Operador" });
    expect(screen.queryByRole("spinbutton")).not.toBeInTheDocument();
    expect(screen.queryByText(/número de empleado/i)).not.toBeInTheDocument();
  });

  it("el PIN queda deshabilitado hasta elegir a alguien", async () => {
    renderWithProviders(<DeviceIdentifyPage />);

    await screen.findByRole("radio", { name: "Ana Pérez, Operador" });
    expect(screen.getByRole("button", { name: "Dígito 1" })).toBeDisabled();
  });

  it("elegir persona y PIN llama a deviceIdentify({employee_id, pin}) y navega a /pos", async () => {
    deviceIdentifyMock.mockResolvedValue({ employee: { id: 7, name: "Ana Pérez", role: "operator", can_charge: false } });
    const user = userEvent.setup();

    renderWithProviders(<DeviceIdentifyPage />);

    const anaRadio = await screen.findByRole("radio", { name: "Ana Pérez, Operador" });
    await user.click(anaRadio);
    expect(anaRadio).toHaveAttribute("aria-checked", "true");

    await user.keyboard("1234");

    expect(deviceIdentifyMock).toHaveBeenCalledWith({ employee_id: 7, pin: "1234" });
  });

  it("muestra PIN_LOCKED (u otro error del servidor) tal cual llega", async () => {
    deviceIdentifyMock.mockRejectedValue(new ApiError(400, "PIN_LOCKED", "PIN bloqueado: probá en 15 minutos"));
    const user = userEvent.setup();

    renderWithProviders(<DeviceIdentifyPage />);

    await user.click(await screen.findByRole("radio", { name: "Beto Ruiz, Supervisor" }));
    await user.keyboard("5001");

    expect(await screen.findByRole("alert")).toHaveTextContent("PIN bloqueado: probá en 15 minutos");
  });
});
