import { screen, waitFor } from "@testing-library/react";
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
    await user.click(screen.getByRole("button", { name: "Sellar el conteo" }));

    await waitFor(() => expect(sealMock).toHaveBeenCalledTimes(1));
    expect(sealMock.mock.calls[0]?.[0]).toMatchObject({ envelopes: [{ shift_id: 12, counted: { total: 0 } }] });

    expect(await screen.findByText("$ 74.000")).toBeInTheDocument();
    expect(screen.getByText(/Contó Ana/)).toBeInTheDocument();

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
