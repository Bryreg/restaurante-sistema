import { screen } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

import type { Me } from "@/api/auth";
import { renderWithProviders } from "@/test/utils";

import PosLayout from "../PosLayout";

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

function renderLayout(features: Record<string, boolean>) {
  return renderWithProviders(
    <Routes>
      <Route path="/pos" element={<PosLayout />}>
        <Route index element={<div>contenido</div>} />
      </Route>
    </Routes>,
    { route: "/pos", me: deviceMe(features) },
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
