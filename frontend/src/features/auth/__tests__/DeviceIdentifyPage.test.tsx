import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Me } from "@/api/auth";
import { ApiError } from "@/api/client";
import { renderWithProviders } from "@/test/utils";

import DeviceIdentifyPage from "../DeviceIdentifyPage";

const listDeviceEmployeesMock = vi.fn();
const deviceIdentifyMock = vi.fn();
const getCurrentShiftMock = vi.fn();
const markAttendanceExitMock = vi.fn();
const toastSuccess = vi.hoisted(() => vi.fn());

vi.mock("sonner", async () => {
  const actual = await vi.importActual<typeof import("sonner")>("sonner");
  return { ...actual, toast: { ...actual.toast, success: toastSuccess, error: vi.fn() } };
});

vi.mock("@/api/attendance", async () => {
  const actual = await vi.importActual<typeof import("@/api/attendance")>("@/api/attendance");
  return { ...actual, markAttendanceExit: (...args: unknown[]) => markAttendanceExitMock(...args) };
});

vi.mock("@/api/shifts", async () => {
  const actual = await vi.importActual<typeof import("@/api/shifts")>("@/api/shifts");
  return { ...actual, getCurrentShift: () => getCurrentShiftMock() };
});

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
    getCurrentShiftMock.mockReset();
    getCurrentShiftMock.mockResolvedValue(null);
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

describe("DeviceIdentifyPage — inicio por rol", () => {
  const TABLET: Me = {
    kind: "device",
    store: { id: 1, name: "Sede Centro", cutoff_hour: 6, active_channels: [] },
    employee: null,
    last_employee_id: 12,
    organization: { id: 1, name: "Organización de prueba" },
    features: {},
  };

  beforeEach(() => {
    listDeviceEmployeesMock.mockReset();
    deviceIdentifyMock.mockReset();
    getCurrentShiftMock.mockReset();
    listDeviceEmployeesMock.mockResolvedValue([
      { id: 7, name: "Ana Pérez", role: "operator" },
      { id: 9, name: "Beto Ruiz", role: "supervisor" },
      { id: 12, name: "María Fernanda de los Ríos Ocampo", role: "operator" },
    ]);
    getCurrentShiftMock.mockResolvedValue({
      id: 42,
      business_date: "2026-09-14",
      opened_at: "2026-09-14T13:00:00Z",
      cash_responsible: { id: 7, name: "Ana Pérez" },
      roster: [{ employee_id: 7, employee_name: "Ana Pérez", in_at: "2026-09-14T13:00:00Z", out_at: null }],
    });
  });

  it("primero la última persona de la tablet y las del turno; el resto detrás de «Otra persona»", async () => {
    const user = userEvent.setup();
    renderWithProviders(<DeviceIdentifyPage />, { me: TABLET });

    // El nombre completo, sin recortar.
    expect(await screen.findByRole("radio", { name: "María Fernanda de los Ríos Ocampo, Operador" })).toBeInTheDocument();
    expect(await screen.findByRole("radio", { name: "Ana Pérez, Operador" })).toBeInTheDocument();
    expect(screen.queryByRole("radio", { name: "Beto Ruiz, Supervisor" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Otra persona" }));
    expect(screen.getByRole("radio", { name: "Beto Ruiz, Supervisor" })).toBeInTheDocument();
  });

  it("después del PIN vuelve a la pantalla de ?next=", async () => {
    deviceIdentifyMock.mockResolvedValue({ employee: { id: 7, name: "Ana Pérez", role: "operator", can_charge: true } });
    const user = userEvent.setup();
    renderWithProviders(
      <Routes>
        <Route path="/pos/identify" element={<DeviceIdentifyPage />} />
        <Route path="/pos/turno" element={<p>pantalla-turno</p>} />
        <Route path="/pos" element={<p>inicio-por-puesto</p>} />
      </Routes>,
      { me: TABLET, route: `/pos/identify?next=${encodeURIComponent("/pos/turno?accion=relevo")}` },
    );

    await user.click(await screen.findByRole("radio", { name: "Ana Pérez, Operador" }));
    await user.keyboard("1234");

    expect(await screen.findByText("pantalla-turno")).toBeInTheDocument();
  });

  it("sin ?next= (o uno de afuera) va a /pos, que decide por el puesto", async () => {
    deviceIdentifyMock.mockResolvedValue({ employee: { id: 7, name: "Ana Pérez", role: "operator", can_charge: true } });
    const user = userEvent.setup();
    renderWithProviders(
      <Routes>
        <Route path="/pos/identify" element={<DeviceIdentifyPage />} />
        <Route path="/pos" element={<p>inicio-por-puesto</p>} />
      </Routes>,
      { me: TABLET, route: `/pos/identify?next=${encodeURIComponent("https://otro.example/pos/turno")}` },
    );

    await user.click(await screen.findByRole("radio", { name: "Ana Pérez, Operador" }));
    await user.keyboard("1234");

    expect(await screen.findByText("inicio-por-puesto")).toBeInTheDocument();
  });
});

describe("DeviceIdentifyPage — asistencia del día", () => {
  beforeEach(() => {
    listDeviceEmployeesMock.mockReset();
    deviceIdentifyMock.mockReset();
    markAttendanceExitMock.mockReset();
    toastSuccess.mockReset();
    getCurrentShiftMock.mockReset();
    getCurrentShiftMock.mockResolvedValue(null);
    listDeviceEmployeesMock.mockResolvedValue([{ id: 7, name: "Ana Pérez", role: "operator" }]);
  });

  it("el primer PIN del día avisa la hora de entrada («Entrada 7:02 a. m.»)", async () => {
    deviceIdentifyMock.mockResolvedValue({
      employee: { id: 7, name: "Ana Pérez", role: "operator", can_charge: false },
      attendance: { id: 1, business_date: "2026-03-10", in_at: "2026-03-10T12:02:00Z", created: true },
    });
    const user = userEvent.setup();
    renderWithProviders(<DeviceIdentifyPage />);

    await user.click(await screen.findByRole("radio", { name: "Ana Pérez, Operador" }));
    await user.keyboard("1234");

    await vi.waitFor(() => expect(toastSuccess).toHaveBeenCalledWith("Entrada 7:02 a. m."));
  });

  it("«Marcar salida» abajo: nombre + PIN marca la salida sin identificarse", async () => {
    markAttendanceExitMock.mockResolvedValue({
      id: 1,
      employee_id: 7,
      employee_name: "Ana Pérez",
      business_date: "2026-03-10",
      in_at: "2026-03-10T12:02:00Z",
      out_at: "2026-03-10T20:30:00Z",
      status: "closed",
    });
    const user = userEvent.setup();
    renderWithProviders(<DeviceIdentifyPage />);

    await user.click(await screen.findByRole("button", { name: "Marcar salida" }));
    expect(await screen.findByRole("heading", { name: "Marcar salida" })).toBeInTheDocument();
    await user.click(await screen.findByRole("radio", { name: "Ana Pérez, Operador" }));
    await user.keyboard("1234");

    await vi.waitFor(() => expect(markAttendanceExitMock).toHaveBeenCalledWith({ employee_id: 7, pin: "1234" }));
    expect(deviceIdentifyMock).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(toastSuccess).toHaveBeenCalledWith("Salida 3:30 p. m. · Ana Pérez"));
  });

  it("tiene la puerta del administrador, chica y secundaria", async () => {
    renderWithProviders(<DeviceIdentifyPage />);
    expect(await screen.findByRole("link", { name: "Entrar como administrador" })).toHaveAttribute("href", "/login");
  });
});
