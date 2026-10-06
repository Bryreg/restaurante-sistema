import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { buildMe, renderWithProviders } from "@/test/utils";

import { NotificationBell } from "../NotificationBell";
import { TYPE_HELP, TYPE_LABEL } from "../types";

const listNotifications = vi.fn();
const markNotificationRead = vi.fn();

vi.mock("@/api/notifications", async () => {
  const actual = await vi.importActual<typeof import("@/api/notifications")>("@/api/notifications");
  return {
    ...actual,
    listNotifications: (...args: unknown[]) => listNotifications(...args),
    markNotificationRead: (...args: unknown[]) => markNotificationRead(...args),
  };
});

const AVISO = {
  id: 7,
  type: "cash_difference",
  level: "warning",
  title: "Diferencia de caja al cierre",
  body: "El turno #14 cerró con una diferencia de $ 3.000.",
  payload: {},
  read_at: null,
  created_at: "2026-09-22T03:15:00Z",
};

describe("NotificationBell", () => {
  beforeEach(() => {
    listNotifications.mockResolvedValue([AVISO]);
    markNotificationRead.mockResolvedValue({ ...AVISO, read_at: "2026-09-22T04:00:00Z" });
  });

  // Al abrirla, un `Menu.GroupLabel` fuera de su `Menu.Group` lanzaba
  // «MenuGroupContext is missing» y tumbaba la aplicación entera.
  it("abre sin romper y muestra los avisos", async () => {
    renderWithProviders(<NotificationBell storeId={1} />, { me: buildMe() });
    await userEvent.click(await screen.findByRole("button", { name: /Notificaciones, 1 sin leer/ }));
    expect(await screen.findByText("Diferencia de caja al cierre")).toBeInTheDocument();
  });

  // Leído ≠ resuelto (0042): abrir la campana marca vistas las que muestra
  // (dejan de contar como nuevas); del riel de Hoy salen sólo al resolverse.
  it("abrir la campana marca leídas las que muestra, sin resolverlas", async () => {
    const VISTO = { ...AVISO, id: 8, title: "Ya visto", read_at: "2026-09-22T03:20:00Z" };
    listNotifications.mockResolvedValue([AVISO, VISTO]);
    renderWithProviders(<NotificationBell storeId={1} />, { me: buildMe() });
    await userEvent.click(await screen.findByRole("button", { name: /Notificaciones, 1 sin leer/ }));
    await waitFor(() => expect(markNotificationRead).toHaveBeenCalledWith(7));
    expect(markNotificationRead).not.toHaveBeenCalledWith(8);
  });

  it("un aviso resuelto dice quién lo resolvió", async () => {
    listNotifications.mockResolvedValue([
      { ...AVISO, read_at: "2026-09-22T04:00:00Z", resolved_at: "2026-09-22T04:00:00Z", resolved_by_name: "Sistema" },
    ]);
    renderWithProviders(<NotificationBell storeId={1} />, { me: buildMe() });
    await userEvent.click(await screen.findByRole("button", { name: /Notificaciones/ }));
    expect(await screen.findByText(/Resuelto por Sistema/)).toBeInTheDocument();
  });

  // Base UI no tiene `onSelect` (es de Radix): el clic nunca marcaba el aviso.
  it("tocar un aviso lo marca leído", async () => {
    renderWithProviders(<NotificationBell storeId={1} />, { me: buildMe() });
    await userEvent.click(await screen.findByRole("button", { name: /Notificaciones/ }));
    await userEvent.click(await screen.findByRole("menuitem", { name: /Diferencia de caja/ }));
    await waitFor(() => expect(markNotificationRead).toHaveBeenCalledWith(7));
  });

  // Handoff (`AdminTop`): en la barra superior es «Avisos» con su recuento,
  // no una campana muda; y cada aviso abre su vista.
  // «Burbujas»: en la barra es una campana de 40 × 40 con punto rojo; el
  // recuento va en el nombre accesible, que empieza por «Avisos».
  it("en la barra es la campana con punto rojo, y su nombre dice «Avisos» con el recuento", async () => {
    renderWithProviders(<NotificationBell storeId={1} variant="barra" />, { me: buildMe() });
    const boton = await screen.findByRole("button", { name: "Avisos, 1 sin leer" });
    expect(boton).toHaveTextContent("Avisos");
    expect(boton.querySelector(".bg-destructive")).not.toBeNull();
  });

  it("tocar un aviso abre su vista (`/admin/avisos/:id`)", async () => {
    renderWithProviders(
      <Routes>
        <Route path="/admin/hoy" element={<NotificationBell storeId={1} variant="barra" />} />
        <Route path="/admin/avisos/:id" element={<p>vista del aviso</p>} />
      </Routes>,
      { me: buildMe(), route: "/admin/hoy" },
    );
    await userEvent.click(await screen.findByRole("button", { name: /Avisos/ }));
    await userEvent.click(await screen.findByRole("menuitem", { name: /Diferencia de caja/ }));
    expect(await screen.findByText("vista del aviso")).toBeInTheDocument();
  });
});

// Copia de `NOTIFICATION_TYPES` (`backend/app/notifications/service.py`): la
// pantalla de reglas mostraba 14 de estos 21 con su código crudo
// (`waste_spike`) y sin explicación. Si el backend suma un tipo, esta lista
// y las dos tablas de la pantalla se actualizan juntas.
const TIPOS_DEL_BACKEND = [
  "shift_stale", "cash_difference", "cash_difference_critical", "difference_streak", "cash_over_threshold",
  "pin_locked", "product_unavailable", "discount_rate_high", "courtesy_limit", "void_rate_high",
  "order_unsent_too_long", "order_unpaid_too_long", "fiscal_rejected", "fiscal_contingency_overdue",
  "fiscal_range_low", "pending_refund", "ingredient_below_min", "ingredient_negative", "prep_no_production",
  "product_discounts_nothing", "waste_spike",
  // 0031, avisos al celular: los dos hechos graves que no se emitían.
  "reserve_loan_open", "area_count_shortage",
];

describe("reglas de notificación", () => {
  it.each(TIPOS_DEL_BACKEND)("«%s» tiene nombre y explicación en español", (tipo) => {
    expect(TYPE_LABEL[tipo]).toBeTruthy();
    expect(TYPE_HELP[tipo]).toBeTruthy();
  });
});
