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
const getAttendanceTodayMock = vi.fn();
const toastSuccess = vi.hoisted(() => vi.fn());

vi.mock("sonner", async () => {
  const actual = await vi.importActual<typeof import("sonner")>("sonner");
  return { ...actual, toast: { ...actual.toast, success: toastSuccess, error: vi.fn() } };
});

vi.mock("@/api/attendance", async () => {
  const actual = await vi.importActual<typeof import("@/api/attendance")>("@/api/attendance");
  return {
    ...actual,
    markAttendanceExit: (...args: unknown[]) => markAttendanceExitMock(...args),
    getAttendanceToday: () => getAttendanceTodayMock(),
  };
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

beforeEach(() => {
  getAttendanceTodayMock.mockReset();
  getAttendanceTodayMock.mockResolvedValue([]);
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

  // Movido a propósito (handoff POS, pantalla 1): la entrada ya no es un
  // aviso que se va solo; el panel del PIN la confirma con el check, la hora
  // y «Ir a {destino del rol}», y recién ahí se sigue.
  it("el primer PIN del día confirma la entrada («Entrada 7:02 a. m.») e «Ir a» el destino del rol", async () => {
    deviceIdentifyMock.mockResolvedValue({
      employee: { id: 7, name: "Ana Pérez", role: "operator", can_charge: false, puesto: "salon" },
      attendance: { id: 1, business_date: "2026-03-10", in_at: "2026-03-10T12:02:00Z", created: true },
    });
    const user = userEvent.setup();
    renderWithProviders(
      <Routes>
        <Route path="/pos/identify" element={<DeviceIdentifyPage />} />
        <Route path="/pos" element={<p>inicio-por-puesto</p>} />
      </Routes>,
      { me: { kind: "device", features: { "pos.tables": true } }, route: "/pos/identify" },
    );

    await user.click(await screen.findByRole("radio", { name: "Ana Pérez, Operador" }));
    await user.keyboard("1234");

    expect(await screen.findByText("Entrada 7:02 a. m.")).toBeInTheDocument();
    expect(screen.getByText(/Hola, Ana\. Quedó marcada tu entrada\. Seguís a Mesas\./)).toBeInTheDocument();
    expect(screen.queryByText("inicio-por-puesto")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Ir a Mesas" }));
    expect(await screen.findByText("inicio-por-puesto")).toBeInTheDocument();
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

    // Movido a propósito (handoff POS, pantalla 1): «Marcar salida» vive en el
    // menú «⋯» de la cabecera.
    await user.click(await screen.findByRole("button", { name: "Más opciones" }));
    await user.click(await screen.findByRole("menuitem", { name: "Marcar salida" }));
    expect(await screen.findByRole("heading", { name: "Marcar salida" })).toBeInTheDocument();
    await user.click(await screen.findByRole("radio", { name: "Ana Pérez, Operador" }));
    await user.keyboard("1234");

    await vi.waitFor(() => expect(markAttendanceExitMock).toHaveBeenCalledWith({ employee_id: 7, pin: "1234" }));
    expect(deviceIdentifyMock).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(toastSuccess).toHaveBeenCalledWith("Salida 3:30 p. m. · Ana Pérez"));
  });

  // Movido a propósito (handoff POS, pantalla 1): la puerta del
  // administrador pasó del pie al menú «⋯» (320 px, filas de 56 px).
  it("tiene la puerta del administrador, en el menú «⋯»", async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <Routes>
        <Route path="/pos/identify" element={<DeviceIdentifyPage />} />
        <Route path="/login" element={<p>pantalla-login</p>} />
      </Routes>,
      { route: "/pos/identify" },
    );
    await user.click(await screen.findByRole("button", { name: "Más opciones" }));
    expect(await screen.findByRole("menuitem", { name: "Pantalla oscura" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Desactivar este dispositivo" })).toBeInTheDocument();
    await user.click(screen.getByRole("menuitem", { name: "Entrar como administrador" }));
    expect(await screen.findByText("pantalla-login")).toBeInTheDocument();
  });
});

describe("DeviceIdentifyPage — la grilla del handoff", () => {
  beforeEach(() => {
    listDeviceEmployeesMock.mockReset();
    deviceIdentifyMock.mockReset();
    getCurrentShiftMock.mockReset();
    getCurrentShiftMock.mockResolvedValue(null);
    listDeviceEmployeesMock.mockResolvedValue([
      { id: 7, name: "Laura Gómez", role: "operator" },
      { id: 8, name: "Kevin Ruiz", role: "operator" },
      { id: 9, name: "Beto Ruiz", role: "supervisor" },
    ]);
  });

  it("cada tarjeta dice la entrada de hoy (del servidor) o «Sin entrada hoy», con el puesto", async () => {
    getAttendanceTodayMock.mockResolvedValue([
      {
        id: 1,
        employee_id: 7,
        employee_name: "Laura Gómez",
        business_date: "2026-09-27",
        puesto: "salon",
        in_at: "2026-09-27T11:48:00Z",
        out_at: null,
        status: "open",
      },
    ]);
    const user = userEvent.setup();
    renderWithProviders(<DeviceIdentifyPage />, { me: { kind: "device", last_employee_id: 8, features: {} } });

    const laura = await screen.findByRole("radio", { name: "Laura Gómez, Salón" });
    expect(laura).toHaveTextContent("Entrada 6:48 a. m.");
    const kevin = screen.getByRole("radio", { name: "Kevin Ruiz, Operador" });
    expect(kevin).toHaveTextContent("Sin entrada hoy");
    // Quien no está hoy queda detrás de la tarjeta punteada.
    expect(screen.queryByRole("radio", { name: /Beto Ruiz/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Otra persona" }));
    expect(screen.getByRole("radio", { name: "Beto Ruiz, Supervisor" })).toBeInTheDocument();

    // Elegida: el panel de la derecha la nombra y habilita el teclado.
    await user.click(kevin);
    expect(screen.getByText("Operador · PIN de 4 dígitos")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Dígito 1" })).toBeEnabled();
  });

  it("sin respuesta de asistencia no inventa «Sin entrada hoy»", async () => {
    getAttendanceTodayMock.mockRejectedValue(new ApiError(500, "INTERNAL", "caído"));
    renderWithProviders(<DeviceIdentifyPage />);
    const laura = await screen.findByRole("radio", { name: "Laura Gómez, Operador" });
    expect(laura).not.toHaveTextContent(/entrada/i);
  });

  it("el mensaje de PIN incorrecto llega del servidor y se muestra tal cual", async () => {
    deviceIdentifyMock.mockRejectedValue(new ApiError(400, "PIN_INVALID", "PIN incorrecto · te quedan 4 intentos"));
    const user = userEvent.setup();
    renderWithProviders(<DeviceIdentifyPage />);
    await user.click(await screen.findByRole("radio", { name: "Laura Gómez, Operador" }));
    await user.keyboard("0000");
    expect(await screen.findByRole("alert")).toHaveTextContent("PIN incorrecto · te quedan 4 intentos");
  });
});
