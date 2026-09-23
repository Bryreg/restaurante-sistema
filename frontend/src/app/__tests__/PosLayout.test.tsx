import { screen, waitFor, within } from "@testing-library/react";
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
      { to: "/pos/comanda/nueva", label: "Mostrador" },
      { to: "/pos/cocina", label: "Cocina", feature: "kitchen.view", posGroup: "cocina" },
    ],
  },
}));

vi.mock("@/features/shifts", () => ({
  shiftsFeature: {
    posRoutes: [],
    adminRoutes: [],
    adminNav: [],
    posNav: [{ to: "/pos/turno", label: "Turno", posGroup: "caja" }],
    ShiftStatusStrip: () => <div data-testid="shift-status-strip" />,
  },
}));

type Employee = NonNullable<Me["employee"]>;

const MESERO: Employee = { id: 7, name: "Ana", role: "operator", can_charge: false };
const CAJERA: Employee = { id: 8, name: "Luz Marina", role: "operator", can_charge: true };
const SUPERVISOR: Employee = { id: 9, name: "Rosa", role: "supervisor", can_charge: false };

function deviceMe(features: Record<string, boolean>, employee: Employee = MESERO): Me {
  return {
    kind: "device",
    store: { id: 1, name: "Sede Centro", cutoff_hour: 6, active_channels: [] },
    employee,
    organization: { id: 1, name: "Organización de prueba" },
    features,
  };
}

function renderLayout(
  features: Record<string, boolean>,
  session?: Partial<SessionContextValue>,
  employee?: Employee,
) {
  return renderWithProviders(
    <Routes>
      <Route path="/pos" element={<PosLayout />}>
        <Route index element={<div>contenido</div>} />
      </Route>
    </Routes>,
    { route: "/pos", me: deviceMe(features, employee), session },
  );
}

/** Los rótulos de la barra del salón, en el orden en que se ven. */
async function rotulosDeLaBarra(): Promise<string[]> {
  const barra = await screen.findByRole("navigation", { name: "Secciones del salón" });
  return within(barra)
    .getAllByRole("link")
    .map((link) => link.textContent ?? "");
}

const TODO_ENCENDIDO = {
  "pos.tables": true,
  "kitchen.view": true,
  "kitchen.kds": true,
  "catalog.preps": true,
  "inventory.waste": true,
};

describe("PosLayout — la barra del salón la decide quién se identificó", () => {
  it("el mesero también ve Turno: ahí marca su entrada, salida y pausa", async () => {
    renderLayout({ "pos.tables": true }, undefined, MESERO);

    expect(await rotulosDeLaBarra()).toEqual(["Mesas", "Mostrador", "Turno"]);
  });

  it("la cajera (can_charge) suma Turno, después de la venta", async () => {
    renderLayout({ "pos.tables": true }, undefined, CAJERA);

    expect(await rotulosDeLaBarra()).toEqual(["Mesas", "Mostrador", "Turno"]);
  });

  it("supervisor sin can_charge también ve Turno: vigila la caja aunque no cobre", async () => {
    renderLayout({ "pos.tables": true }, undefined, SUPERVISOR);

    expect(await rotulosDeLaBarra()).toContain("Turno");
  });

  it("orden: venta → caja → cocina, y la cocina en su orden", async () => {
    renderLayout(TODO_ENCENDIDO, undefined, CAJERA);

    expect(await rotulosDeLaBarra()).toEqual([
      "Mesas",
      "Mostrador",
      "Turno",
      "Cocina",
      "Tiquetes de cocina",
      "Producción",
      "Merma",
    ]);
  });

  it("una función apagada no deja hueco: la entrada simplemente no está", async () => {
    renderLayout({ "pos.tables": false, "kitchen.view": true }, undefined, MESERO);

    expect(await rotulosDeLaBarra()).toEqual(["Mostrador", "Turno", "Cocina"]);
  });

  it("con las dos vistas de cocina encendidas no hay dos «Cocina» iguales", async () => {
    renderLayout(TODO_ENCENDIDO, undefined, MESERO);

    const rotulos = await rotulosDeLaBarra();
    expect(new Set(rotulos).size).toBe(rotulos.length);
  });

  it("los botones de la barra son objetivos de salón (min-h-14, ≥ 56 px)", async () => {
    renderLayout({ "pos.tables": true }, undefined, CAJERA);

    await rotulosDeLaBarra();
    for (const link of within(screen.getByRole("navigation", { name: "Secciones del salón" })).getAllByRole("link")) {
      expect(link.className).toMatch(/\bmin-h-14\b/);
    }
  });

  it("sin persona identificada no hay entradas de operación", async () => {
    renderWithProviders(
      <Routes>
        <Route path="/pos" element={<PosLayout />}>
          <Route index element={<div>contenido</div>} />
        </Route>
        <Route path="/pos/identify" element={<div>Identificate</div>} />
      </Routes>,
      { route: "/pos", me: { ...deviceMe(TODO_ENCENDIDO), employee: null } },
    );

    expect(await screen.findByText("Identificate")).toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "Secciones del salón" })).not.toBeInTheDocument();
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
