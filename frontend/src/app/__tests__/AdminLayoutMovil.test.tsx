import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "@/api/client";
import { buildMe, renderWithProviders } from "@/test/utils";

import AdminLayout, { formatFrescura } from "../AdminLayout";

/**
 * El celular del dueño (`docs/diseno/propuesta.html`, «Celular del dueño»):
 * barra inferior con Hoy · Informes · Caja · Avisos y «Más».
 *
 * jsdom no trae `matchMedia`, y sin él el armazón se comporta como
 * escritorio —que es lo que asumen las demás pruebas de `AdminLayout`—.
 * Acá se lo pone contestando «sí» a la consulta del celular.
 */

const listStores = vi.hoisted(() => vi.fn());
const getToday = vi.hoisted(() => vi.fn());
const listNotifications = vi.hoisted(() => vi.fn());

// El recuento de «Avisos» de la barra inferior sale de la misma consulta que
// la campana (`useAvisosSinLeer`).
vi.mock("@/api/notifications", async () => {
  const actual = await vi.importActual<typeof import("@/api/notifications")>("@/api/notifications");
  return { ...actual, listNotifications };
});

vi.mock("@/api/stores", async () => {
  const actual = await vi.importActual<typeof import("@/api/stores")>("@/api/stores");
  return { ...actual, listStores };
});

vi.mock("@/api/reports", async () => {
  const actual = await vi.importActual<typeof import("@/api/reports")>("@/api/reports");
  return { ...actual, getToday };
});

vi.mock("@/features/notifications/NotificationBell", () => ({
  NotificationBell: () => (
    <button type="button" aria-label="Notificaciones">
      Notificaciones
    </button>
  ),
}));

// Dinero (el dominio de turnos) lleva su flag en el doble: así se ve que
// «Caja» sale de la sección y no de una ruta escrita a mano.
vi.mock("@/features/shifts", () => ({
  shiftsFeature: {
    posRoutes: [],
    adminRoutes: [],
    adminNav: [{ to: "/admin/dinero", label: "Dinero", feature: "cash.handovers" }],
    posNav: [],
    ShiftStatusStrip: () => null,
  },
}));

function stubMatchMedia(matches: boolean) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({
      matches,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  );
}

function renderAdmin(me: ReturnType<typeof buildMe>, route = "/admin/hoy") {
  return renderWithProviders(
    <Routes>
      <Route path="/admin" element={<AdminLayout />}>
        <Route path="*" element={<div>contenido</div>} />
      </Route>
    </Routes>,
    { me, route },
  );
}

