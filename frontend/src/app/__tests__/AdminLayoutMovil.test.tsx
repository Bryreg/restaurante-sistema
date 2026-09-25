import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "@/api/client";
import { buildMe, renderWithProviders } from "@/test/utils";

import AdminLayout from "../AdminLayout";

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

  it("en el escritorio la barra no existe", async () => {
    stubMatchMedia(false);
    renderAdmin(buildMe());

    await screen.findAllByRole("link", { name: "Hoy" });
    expect(screen.queryByRole("navigation", { name: "Accesos del celular" })).not.toBeInTheDocument();
    expect(screen.getByRole("main").className).not.toContain("pb-[calc");
  });
});
