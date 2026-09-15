import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "@/api/client";

import { EmployeePicker } from "../EmployeePicker";

const listDeviceEmployeesMock = vi.fn();

vi.mock("@/api/employees", async () => {
  const actual = await vi.importActual<typeof import("@/api/employees")>("@/api/employees");
  return {
    ...actual,
    listDeviceEmployees: () => listDeviceEmployeesMock(),
  };
});

function withQueryClient(ui: ReactElement) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}

describe("EmployeePicker", () => {
  beforeEach(() => {
    listDeviceEmployeesMock.mockReset();
  });

  it("es un radiogroup con un radio por persona, con nombre y rol en español", async () => {
    listDeviceEmployeesMock.mockResolvedValue([
      { id: 1, name: "Ana Pérez", role: "operator" },
      { id: 2, name: "Beto Ruiz", role: "supervisor" },
    ]);

    withQueryClient(<EmployeePicker value={null} onChange={vi.fn()} label="Quién opera" />);

    expect(await screen.findByRole("radiogroup", { name: "Quién opera" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Ana Pérez, Operador" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Beto Ruiz, Supervisor" })).toBeInTheDocument();
  });

  it("nunca pide ni muestra documento, correo o límites de descuento", async () => {
    listDeviceEmployeesMock.mockResolvedValue([{ id: 1, name: "Ana Pérez", role: "operator" }]);

    withQueryClient(<EmployeePicker value={null} onChange={vi.fn()} label="Quién opera" />);

    await screen.findByRole("radio", { name: "Ana Pérez, Operador" });
    expect(screen.queryByText(/documento|correo|email|límite/i)).not.toBeInTheDocument();
  });

  it("llama a onChange con el id y el empleado elegido, y marca aria-checked", async () => {
    listDeviceEmployeesMock.mockResolvedValue([
      { id: 1, name: "Ana Pérez", role: "operator" },
      { id: 2, name: "Beto Ruiz", role: "supervisor" },
    ]);
    const onChange = vi.fn();
    const user = userEvent.setup();

    withQueryClient(<EmployeePicker value={null} onChange={onChange} label="Quién opera" />);

    const anaRadio = await screen.findByRole("radio", { name: "Ana Pérez, Operador" });
    expect(anaRadio).toHaveAttribute("aria-checked", "false");
    await user.click(anaRadio);

    expect(onChange).toHaveBeenCalledWith(1, { id: 1, name: "Ana Pérez", role: "operator" });
  });

  it("filtra por roles y excludeIds", async () => {
    listDeviceEmployeesMock.mockResolvedValue([
      { id: 1, name: "Ana Pérez", role: "operator" },
      { id: 2, name: "Beto Ruiz", role: "supervisor" },
      { id: 3, name: "Cami Soto", role: "admin" },
    ]);

    withQueryClient(
      <EmployeePicker value={null} onChange={vi.fn()} label="Autorizador" roles={["supervisor", "admin"]} excludeIds={[3]} />,
    );

    expect(await screen.findByRole("radio", { name: "Beto Ruiz, Supervisor" })).toBeInTheDocument();
    expect(screen.queryByRole("radio", { name: /ana pérez/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("radio", { name: /cami soto/i })).not.toBeInTheDocument();
  });

  it("muestra un estado de error con reintento", async () => {
    listDeviceEmployeesMock.mockRejectedValueOnce(new ApiError(500, "UNKNOWN_ERROR", "Error del servidor. Intentá de nuevo."));
    listDeviceEmployeesMock.mockResolvedValueOnce([{ id: 1, name: "Ana Pérez", role: "operator" }]);
    const user = userEvent.setup();

    withQueryClient(<EmployeePicker value={null} onChange={vi.fn()} label="Quién opera" />);

    expect(await screen.findByRole("alert")).toHaveTextContent(/no se pudo cargar el personal/i);
    await user.click(screen.getByRole("button", { name: /reintentar/i }));

    expect(await screen.findByRole("radio", { name: "Ana Pérez, Operador" })).toBeInTheDocument();
  });

  it("muestra un estado vacío cuando no hay nadie para elegir", async () => {
    listDeviceEmployeesMock.mockResolvedValue([]);

    withQueryClient(<EmployeePicker value={null} onChange={vi.fn()} label="Quién opera" />);

    expect(await screen.findByText(/no hay nadie disponible/i)).toBeInTheDocument();
  });
});
