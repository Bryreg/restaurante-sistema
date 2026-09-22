import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { buildMe, renderWithProviders } from "@/test/utils";

import { NotificationBell } from "../NotificationBell";
import { TYPE_HELP, TYPE_LABEL } from "../NotificationsPage";

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

  // Base UI no tiene `onSelect` (es de Radix): el clic nunca marcaba el aviso.
  it("tocar un aviso lo marca leído", async () => {
    renderWithProviders(<NotificationBell storeId={1} />, { me: buildMe() });
    await userEvent.click(await screen.findByRole("button", { name: /Notificaciones/ }));
    await userEvent.click(await screen.findByRole("menuitem", { name: /Diferencia de caja/ }));
    await waitFor(() => expect(markNotificationRead).toHaveBeenCalledWith(7));
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
];

describe("reglas de notificación", () => {
  it.each(TIPOS_DEL_BACKEND)("«%s» tiene nombre y explicación en español", (tipo) => {
    expect(TYPE_LABEL[tipo]).toBeTruthy();
    expect(TYPE_HELP[tipo]).toBeTruthy();
  });
});
