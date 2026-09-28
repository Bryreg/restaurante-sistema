import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Me } from "@/api/auth";
import type { OpeningCount, OpeningInfo } from "@/api/shifts";
import { renderWithProviders } from "@/test/utils";

import { EnvelopeOpeningForm } from "../EnvelopeOpeningForm";

vi.mock("@/api/employees", async () => {
  const actual = await vi.importActual<typeof import("@/api/employees")>("@/api/employees");
  return {
    ...actual,
    listDeviceEmployees: vi.fn().mockResolvedValue([{ id: 7, name: "Ana", role: "operator" }]),
  };
});

const { sealMock, openShiftMock } = vi.hoisted(() => ({ sealMock: vi.fn(), openShiftMock: vi.fn() }));

vi.mock("@/api/shifts", async () => {
  const actual = await vi.importActual<typeof import("@/api/shifts")>("@/api/shifts");
  return { ...actual, sealOpeningCount: sealMock, openShift: openShiftMock };
});

beforeEach(() => {
  sealMock.mockReset();
  openShiftMock.mockReset();
});

const ME: Me = {
  kind: "device",
  store: { id: 1, name: "Sede Centro", cutoff_hour: 6, active_channels: [] },
  employee: { id: 7, name: "Ana", role: "operator", can_charge: true },
  organization: { id: 1, name: "Organización de prueba" },
  features: { "money.deposits": true, "cash.reserve": true },
};

const INFO: OpeningInfo = {
  mode: "envelopes",
  envelopes: [
    { shift_id: 11, business_date: "2026-09-21" },
    { shift_id: 12, business_date: "2026-09-22" },
  ],
  pending_count: null,
  reserve_available: true,
};

/** Lo que revela el servidor al sellar: una cifra que no puede salir de ningún otro lado. */
const REVEAL: OpeningCount = {
  id: 5,
  counted_by: { id: 7, name: "Ana" },
  counted_at: "2026-09-26T12:00:00Z",
  envelopes: [{ shift_id: 12, business_date: "2026-09-22", expected: 74_000, counted: 0, difference: -74_000 }],
  expected_total: 74_000,
  counted_total: 0,
  difference_total: -74_000,
  requires_cause: true,
  used: false,
};

describe("EnvelopeOpeningForm — el cuadre de apertura por sobres", () => {
  it("lista los sobres por fecha, sin monto, y ninguno viene elegido", () => {
    renderWithProviders(<EnvelopeOpeningForm info={INFO} />, { me: ME });

    const sobres = screen.getAllByRole("button", { name: /^Sobre del / });
    expect(sobres).toHaveLength(2);
    for (const b of sobres) expect(b).toHaveAttribute("aria-pressed", "false");
    // A ciegas: ninguna cifra de plata antes de sellar.
    expect(screen.queryByText(/\$/)).not.toBeInTheDocument();
  });

  it("cuenta el sobre elegido, sella, muestra lo que reveló el servidor y abre con la causa", async () => {
    sealMock.mockResolvedValue(REVEAL);
    openShiftMock.mockResolvedValue({ id: 99 });
    const user = userEvent.setup();
    renderWithProviders(<EnvelopeOpeningForm info={INFO} />, { me: ME });

    await user.click(screen.getAllByRole("button", { name: /^Sobre del / })[1]!);
    await user.click(screen.getByRole("button", { name: "Contar el sobre" }));
    // Contando, todavía sin el monto esperado.
    expect(screen.queryByText("$ 74.000")).not.toBeInTheDocument();
    // Rótulo del handoff (pantalla 2): «Sellar sobre», antes «Sellar el conteo».
    await user.click(screen.getByRole("button", { name: "Sellar sobre" }));

    await waitFor(() => expect(sealMock).toHaveBeenCalledTimes(1));
    expect(sealMock.mock.calls[0]?.[0]).toMatchObject({ envelopes: [{ shift_id: 12, counted: { total: 0 } }] });

    expect(await screen.findByText("$ 74.000")).toBeInTheDocument();
    // Quién contó sale dos veces: en la fila del sobre y en «Ver diferencias».
    expect(screen.getAllByText(/Contó Ana/).length).toBeGreaterThan(0);
    // La pastilla del sobre aparece sólo después de sellar, con lo del servidor.
    expect(screen.getByText("Faltan $ 74.000")).toBeInTheDocument();

    await screen.findByRole("radio", { name: /ana, operador/i });
    const abrir = screen.getByRole("button", { name: "Abrir turno" });
    expect(abrir).toBeDisabled();
    await user.click(screen.getByRole("radio", { name: "Error de conteo" }));
    await user.click(abrir);

    await waitFor(() => expect(openShiftMock).toHaveBeenCalledTimes(1));
    expect(openShiftMock.mock.calls[0]?.[0]).toMatchObject({
      opening_count_id: 5,
      cash_responsible_id: 7,
      opening_cause: "counting_error",
    });
    expect(openShiftMock.mock.calls[0]?.[0]).not.toHaveProperty("opening_cash");
  });

  it("sin sobres el cajón abre vacío, sin conteo", async () => {
    openShiftMock.mockResolvedValue({ id: 99 });
    const user = userEvent.setup();
    renderWithProviders(<EnvelopeOpeningForm info={{ ...INFO, envelopes: [] }} />, { me: ME });

    expect(screen.getByText(/el cajón abre vacío/i)).toBeInTheDocument();
    await screen.findByRole("radio", { name: /ana, operador/i });
    await user.click(screen.getByRole("button", { name: "Abrir turno" }));
    await waitFor(() => expect(openShiftMock).toHaveBeenCalledTimes(1));
    expect(openShiftMock.mock.calls[0]?.[0]).toMatchObject({ cash_responsible_id: 7 });
    expect(openShiftMock.mock.calls[0]?.[0]?.opening_count_id).toBeUndefined();
  });
});

