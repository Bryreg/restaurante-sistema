import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Me } from "@/api/auth";
import { buildMe, renderWithProviders } from "@/test/utils";

import HomePage from "../HomePage";

const logout = vi.hoisted(() => vi.fn());

vi.mock("@/api/auth", async () => {
  const actual = await vi.importActual<typeof import("@/api/auth")>("@/api/auth");
  return { ...actual, logout };
});

beforeEach(() => {
  logout.mockReset();
  logout.mockResolvedValue(undefined);
});

const DEVICE: Me = {
  kind: "device",
  store: { id: 1, name: "Sede Centro", cutoff_hour: 6, active_channels: [] },
  organization: { id: 1, name: "Org" },
  features: {},
};

describe("HomePage — la puerta: Operar (POS) o Administrar", () => {
  it("sin sesión: operar lleva a activar la tablet y administrar al formulario", async () => {
    renderWithProviders(<HomePage />);
    expect(await screen.findByRole("link", { name: /operar \(pos\)/i })).toHaveAttribute("href", "/pos/activate");
    expect(screen.getByRole("link", { name: /administrar/i })).toHaveAttribute("href", "/login");
  });

  it("en una tablet activada: operar va al salón", async () => {
    renderWithProviders(<HomePage />, { me: DEVICE });
    expect(await screen.findByRole("link", { name: /operar \(pos\)/i })).toHaveAttribute("href", "/pos");
    expect(screen.getByRole("link", { name: /administrar/i })).toHaveAttribute("href", "/login");
  });

  it("con admin abierto en PC: administrar va directo al admin", async () => {
    renderWithProviders(<HomePage />, { me: buildMe() });
    expect(await screen.findByRole("link", { name: /administrar/i })).toHaveAttribute("href", "/admin");
  });

  it("con la sesión corta de admin en la tablet: operar la cierra, relee la sesión y vuelve a «Quién opera»", async () => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();
    renderWithProviders(
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/pos/identify" element={<p>Quién opera</p>} />
      </Routes>,
      { me: buildMe({ on_device: true }), session: { refresh } },
    );

    await user.click(await screen.findByRole("button", { name: /operar \(pos\)/i }));

    await waitFor(() => expect(logout).toHaveBeenCalledTimes(1));
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(await screen.findByText("Quién opera")).toBeInTheDocument();
  });
});
