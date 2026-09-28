import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "@/api/client";
import { StoreSelectionProvider } from "@/app/storeContext";
import { buildMe, renderWithProviders } from "@/test/utils";

import AvisoPage from "../AvisoPage";
import { destinoDelAviso, destinoSeguro } from "../avisos";

/**
 * «Aviso desde la notificación» (handoff, pantalla 13b · `AdminMovil
 * pantalla="aviso"`): lo que abre tocar el aviso en el celular.
 */

const getNotification = vi.hoisted(() => vi.fn());
const markNotificationRead = vi.hoisted(() => vi.fn());
const listStores = vi.hoisted(() => vi.fn());

vi.mock("@/api/notifications", async () => {
  const actual = await vi.importActual<typeof import("@/api/notifications")>("@/api/notifications");
  return { ...actual, getNotification, markNotificationRead };
});

vi.mock("@/api/stores", async () => {
  const actual = await vi.importActual<typeof import("@/api/stores")>("@/api/stores");
  return { ...actual, listStores };
});

const AVISO = {
  id: 42,
  store_id: 7,
  type: "reserve_loan_open",
  level: "critical" as const,
  title: "Base de respaldo sin devolver",
  body: "El turno #3 sigue debiendo $ 50.000 a la base de respaldo.",
  payload: { shift_id: 3, owed: "50000", when: "close" },
  read_at: null,
  // 12:48 p. m. en Bogotá.
  created_at: "2026-09-27T17:48:00Z",
};

function abrir(ruta: string) {
  return renderWithProviders(
    <StoreSelectionProvider>
      <Routes>
        <Route path="/admin/avisos/:id" element={<AvisoPage />} />
      </Routes>
    </StoreSelectionProvider>,
    { me: buildMe(), route: ruta },
  );
}

beforeEach(() => {
  getNotification.mockReset();
  markNotificationRead.mockReset();
  listStores.mockReset();
  listStores.mockResolvedValue([{ id: 7, name: "Chapinero" }]);
  getNotification.mockResolvedValue(AVISO);
});

describe("AvisoPage: el aviso abierto desde la notificación", () => {
  it("dice que se abrió desde una notificación, la gravedad, la sección, la cifra del servidor y la sede", async () => {
    abrir("/admin/avisos/42?desde=notificacion&destino=%2Fadmin%2Fdinero");

    expect(await screen.findByRole("heading", { name: "Base de respaldo sin devolver" })).toBeInTheDocument();
    expect(getNotification).toHaveBeenCalledWith(42);
    expect(screen.getByText(/Abierto desde una notificación · 12:48 p\. m\./)).toBeInTheDocument();
    expect(screen.getByText("Crítico · Caja")).toBeInTheDocument();
    // La cifra es la que mandó el servidor, con su rótulo: el cliente no la calcula.
    expect(screen.getByText("Sin devolver a la base")).toBeInTheDocument();
    expect(screen.getByText("$ 50.000")).toBeInTheDocument();
    expect(await screen.findByText("Chapinero")).toBeInTheDocument();
    // La ficha que el aviso nombra por id.
    expect(screen.getByRole("link", { name: "Ficha del turno #3" })).toHaveAttribute("href", "/admin/dinero/turno/3");
  });

  it("sin `desde=notificacion` (abierto desde la campana) no hay pastilla", async () => {
    abrir("/admin/avisos/42");
    await screen.findByRole("heading", { name: "Base de respaldo sin devolver" });
    expect(screen.queryByText(/Abierto desde una notificación/)).toBeNull();
  });

  it("la acción primaria lleva a donde se resuelve, nombrado en palabras", async () => {
    abrir("/admin/avisos/42?desde=notificacion&destino=%2Fadmin%2Fdinero");
    const resolver = await screen.findByRole("link", { name: "Resolver en Caja › Dinero" });
    expect(resolver).toHaveAttribute("href", "/admin/dinero");
  });

  it("marcar como visto deja rastro con la hora y no se puede repetir", async () => {
    const user = userEvent.setup();
    markNotificationRead.mockResolvedValue({ ...AVISO, read_at: "2026-09-27T17:55:00Z" });
    abrir("/admin/avisos/42?desde=notificacion");

    await user.click(await screen.findByRole("button", { name: "Marcar como visto" }));
    await waitFor(() => expect(markNotificationRead).toHaveBeenCalledWith(42));
    const rastro = await screen.findByRole("status");
    expect(rastro).toHaveTextContent("Marcado como visto · 12:55 p. m.");
    expect(rastro).toHaveTextContent("queda en el historial");
    expect(screen.getByRole("button", { name: "Visto" })).toBeDisabled();
  });

  it("un aviso que no existe (o de otra organización) lo dice y lleva a los avisos", async () => {
    getNotification.mockRejectedValue(new ApiError(404, "NOT_FOUND", "La notificación no existe"));
    abrir("/admin/avisos/999");
    expect(await screen.findByText("Ese aviso no existe")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Ver los avisos" })).toHaveAttribute(
      "href",
      "/admin/hoy#requiere-atencion",
    );
  });

  it("las acciones van fijas sobre la barra inferior del celular, y en el flujo en el escritorio", async () => {
    abrir("/admin/avisos/42");
    const resolver = await screen.findByRole("link", { name: /Resolver en/ });
    const barra = resolver.closest("div.fixed") as HTMLElement;
    expect(barra).not.toBeNull();
    expect(barra.className).toContain("bottom-[calc(3.5rem+env(safe-area-inset-bottom))]");
    expect(barra.className).toContain("md:static");
    expect(within(barra).getByRole("button", { name: "Marcar como visto" })).toBeInTheDocument();
  });
});

describe("a dónde lleva «Resolver en…»", () => {
  it("el destino de la URL sólo se acepta si es del admin en este mismo origen", () => {
    expect(destinoSeguro("/admin/dinero")).toBe("/admin/dinero");
    expect(destinoSeguro("/admin/inventario?tab=por-area")).toBe("/admin/inventario?tab=por-area");
    expect(destinoSeguro("https://otro.example/admin")).toBeNull();
    expect(destinoSeguro("//otro.example/admin/x")).toBeNull();
    expect(destinoSeguro("javascript:alert(1)")).toBeNull();
    expect(destinoSeguro("/pos")).toBeNull();
    expect(destinoSeguro(null)).toBeNull();
  });

  it("sin destino en la URL manda el del tipo; con uno ajeno, también", () => {
    expect(destinoDelAviso({ type: "ingredient_negative", payload: null }, null)).toEqual({
      to: "/admin/inventario?tab=stock&negative=1",
      donde: "Inventario › Stock",
    });
    expect(destinoDelAviso({ type: "shift_stale", payload: null }, "https://evil.example").to).toBe("/admin/dinero");
    // Un tipo que el cliente no conoce todavía lleva a Hoy, nunca a ningún lado.
    expect(destinoDelAviso({ type: "nuevo_tipo", payload: null }, null)).toEqual({ to: "/admin/hoy", donde: "Hoy" });
  });

  it("el faltante de un conteo abre ESE conteo", () => {
    expect(destinoDelAviso({ type: "area_count_shortage", payload: { count_id: 9 } }, null).to).toBe(
      "/admin/inventario?tab=por-area&conteo=9",
    );
  });
});
