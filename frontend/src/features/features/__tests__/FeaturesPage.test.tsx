import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "@/api/client";
import { buildMe, renderWithProviders } from "@/test/utils";

import FeaturesPage from "../FeaturesPage";

vi.mock("@/api/stores", async () => {
  const actual = await vi.importActual<typeof import("@/api/stores")>("@/api/stores");
  return {
    ...actual,
    getOrganization: vi.fn().mockResolvedValue({ id: 1, name: "Org de prueba", profile: "standard" }),
  };
});

const setFeatureMock = vi.fn();
vi.mock("@/api/features", async () => {
  const actual = await vi.importActual<typeof import("@/api/features")>("@/api/features");
  return {
    ...actual,
    listFeatures: vi.fn().mockResolvedValue([
      {
        key: "pos.daily_menu",
        description: "Menú del día con opciones por día y franja",
        enabled: false,
        source: "profile_default",
        requires: ["pos.combos"],
        available_from_phase: "1a",
      },
    ]),
    setFeature: (...args: Parameters<typeof actual.setFeature>) => setFeatureMock(...args),
  };
});

describe("FeaturesPage", () => {
  beforeEach(() => {
    setFeatureMock.mockReset();
  });

  it("muestra el mensaje de FEATURE_DEPENDENCY que manda el servidor al prender una función sin su dependencia", async () => {
    setFeatureMock.mockRejectedValueOnce(
      new ApiError(
        400,
        "FEATURE_DEPENDENCY",
        '"pos.daily_menu" necesita que "pos.combos" esté habilitada primero',
        { feature: "pos.daily_menu", requires: "pos.combos" },
      ),
    );

    const user = userEvent.setup();
    renderWithProviders(<FeaturesPage />, { me: buildMe() });

    const toggle = await screen.findByRole("switch", { name: /encender pos\.daily_menu/i });
    await user.click(toggle);

    expect(
      await screen.findByText('"pos.daily_menu" necesita que "pos.combos" esté habilitada primero'),
    ).toBeInTheDocument();
  });

  it("muestra clave, descripción, origen, dependencias y fase de cada función", async () => {
    renderWithProviders(<FeaturesPage />, { me: buildMe() });

    expect(await screen.findByText("pos.daily_menu")).toBeInTheDocument();
    expect(screen.getByText("Menú del día con opciones por día y franja")).toBeInTheDocument();
    expect(screen.getByText("Default del perfil")).toBeInTheDocument();
    expect(screen.getByText("pos.combos")).toBeInTheDocument();
    expect(screen.getByText("1a")).toBeInTheDocument();
  });
});
