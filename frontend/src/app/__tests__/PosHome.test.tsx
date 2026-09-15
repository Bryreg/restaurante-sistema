import { screen } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";
import { describe, expect, it } from "vitest";

import { buildMe, renderWithProviders } from "@/test/utils";

import PosHome from "../PosHome";

function renderPosHome(features: Record<string, boolean>) {
  return renderWithProviders(
    <Routes>
      <Route path="/" element={<PosHome />} />
      <Route path="/pos/mesas" element={<div>Mapa de mesas</div>} />
      <Route path="/pos/comanda/nueva" element={<div>Comanda nueva</div>} />
    </Routes>,
    { route: "/", me: buildMe({ kind: "device", features }) },
  );
}

describe("PosHome — ruta índice de /pos", () => {
  it("con pos.tables encendida, redirige a /pos/mesas", async () => {
    renderPosHome({ "pos.tables": true });
    expect(await screen.findByText("Mapa de mesas")).toBeInTheDocument();
  });

  it("con pos.tables apagada, redirige directo a comanda de mostrador", async () => {
    renderPosHome({ "pos.tables": false });
    expect(await screen.findByText("Comanda nueva")).toBeInTheDocument();
  });
});