describe("EnvelopeOpeningForm — el handoff (pantalla 2)", () => {
  it("pasos arriba, contar sobre por sobre y la pastilla sólo después de sellar, con lo del servidor", async () => {
    sealMock.mockResolvedValue({
      ...REVEAL,
      envelopes: [
        { shift_id: 11, business_date: "2026-09-21", expected: 50_000, counted: 50_000, difference: 0 },
        { shift_id: 12, business_date: "2026-09-22", expected: 74_000, counted: 72_000, difference: -2_000 },
      ],
    });
    const user = userEvent.setup();
    renderWithProviders(<EnvelopeOpeningForm info={INFO} />, { me: ME });

    const pasos = screen.getByRole("list", { name: "Pasos de la apertura" });
    expect(within(pasos).getByText("Elegir sobres").closest("li")).toHaveAttribute("aria-current", "step");

    for (const b of screen.getAllByRole("button", { name: /^Sobre del / })) await user.click(b);
    await user.click(screen.getByRole("button", { name: "Contar los 2 sobres" }));
    expect(within(pasos).getByText("Contar y sellar").closest("li")).toHaveAttribute("aria-current", "step");
    expect(screen.getByRole("heading", { name: /Contando: sobre del/ })).toBeInTheDocument();
    // Contando: el sobre en curso dice «Contando», nunca un monto.
    const sobres = screen.getAllByRole("button", { name: /^Sobre del / });
    expect(sobres[0]).toHaveTextContent("Contando");
    expect(sobres[1]).toHaveTextContent("Por contar");
    for (const b of sobres) expect(b).not.toHaveTextContent("$");

    await user.click(screen.getByRole("button", { name: "Siguiente sobre" }));
    expect(screen.getAllByRole("button", { name: /^Sobre del / })[0]).toHaveTextContent("Contado");
    await user.click(screen.getByRole("button", { name: "Sellar los 2 sobres" }));

    await waitFor(() => expect(sealMock).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("Faltan $ 2.000")).toBeInTheDocument();
    expect(screen.getByText(/Cuadra · \$ 0/)).toBeInTheDocument();
    expect(within(pasos).getByText("Ver diferencias").closest("li")).toHaveAttribute("aria-current", "step");
  });

  it("la base de respaldo va aparte: tarjeta punteada y «Contar base» sólo con la función encendida", () => {
    const { unmount } = renderWithProviders(<EnvelopeOpeningForm info={INFO} />, { me: ME });
    expect(screen.getByRole("heading", { name: "Base de respaldo" })).toBeInTheDocument();
    expect(screen.getByText(/no entra al cuadre del turno/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Contar base" })).toBeInTheDocument();
    unmount();

    renderWithProviders(<EnvelopeOpeningForm info={INFO} />, { me: { ...ME, features: { "money.deposits": true } } });
    expect(screen.queryByRole("button", { name: "Contar base" })).not.toBeInTheDocument();
  });
});