beforeEach(() => {
  listStores.mockReset();
  listStores.mockResolvedValue([]);
  getToday.mockReset();
  getToday.mockRejectedValue(new ApiError(500, "UNKNOWN_ERROR", "sin datos en este test"));
  listNotifications.mockReset();
  listNotifications.mockRejectedValue(new ApiError(500, "UNKNOWN_ERROR", "sin datos en este test"));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("AdminLayout en el celular: barra inferior", () => {
  it("cuatro destinos y «Más», en ese orden", async () => {
    stubMatchMedia(true);
    renderAdmin(buildMe({ features: { "cash.handovers": true } }));

    const barra = await screen.findByRole("navigation", { name: "Accesos del celular" });
    const controles = within(barra).getAllByRole("listitem").map((li) => li.textContent);
    expect(controles).toEqual(["Hoy", "Informes", "Caja", "Avisos", "Más"]);
    expect(within(barra).getByRole("link", { name: "Hoy" })).toHaveAttribute("href", "/admin/hoy");
    // La primera pantalla de Informes es Informes (antes, Ventas).
    expect(within(barra).getByRole("link", { name: "Informes" })).toHaveAttribute("href", "/admin/informes");
    expect(within(barra).getByRole("link", { name: "Caja" })).toHaveAttribute("href", "/admin/dinero");
  });

  it("«Avisos» lleva a Hoy › Requiere tu atención, que es donde cada aviso enlaza a lo que lo resuelve", async () => {
    stubMatchMedia(true);
    renderAdmin(buildMe());

    const barra = await screen.findByRole("navigation", { name: "Accesos del celular" });
    expect(within(barra).getByRole("link", { name: "Avisos" })).toHaveAttribute(
      "href",
      "/admin/hoy#requiere-atencion",
    );
  });

  it("la entrada en la que estás se marca con aria-current; en el ancla de avisos, Avisos y no Hoy", async () => {
    stubMatchMedia(true);
    renderAdmin(buildMe(), "/admin/hoy#requiere-atencion");

    const barra = await screen.findByRole("navigation", { name: "Accesos del celular" });
    expect(within(barra).getByRole("link", { name: "Avisos" })).toHaveAttribute("aria-current", "location");
    expect(within(barra).getByRole("link", { name: "Hoy" })).not.toHaveAttribute("aria-current");
  });

  it("«Caja» respeta los flags: sin Dinero va a la primera pantalla encendida de la sección (Banco)", async () => {
    stubMatchMedia(true);
    renderAdmin(buildMe({ features: { "cash.handovers": false, "money.deposits": true } }));

    const barra = await screen.findByRole("navigation", { name: "Accesos del celular" });
    expect(within(barra).getByRole("link", { name: "Caja" })).toHaveAttribute("href", "/admin/banco");
  });

  it("parado en una pantalla de Informes, se marca Informes", async () => {
    stubMatchMedia(true);
    renderAdmin(buildMe({ features: { customers: true } }), "/admin/clientes");

    const barra = await screen.findByRole("navigation", { name: "Accesos del celular" });
    expect(within(barra).getByRole("link", { name: "Informes" })).toHaveAttribute("aria-current", "page");
    expect(within(barra).getByRole("link", { name: "Hoy" })).not.toHaveAttribute("aria-current");
  });

  it("«Más» abre el cajón con las ocho secciones", async () => {
    stubMatchMedia(true);
    const user = userEvent.setup();
    renderAdmin(buildMe({ features: { "cash.handovers": true } }));

    const barra = await screen.findByRole("navigation", { name: "Accesos del celular" });
    const mas = within(barra).getByRole("button", { name: "Más" });
    expect(mas).toHaveAttribute("aria-expanded", "false");
    await user.click(mas);

    const cajon = await screen.findByRole("dialog");
    expect(within(cajon).getByRole("link", { name: "Caja" })).toBeInTheDocument();
    expect(within(cajon).getByRole("link", { name: "Ajustes" })).toBeInTheDocument();
    expect(mas).toHaveAttribute("aria-expanded", "true");
  });

  it("el contenido deja lugar abajo para la barra", async () => {
    stubMatchMedia(true);
    renderAdmin(buildMe());

    await screen.findByRole("navigation", { name: "Accesos del celular" });
    expect(screen.getByRole("main").className).toContain("pb-[calc(5rem+env(safe-area-inset-bottom))]");
  });

  it("«Avisos» lleva la insignia de los sin leer, y la dice en voz alta", async () => {
    stubMatchMedia(true);
    listNotifications.mockResolvedValue([
      { id: 1, type: "shift_stale", level: "critical", title: "a", body: "", read_at: null, created_at: "2026-09-27T17:00:00Z" },
      { id: 2, type: "pin_locked", level: "warning", title: "b", body: "", read_at: null, created_at: "2026-09-27T17:00:00Z" },
      { id: 3, type: "pin_locked", level: "warning", title: "c", body: "", read_at: "2026-09-27T17:01:00Z", created_at: "2026-09-27T17:00:00Z" },
    ]);
    renderAdmin(buildMe());

    const barra = await screen.findByRole("navigation", { name: "Accesos del celular" });
    const avisos = await within(barra).findByRole("link", { name: "Avisos, 2 sin leer" });
    expect(avisos).toHaveTextContent("Avisos2");
  });

  it("en el escritorio la barra no existe", async () => {
    stubMatchMedia(false);
    renderAdmin(buildMe());

    await screen.findAllByRole("link", { name: "Hoy" });
    expect(screen.queryByRole("navigation", { name: "Accesos del celular" })).not.toBeInTheDocument();
    expect(screen.getByRole("main").className).not.toContain("pb-[calc");
  });
});

/**
 * La barra superior del celular (handoff, `AdminMovil`): 52 px con ☰, la
 * sede y la frescura. Persona, tema y salida se mudan al cajón.
 */
describe("AdminLayout en el celular: barra superior", () => {
  it("lleva el menú, la sede y nada de la barra del escritorio", async () => {
    stubMatchMedia(true);
    listStores.mockResolvedValue([{ id: 7, name: "Chapinero" }]);
    renderAdmin(buildMe());

    const barra = document.querySelector("header") as HTMLElement;
    expect(barra.className).toContain("min-h-[52px]");
    expect(within(barra).getByRole("button", { name: "Abrir menú" })).toBeInTheDocument();
    expect(await within(barra).findByText("Chapinero")).toBeInTheDocument();
    expect(within(barra).queryByRole("button", { name: /salir/i })).toBeNull();
    expect(within(barra).queryByText(/Admin de prueba/)).toBeNull();
  });

  it("☰ abre el cajón, y ahí están quién sos, el tema y la salida", async () => {
    stubMatchMedia(true);
    const user = userEvent.setup();
    renderAdmin(buildMe());

    const menu = await screen.findByRole("button", { name: "Abrir menú" });
    expect(menu).toHaveAttribute("aria-expanded", "false");
    await user.click(menu);
    const cajon = await screen.findByRole("dialog");
    expect(within(cajon).getByText(/Admin de prueba · administrador/)).toBeInTheDocument();
    expect(within(cajon).getByRole("button", { name: /Tema (oscuro|claro)/ })).toBeInTheDocument();
    expect(within(cajon).getByRole("button", { name: /Salir/ })).toBeInTheDocument();
  });

  it("en la vista de un aviso, ☰ se vuelve «‹ Avisos» y la barra inferior marca Avisos", async () => {
    stubMatchMedia(true);
    renderAdmin(buildMe(), "/admin/avisos/5?desde=notificacion");

    const barra = document.querySelector("header") as HTMLElement;
    expect(await within(barra).findByRole("link", { name: "Avisos" })).toHaveAttribute(
      "href",
      "/admin/hoy#requiere-atencion",
    );
    expect(within(barra).queryByRole("button", { name: "Abrir menú" })).toBeNull();
    const inferior = screen.getByRole("navigation", { name: "Accesos del celular" });
    expect(within(inferior).getByRole("link", { name: "Avisos" })).toHaveAttribute("aria-current", "location");
  });
});

describe("la frescura: «hace 14 s»", () => {
  it("cuenta segundos debajo del minuto y minutos después", () => {
    const ahora = Date.parse("2026-09-27T17:55:00Z");
    expect(formatFrescura(ahora - 14_000, ahora)).toBe("hace 14 s");
    expect(formatFrescura(ahora, ahora)).toBe("hace 0 s");
    expect(formatFrescura(ahora - 5 * 60_000, ahora)).toBe("hace 5 min");
  });
});
