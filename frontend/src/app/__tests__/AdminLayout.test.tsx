import { screen } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

import { buildMe, renderWithProviders } from "@/test/utils";

import AdminLayout from "../AdminLayout";

vi.mock("@/api/stores", async () => {
  const actual = await vi.importActual<typeof import("@/api/stores")>("@/api/stores");
  return { ...actual, listStores: vi.fn().mockResolvedValue([]) };
});

vi.mock("@/features/notifications/NotificationBell", () => ({
  NotificationBell: () => null,
}));

vi.mock("@/features/shifts", () => ({
  shiftsFeature: {
    posRoutes: [],
    adminRoutes: [],
    adminNav: [{ to: "/admin/shifts", label: "Turnos y personal", feature: "cash.handovers" }],
    posNav: [],
    ShiftStatusStrip: () => null,
  },
}));

vi.mock("@/features/catalog", () => ({
  catalogFeature: {
    adminRoutes: [],
    adminNav: [{ to: "/admin/carta", label: "Carta" }],
  },
}));

function renderAdmin(me: ReturnType<typeof buildMe>) {
  return renderWithProviders(
    <Routes>
      <Route path="/admin" element={<AdminLayout />}>
        <Route index element={<div>contenido</div>} />
      </Route>
    </Routes>,
    { me, route: "/admin" },
  );
}

describe("AdminLayout: sidebar por features", () => {
  it("oculta una entrada de navegación cuya feature está apagada", async () => {
    renderAdmin(buildMe({ features: { "cash.handovers": false } }));

    expect(await screen.findByRole("link", { name: "Carta" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Turnos y personal" })).not.toBeInTheDocument();
  });

  it("muestra la entrada cuando su feature está encendida", async () => {
    renderAdmin(buildMe({ features: { "cash.handovers": true } }));

    expect(await screen.findByRole("link", { name: "Turnos y personal" })).toBeInTheDocument();
  });

  it("una entrada sin `feature` siempre se muestra (Funciones, Configuración…)", async () => {
    renderAdmin(buildMe({ features: {} }));

    expect(await screen.findByRole("link", { name: "Funciones" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Configuración" })).toBeInTheDocument();
  });
});
