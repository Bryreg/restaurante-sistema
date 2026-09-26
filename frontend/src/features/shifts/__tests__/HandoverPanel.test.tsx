import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Me } from "@/api/auth";
import { ApiError } from "@/api/client";
import { renderWithProviders } from "@/test/utils";

import { HandoverPanel } from "../HandoverPanel";

/**
 * Relevo con inicio por rol (2026-09-25): sólo se le entrega el cajón a quien
 * puede recibirlo, esa persona confirma con su PIN, y al terminar queda una
 * tarjeta con el resultado (la tablet pasa a su nombre si se puede).
 */

const createHandover = vi.fn();
const getHandoverCandidates = vi.fn();
const deviceIdentify = vi.fn();

vi.mock("@/api/shifts", async () => {
  const actual = await vi.importActual<typeof import("@/api/shifts")>("@/api/shifts");
  return {
    ...actual,
    createHandover: (...args: unknown[]) => createHandover(...args),
    getHandoverCandidates: (...args: unknown[]) => getHandoverCandidates(...args),
    getShiftSummary: vi.fn().mockResolvedValue({ id: 42, handovers: [] }),
    getCurrentShift: vi.fn().mockResolvedValue(null),
  };
});
vi.mock("@/api/auth", async () => {
  const actual = await vi.importActual<typeof import("@/api/auth")>("@/api/auth");
  return { ...actual, deviceIdentify: (...args: unknown[]) => deviceIdentify(...args) };
});
vi.mock("../PhotoCaptureField", () => ({ PhotoCaptureField: () => null }));

const ME: Me = {
  kind: "device",
  store: { id: 1, name: "Sede Centro", cutoff_hour: 6, active_channels: [] },
  employee: { id: 1, name: "Ana", role: "operator", can_charge: true },
  organization: { id: 1, name: "Organización de prueba" },
  features: { "cash.handovers": true },
};

beforeEach(() => {
  createHandover.mockReset();
  getHandoverCandidates.mockReset();
  deviceIdentify.mockReset();
  getHandoverCandidates.mockResolvedValue([
    { id: 5, name: "Luz Marina", on_shift: true },
    { id: 6, name: "Rosa", on_shift: false },
  ]);
  createHandover.mockResolvedValue({
    id: 1,
    kind: "handover",
    from_responsible: { id: 1, name: "Ana" },
    new_responsible: { id: 5, name: "Luz Marina" },
    breakdown: null,
  });
});

describe("HandoverPanel — quien recibe confirma con su PIN", () => {
  it("lista primero a los del turno que pueden recibir; los demás detrás de «Otra persona…»", async () => {
    renderWithProviders(<HandoverPanel shiftId={42} />, { me: ME });

    expect(await screen.findByRole("radio", { name: "Luz Marina" })).toBeInTheDocument();
    expect(screen.queryByRole("radio", { name: "Rosa" })).not.toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole("button", { name: "Otra persona con permiso de cobrar" }));
    expect(screen.getByRole("radio", { name: "Rosa" })).toBeInTheDocument();
  });

  it("manda el PIN de quien recibe, pasa la tablet a su nombre y muestra la tarjeta del relevo", async () => {
    deviceIdentify.mockResolvedValue({ employee: { id: 5, name: "Luz Marina", role: "operator", can_charge: true } });
    const refresh = vi.fn(async () => {});
    const user = userEvent.setup();
    renderWithProviders(<HandoverPanel shiftId={42} />, { me: ME, session: { refresh } });

    await user.click(await screen.findByRole("radio", { name: "Luz Marina" }));
    await user.keyboard("2468");

    await waitFor(() => expect(createHandover).toHaveBeenCalledTimes(1));
    expect(createHandover.mock.calls[0]![1]).toMatchObject({
      kind: "handover",
      new_responsible_id: 5,
      new_responsible_pin: "2468",
    });
    expect(deviceIdentify).toHaveBeenCalledWith({ employee_id: 5, pin: "2468" });
    expect(await screen.findByText("La caja pasó de Ana a Luz Marina.")).toBeInTheDocument();
    expect(screen.getByText("La tablet quedó a nombre de Luz Marina.")).toBeInTheDocument();
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it("si la tablet no puede pasar a su nombre, le pide que se identifique", async () => {
    deviceIdentify.mockRejectedValue(new ApiError(400, "PIN_INVALID", "PIN incorrecto"));
    const user = userEvent.setup();
    renderWithProviders(<HandoverPanel shiftId={42} />, { me: ME });

    await user.click(await screen.findByRole("radio", { name: "Luz Marina" }));
    await user.keyboard("2468");

    expect(await screen.findByText("Que Luz Marina se identifique con su PIN antes de seguir.")).toBeInTheDocument();
  });

  it("un PIN equivocado muestra el mensaje del servidor y no deja tarjeta", async () => {
    createHandover.mockRejectedValue(
      new ApiError(400, "NEW_RESPONSIBLE_PIN_INVALID", "El PIN de Luz Marina no es correcto; que lo teclee de nuevo"),
    );
    const user = userEvent.setup();
    renderWithProviders(<HandoverPanel shiftId={42} />, { me: ME });

    await user.click(await screen.findByRole("radio", { name: "Luz Marina" }));
    await user.keyboard("0000");

    expect(await screen.findByText(/no es correcto/)).toBeInTheDocument();
    expect(screen.queryByText(/La caja pasó/)).not.toBeInTheDocument();
    expect(deviceIdentify).not.toHaveBeenCalled();
  });
});
