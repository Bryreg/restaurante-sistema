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

describe("FeaturesPage — flags nuevos del pedido 1b-1", () => {
  it("muestra los flags de comanda y cobro de 1b-1 con su dependencia, desde GET /admin/features", async () => {
    const { listFeatures } = await import("@/api/features");
    vi.mocked(listFeatures).mockResolvedValueOnce([
      { key: "pos.tables", description: "Venta por mesas", enabled: false, source: "profile_default", requires: [], available_from_phase: "1b" },
      { key: "pos.seats", description: "Asiento por ítem", enabled: false, source: "profile_default", requires: ["pos.tables"], available_from_phase: "1b" },
      { key: "pos.courses", description: "Cursos del plato", enabled: false, source: "profile_default", requires: ["kitchen.view"], available_from_phase: "1b" },
      { key: "pos.pre_bill", description: "Precuenta", enabled: false, source: "profile_default", requires: [], available_from_phase: "1b" },
      { key: "pos.split_bill", description: "División de cuenta", enabled: false, source: "profile_default", requires: [], available_from_phase: "1b" },
      { key: "pos.tips", description: "Pregunta de propina", enabled: false, source: "profile_default", requires: [], available_from_phase: "1b" },
      { key: "pos.discounts", description: "Descuentos", enabled: false, source: "profile_default", requires: [], available_from_phase: "1b" },
      { key: "pos.courtesies", description: "Cortesías", enabled: false, source: "profile_default", requires: [], available_from_phase: "1b" },
      { key: "pos.staff_meal", description: "Consumo de personal", enabled: false, source: "profile_default", requires: [], available_from_phase: "1b" },
      { key: "pos.takeout", description: "Para llevar", enabled: false, source: "profile_default", requires: [], available_from_phase: "1b" },
      { key: "pos.counter", description: "Venta de mostrador", enabled: true, source: "profile_default", requires: [], available_from_phase: "1b" },
      { key: "pos.daily_count", description: "Contador de porciones", enabled: false, source: "profile_default", requires: [], available_from_phase: "1b" },
      { key: "kitchen.view", description: "Vista de cocina", enabled: false, source: "profile_default", requires: [], available_from_phase: "1b" },
      { key: "fiscal.dee_pos", description: "Documento equivalente POS", enabled: false, source: "profile_default", requires: [], available_from_phase: "1b" },
    ]);

    renderWithProviders(<FeaturesPage />, { me: buildMe() });

    // Cada clave es la primera celda de su fila (`font-mono`): puede
    // aparecer otra vez como dependencia de otra función (p. ej.
    // "pos.tables" también en la columna "Dependencias" de "pos.seats"),
    // así que se busca por celda, no por texto suelto.
    await screen.findByRole("table");
    for (const key of [
      "pos.tables",
      "pos.seats",
      "pos.courses",
      "pos.pre_bill",
      "pos.split_bill",
      "pos.tips",
      "pos.discounts",
      "pos.courtesies",
      "pos.staff_meal",
      "pos.takeout",
      "pos.counter",
      "pos.daily_count",
      "kitchen.view",
      "fiscal.dee_pos",
    ]) {
      const cell = screen.getAllByText(key).find((el) => el.tagName === "TD");
      expect(cell, `fila de ${key}`).toBeDefined();
    }

    // Dependencias visibles (`requires`), no reinventadas acá: vienen del backend.
    const seatsRow = screen.getAllByText("pos.seats").find((el) => el.tagName === "TD")?.closest("tr");
    expect(seatsRow).toHaveTextContent("pos.tables");

    const coursesRow = screen.getAllByText("pos.courses").find((el) => el.tagName === "TD")?.closest("tr");
    expect(coursesRow).toHaveTextContent("kitchen.view");
  });
});
