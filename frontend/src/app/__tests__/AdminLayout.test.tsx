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

  it("integra Hoy, Ventas, Pedidos, Documentos fiscales (núcleo, sin flag) y Clientes según su feature — pedido 1b-2, sin mockear esos dominios", async () => {
    renderAdmin(buildMe({ features: { customers: true } }));

    expect(await screen.findByRole("link", { name: "Hoy" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Ventas" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Pedidos" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Documentos fiscales" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Rangos de numeración" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Clientes" })).toBeInTheDocument();
  });

  it("«Clientes» respeta su feature: apagada, no se muestra", async () => {
    renderAdmin(buildMe({ features: { customers: false } }));

    await screen.findByRole("link", { name: "Hoy" });
    expect(screen.queryByRole("link", { name: "Clientes" })).not.toBeInTheDocument();
  });

  it("«Inventario» (inventory.perpetual) y «Preparaciones» (catalog.preps) — pedido 2a: apagadas, no se muestran", async () => {
    renderAdmin(buildMe({ features: { "inventory.perpetual": false, "catalog.preps": false } }));

    await screen.findByRole("link", { name: "Hoy" });
    expect(screen.queryByRole("link", { name: "Inventario" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Preparaciones" })).not.toBeInTheDocument();
  });

  it("«Inventario» y «Preparaciones» aparecen cuando su feature está encendida", async () => {
    renderAdmin(buildMe({ features: { "inventory.perpetual": true, "catalog.preps": true } }));

    expect(await screen.findByRole("link", { name: "Inventario" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Preparaciones" })).toBeInTheDocument();
  });

  it("«Compras» (purchases) — pedido 2b: apagada, no se muestra", async () => {
    renderAdmin(buildMe({ features: { purchases: false } }));

    await screen.findByRole("link", { name: "Hoy" });
    expect(screen.queryByRole("link", { name: "Compras" })).not.toBeInTheDocument();
  });

  it("«Compras» aparece cuando purchases está encendida, y enlaza a /admin/compras", async () => {
    renderAdmin(buildMe({ features: { purchases: true } }));

    const link = await screen.findByRole("link", { name: "Compras" });
    expect(link).toBeInTheDocument();
    expect(link).toHaveAttribute("href", "/admin/compras");
  });
});
