import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Me } from "@/api/auth";
import { ApiError } from "@/api/client";
import type { SessionContextValue } from "@/app/session";
import { renderWithProviders } from "@/test/utils";

import PosLayout from "../PosLayout";

const deviceDeactivate = vi.hoisted(() => vi.fn());

vi.mock("@/api/auth", async () => {
  const actual = await vi.importActual<typeof import("@/api/auth")>("@/api/auth");
  return { ...actual, deviceDeactivate };
});

beforeEach(() => {
  deviceDeactivate.mockReset();
  deviceDeactivate.mockResolvedValue(undefined);
});

vi.mock("@/features/orders", () => ({
  ordersFeature: {
    posRoutes: [],
    adminRoutes: [],
    adminNav: [],
    posNav: [
      { to: "/pos/mesas", label: "Mesas", feature: "pos.tables" },
      { to: "/pos/comanda/nueva", label: "Comanda" },
      { to: "/pos/cocina", label: "Cocina", feature: "kitchen.view" },
    ],
  },
}));

vi.mock("@/features/shifts", () => ({
  shiftsFeature: {
    posRoutes: [],
    adminRoutes: [],
    adminNav: [],
    posNav: [{ to: "/pos/turno", label: "Turno" }],
    ShiftStatusStrip: () => <div data-testid="shift-status-strip" />,
  },
}));

function deviceMe(features: Record<string, boolean>): Me {
  return {
    kind: "device",
    store: { id: 1, name: "Sede Centro", cutoff_hour: 6, active_channels: [] },
    employee: { id: 7, name: "Ana", role: "operator", can_charge: false },
    organization: { id: 1, name: "Organización de prueba" },
    features,
  };
}

function renderLayout(
  features: Record<string, boolean>,
  session?: Partial<SessionContextValue>,
) {
  return renderWithProviders(
    <Routes>
      <Route path="/pos" element={<PosLayout />}>
        <Route index element={<div>contenido</div>} />
      </Route>
    </Routes>,
    { route: "/pos", me: deviceMe(features), session },
  );
}

describe("PosLayout — barra de navegación del POS filtrada por flags", () => {
  it("muestra Mesas y Turno, oculta Cocina, con pos.tables encendida y kitchen.view apagada", async () => {
    renderLayout({ "pos.tables": true, "kitchen.view": false });

    expect(await screen.findByRole("link", { name: "Mesas" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Comanda" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Turno" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Cocina" })).not.toBeInTheDocument();
  });

  it("muestra Cocina cuando kitchen.view está encendida", async () => {
    renderLayout({ "pos.tables": false, "kitchen.view": true });

    expect(await screen.findByRole("link", { name: "Cocina" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Mesas" })).not.toBeInTheDocument();
  });

  it("mantiene ShiftStatusStrip y «Cambiar de persona»", async () => {
    renderLayout({});

    expect(await screen.findByTestId("shift-status-strip")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /cambiar de persona/i })).toBeInTheDocument();
  });
});

describe("PosLayout — la salida del dispositivo", () => {
  // «Cambiar de persona» libera a la persona; el dispositivo sigue activado.
  // Para mover la tablet a otra sede, o cuando se activó la equivocada, hacía
  // falta desactivar el dispositivo y no existía en ninguna pantalla:
  // `deviceDeactivate()` estaba en `src/api/auth.ts` sin un solo llamador.
  it("hay un control para desactivar el dispositivo, aparte de «Cambiar de persona»", async () => {
    renderLayout({});

    expect(
      await screen.findByRole("button", { name: /desactivar este dispositivo/i }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /cambiar de persona/i })).toBeInTheDocument();
  });

  it("un solo toque NO desactiva: primero hay que confirmar", async () => {
    // En una tablet compartida, desactivar por error deja al salón sin poder
    // vender hasta que aparezca alguien con el PIN de sede.
    const user = userEvent.setup();
    renderLayout({});

    await user.click(await screen.findByRole("button", { name: /desactivar este dispositivo/i }));

    expect(deviceDeactivate).not.toHaveBeenCalled();
    expect(await screen.findByText(/PIN de sede/i)).toBeInTheDocument();
  });

  it("confirmando, desactiva en el servidor y recién entonces olvida la sesión", async () => {
    const clear = vi.fn();
    const user = userEvent.setup();
    renderLayout({}, { clear });

    await user.click(await screen.findByRole("button", { name: /desactivar este dispositivo/i }));
    await user.click(await screen.findByRole("button", { name: /^desactivar$/i }));

    await waitFor(() => expect(deviceDeactivate).toHaveBeenCalledTimes(1));
    expect(clear).toHaveBeenCalledTimes(1);
  });

  it("si el servidor falla, el dispositivo NO se da por desactivado", async () => {
    deviceDeactivate.mockRejectedValue(new ApiError(500, "UNKNOWN_ERROR", "Error del servidor"));
    const clear = vi.fn();
    const user = userEvent.setup();
    renderLayout({}, { clear });

    await user.click(await screen.findByRole("button", { name: /desactivar este dispositivo/i }));
    await user.click(await screen.findByRole("button", { name: /^desactivar$/i }));

    await waitFor(() => expect(deviceDeactivate).toHaveBeenCalledTimes(1));
    expect(clear).not.toHaveBeenCalled();
  });
});
