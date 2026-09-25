import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "@/api/client";
import type { SessionContextValue } from "@/app/session";
import { buildMe, renderWithProviders } from "@/test/utils";

import AdminLayout from "../AdminLayout";

const logout = vi.hoisted(() => vi.fn());
const listStores = vi.hoisted(() => vi.fn());
const getToday = vi.hoisted(() => vi.fn());

vi.mock("@/api/auth", async () => {
  const actual = await vi.importActual<typeof import("@/api/auth")>("@/api/auth");
  return { ...actual, logout };
});

vi.mock("@/api/stores", async () => {
  const actual = await vi.importActual<typeof import("@/api/stores")>("@/api/stores");
  return { ...actual, listStores };
});

vi.mock("@/api/reports", async () => {
  const actual = await vi.importActual<typeof import("@/api/reports")>("@/api/reports");
  return { ...actual, getToday };
});

// La campana de verdad sondea `GET /admin/notifications`; acá alcanza con un
// doble que **existe y se puede nombrar**, porque lo que este archivo mide es
// dónde vive el control, no qué cuenta.
vi.mock("@/features/notifications/NotificationBell", () => ({
  NotificationBell: () => (
    <button type="button" aria-label="Notificaciones">
      Notificaciones
    </button>
  ),
}));

vi.mock("@/features/shifts", () => ({
  shiftsFeature: {
    posRoutes: [],
    adminRoutes: [],
    adminNav: [{ to: "/admin/personal", label: "Turnos y personal", feature: "cash.handovers" }],
    posNav: [],
    ShiftStatusStrip: () => null,
  },
}));

vi.mock("@/features/catalog", () => ({
  catalogFeature: {
    adminRoutes: [],
    adminNav: [{ to: "/admin/carta", label: "Carta" }],
  },
}));

function renderAdmin(
  me: ReturnType<typeof buildMe>,
  session?: Partial<SessionContextValue>,
  route = "/admin",
) {
  return renderWithProviders(
    <Routes>
      <Route path="/admin" element={<AdminLayout />}>
        <Route index element={<div>contenido</div>} />
        <Route path="*" element={<div>contenido</div>} />
      </Route>
    </Routes>,
    { me, route, session },
  );
}

/** Las entradas del rail, en el orden en que se ven. */
function seccionesDelRail(): string[] {
  const rail = screen.getByRole("navigation", { name: "Secciones de administración" });
  return within(rail)
    .getAllByRole("link")
    .map((a) => a.getAttribute("title") ?? "");
}

/** Las pestañas de la sección en la que se está parado. */
function pestanas(seccion: string) {
  return screen.getByRole("navigation", { name: `Pantallas de ${seccion}` });
}

beforeEach(() => {
  logout.mockReset();
  logout.mockResolvedValue(undefined);
  listStores.mockReset();
  listStores.mockResolvedValue([]);
  getToday.mockReset();
  getToday.mockRejectedValue(new ApiError(500, "UNKNOWN_ERROR", "sin datos en este test"));
});

describe("AdminLayout: ocho secciones, y los flags siguen mandando", () => {
  it("el rail muestra secciones, no pantallas: ocho como máximo, en el orden del mapa", async () => {
    renderAdmin(
      buildMe({
        features: {
          "cash.handovers": true,
          "inventory.perpetual": true,
          purchases: true,
          customers: true,
          "money.deposits": true,
          "money.obligations": true,
        },
      }),
    );

    await screen.findByRole("link", { name: "Hoy" });
    expect(seccionesDelRail()).toEqual([
      "Hoy",
      "Informes",
      "Caja",
      "Inventario",
      "Carta",
      "Plata",
      "Equipo",
      "Ajustes",
    ]);
  });

  it("una sección sin ninguna pantalla encendida no aparece", async () => {
    renderAdmin(buildMe({ features: { "cash.handovers": false, payroll: false, "pos.tips": false } }));

    await screen.findByRole("link", { name: "Hoy" });
    expect(screen.queryByRole("link", { name: "Equipo" })).not.toBeInTheDocument();
  });

  it("la sección aparece cuando alguna de sus pantallas está encendida", async () => {
    renderAdmin(buildMe({ features: { "cash.handovers": true } }));

    const equipo = await screen.findByRole("link", { name: "Equipo" });
    expect(equipo).toHaveAttribute("href", "/admin/personal");
  });

  it("una pantalla sin `feature` siempre está: Ajustes existe aunque todo esté apagado", async () => {
    renderAdmin(buildMe({ features: {} }));

    expect(await screen.findByRole("link", { name: "Ajustes" })).toHaveAttribute("href", "/admin/settings");
  });

  it("la entrada de la sección lleva a su primera pantalla encendida", async () => {
    renderAdmin(buildMe({ features: { "inventory.perpetual": false, purchases: true } }));

    // Sin inventario perpetuo, Inventario abre en Compras.
    expect(await screen.findByRole("link", { name: "Inventario" })).toHaveAttribute("href", "/admin/compras");
  });

  it("apagadas inventario y compras (y varianza y reposición), no hay sección Inventario", async () => {
    renderAdmin(
      buildMe({
        features: {
          "inventory.perpetual": false,
          purchases: false,
          "inventory.variance": false,
          "inventory.replenishment": false,
        },
      }),
    );

    await screen.findByRole("link", { name: "Hoy" });
    expect(screen.queryByRole("link", { name: "Inventario" })).not.toBeInTheDocument();
  });
});

describe("AdminLayout: las pestañas de la sección", () => {
  it("parado en una pantalla, la sección se marca en el rail y sus pantallas van en pestañas", async () => {
    renderAdmin(buildMe({ features: { "inventory.perpetual": true, purchases: true } }), undefined, "/admin/compras");

    const rail = await screen.findByRole("navigation", { name: "Secciones de administración" });
    expect(within(rail).getByRole("link", { name: "Inventario" })).toHaveAttribute("aria-current", "page");
    expect(within(rail).getByRole("link", { name: "Hoy" })).not.toHaveAttribute("aria-current");

    const tabs = pestanas("Inventario");
    expect(within(tabs).getByRole("link", { name: "Inventario" })).toHaveAttribute("href", "/admin/inventario");
    const compras = within(tabs).getByRole("link", { name: "Compras" });
    expect(compras).toHaveAttribute("href", "/admin/compras");
    expect(compras).toHaveAttribute("aria-current", "page");
  });

  it("los flags mandan también en las pestañas: Compras apagada no es pestaña", async () => {
    renderAdmin(
      buildMe({ features: { "inventory.perpetual": true, purchases: false, "inventory.variance": true } }),
      undefined,
      "/admin/inventario",
    );

    const tabs = await screen.findByRole("navigation", { name: "Pantallas de Inventario" });
    expect(within(tabs).queryByRole("link", { name: "Compras" })).not.toBeInTheDocument();
    expect(within(tabs).getByRole("link", { name: "Varianza y salud" })).toBeInTheDocument();
  });

  it("una sección de una sola pantalla no dibuja una fila de una pestaña", async () => {
    renderAdmin(buildMe({ features: { "money.obligations": true } }), undefined, "/admin/gastos");

    await screen.findByRole("link", { name: "Plata" });
    expect(screen.queryByRole("navigation", { name: "Pantallas de Plata" })).not.toBeInTheDocument();
  });

  it("los documentos fiscales siguen visibles con comprobante interno: van en Informes", async () => {
    renderAdmin(buildMe({ features: { "fiscal.dee_pos": false } }), undefined, "/admin/ventas");

    const tabs = await screen.findByRole("navigation", { name: "Pantallas de Informes" });
    // «Documentos» es lo que se ve; «Documentos fiscales», el nombre accesible.
    const documentos = within(tabs).getByRole("link", { name: "Documentos fiscales" });
    expect(documentos).toHaveTextContent("Documentos");
    expect(documentos).not.toHaveTextContent("fiscales");
    expect(within(tabs).getByRole("link", { name: "Notas" })).toBeInTheDocument();
  });

  it("la entrada Informes del rail abre la pantalla Informes, y Ventas sigue como pestaña", async () => {
    renderAdmin(buildMe({ features: { customers: true } }), undefined, "/admin/informes");

    const rail = await screen.findByRole("navigation", { name: "Secciones de administración" });
    expect(within(rail).getByRole("link", { name: "Informes" })).toHaveAttribute("href", "/admin/informes");
    const tabs = await screen.findByRole("navigation", { name: "Pantallas de Informes" });
    const nombres = within(tabs)
      .getAllByRole("link")
      .map((a) => a.getAttribute("aria-label") ?? a.textContent);
    expect(nombres.slice(0, 2)).toEqual(["Informes", "Ventas"]);
    expect(within(tabs).getByRole("link", { name: "Informes" })).toHaveAttribute("aria-current", "page");
  });

  it("los rangos de numeración son configuración: van en Ajustes", async () => {
    renderAdmin(buildMe(), undefined, "/admin/settings");

    const tabs = await screen.findByRole("navigation", { name: "Pantallas de Ajustes" });
    expect(within(tabs).getByRole("link", { name: "Rangos de numeración" })).toHaveAttribute(
      "href",
      "/admin/fiscal/rangos",
    );
  });

  it("Salud sostenida es de «Varianza y salud»: la sección es Inventario, no Informes", async () => {
    renderAdmin(
      buildMe({
        features: {
          "inventory.perpetual": true,
          "inventory.variance": true,
          "analytics.menu_engineering": true,
        },
      }),
      undefined,
      "/admin/analitica?tab=salud-sostenida",
    );

    const tabs = await screen.findByRole("navigation", { name: "Pantallas de Inventario" });
    expect(within(tabs).getByRole("link", { name: "Varianza y salud" })).toHaveAttribute("aria-current", "page");
    expect(screen.queryByRole("navigation", { name: "Pantallas de Informes" })).not.toBeInTheDocument();
  });
});

describe("AdminLayout: la salida", () => {
  // El defecto: `logout()` existía en `src/api/auth.ts` desde la fase 1a y
  // ninguna pantalla la llamaba. Se entraba al admin y no había forma de
  // salir salvo borrar la cookie a mano.
  it("hay un botón para salir en el encabezado", async () => {
    renderAdmin(buildMe());

    expect(await screen.findByRole("button", { name: /salir/i })).toBeInTheDocument();
  });

  it("al tocarlo cierra la sesión en el servidor y recién entonces la olvida acá", async () => {
    const clear = vi.fn();
    const user = userEvent.setup();
    renderAdmin(buildMe(), { clear });

    await user.click(await screen.findByRole("button", { name: /salir/i }));

    await waitFor(() => expect(logout).toHaveBeenCalledTimes(1));
    expect(clear).toHaveBeenCalledTimes(1);
  });

  it("si el servidor falla, la sesión NO se da por cerrada", async () => {
    // La cookie `httpOnly` la borra el servidor. Limpiar `me` igual dejaría
    // a la persona en `/login` con la sesión todavía viva: recarga y vuelve
    // a entrar sola, creyendo que había salido.
    logout.mockRejectedValue(new ApiError(500, "UNKNOWN_ERROR", "Error del servidor"));
    const clear = vi.fn();
    const user = userEvent.setup();
    renderAdmin(buildMe(), { clear });

    await user.click(await screen.findByRole("button", { name: /salir/i }));

    await waitFor(() => expect(logout).toHaveBeenCalledTimes(1));
    expect(clear).not.toHaveBeenCalled();
    // Y el botón queda usable para reintentar.
    expect(screen.getByRole("button", { name: /salir/i })).toBeEnabled();
  });
});

// ---------------------------------------------------------------------------
// El armazón rediseñado (`docs/PATRONES-ADMIN.md` § 1). Las cuatro cosas que
// el dueño nombró mirando la app desplegada: no había grupos, no había
// íconos propios, no había recuentos, y seguía la barra superior.
// ---------------------------------------------------------------------------

describe("AdminLayout: los íconos del rail", () => {
  it("cada sección trae su propio ícono: ninguno se repite y ninguno es el genérico de cuadrícula", async () => {
    renderAdmin(
      buildMe({
        features: {
          "cash.handovers": true,
          "inventory.perpetual": true,
          purchases: true,
          customers: true,
          "money.deposits": true,
          "money.obligations": true,
        },
      }),
    );

    await screen.findByRole("link", { name: "Hoy" });
    const rail = screen.getByRole("navigation", { name: "Secciones de administración" });
    const iconos = within(rail)
      .getAllByRole("link")
      .map((a) => a.querySelector("svg")?.getAttribute("class") ?? "");

    expect(iconos).toHaveLength(8);
    expect(iconos.filter((c) => c === "")).toEqual([]);
    expect(iconos.filter((c) => c.includes("lucide-layout-grid"))).toEqual([]);
    expect(new Set(iconos).size).toBe(iconos.length);
  });
});

describe("AdminLayout: los recuentos", () => {
  function conDatosDeHoy(overrides: Record<string, unknown> = {}) {
    listStores.mockResolvedValue([{ id: 7, name: "Chapinero" }]);
    getToday.mockResolvedValue({
      store_id: 7,
      business_date: "2026-09-21",
      open_orders: Array.from({ length: 9 }, (_, i) => ({ id: i + 1 })),
      ingredients_negative: Array.from({ length: 5 }, (_, i) => ({ ingredient_id: i + 1 })),
      ingredients_below_min: Array.from({ length: 9 }, (_, i) => ({ ingredient_id: i + 20 })),
      payables_overdue: [{ payable_id: 1, supplier_id: 1, supplier_name: "Carnes", due_date: "2026-09-01", balance: 10, days_overdue: 3 }],
      payables_pending_review_count: 1,
      pending_refunds_count: 2,
      ...overrides,
    });
  }

  const FLAGS = { "inventory.perpetual": true, purchases: true };

  it("la sección suma los recuentos de sus pantallas y los dice uno por uno", async () => {
    conDatosDeHoy();
    renderAdmin(buildMe({ features: FLAGS }));

    // El número se ve…
    const hoy = await screen.findByRole("link", { name: /^Hoy,/ });
    expect(hoy).toHaveTextContent("9");
    // …y se dice entero, con su unidad, para quien no lo ve.
    expect(hoy).toHaveAccessibleName("Hoy, 9 comandas abiertas");

    // 5 negativos + 9 bajo mínimo = 14 insumos, más 2 cuentas por pagar = 16.
    expect(
      screen.getByRole("link", {
        name: "Inventario, 14 insumos en alerta, 2 cuentas por pagar sin resolver",
      }),
    ).toHaveTextContent("16");
    expect(screen.getByRole("link", { name: "Caja, 2 devoluciones pendientes" })).toHaveTextContent("2");

    // Un solo pedido al servidor, el mismo que ya hacía la pantalla Hoy.
    await waitFor(() => expect(getToday).toHaveBeenCalledWith(7));
  });

  it("en las pestañas, cada pantalla muestra su propio recuento", async () => {
    conDatosDeHoy();
    renderAdmin(buildMe({ features: FLAGS }), undefined, "/admin/inventario");

    const tabs = await screen.findByRole("navigation", { name: "Pantallas de Inventario" });
    await waitFor(() =>
      expect(within(tabs).getByRole("link", { name: "Inventario, 14 insumos en alerta" })).toHaveTextContent("14"),
    );
    expect(
      within(tabs).getByRole("link", { name: "Compras, 2 cuentas por pagar sin resolver" }),
    ).toHaveTextContent("2");
  });

  it("un recuento en cero no se dibuja: una insignia en `0` es ruido permanente", async () => {
    conDatosDeHoy({ pending_refunds_count: 0, open_orders: [] });
    renderAdmin(buildMe({ features: FLAGS }));

    await waitFor(() => expect(getToday).toHaveBeenCalled());
    const caja = await screen.findByRole("link", { name: "Caja" });
    expect(caja).not.toHaveTextContent("0");
    expect(screen.getByRole("link", { name: "Hoy" })).not.toHaveTextContent("0");
  });

  it("sin sede elegida no se inventa un recuento ni se pide el día", async () => {
    renderAdmin(buildMe({ features: FLAGS }));

    await screen.findByRole("link", { name: "Hoy" });
    expect(getToday).not.toHaveBeenCalled();
  });
});

/**
 * **La barra superior volvió**, y con ella el reparto de `a2`. Este bloque
 * decía lo contrario —«se fue la barra superior»— y afirmaba pieza por pieza
 * el armazón anterior: una sola franja `md:hidden`, la sede en la cabeza de
 * la lateral y campana/tema/salida en el pie. Los tres se dieron vuelta a
 * propósito: el dueño miró la app desplegada contra la maqueta `a2` y pidió
 * ésta. Lo que los tests siguen defendiendo es lo mismo de antes —que
 * ninguno de los cinco controles compartidos se pierda y que cada uno esté
 * donde dice estar—; lo que cambió es dónde es eso.
 */
describe("AdminLayout: la barra superior de a2", () => {
  it("hay una barra de cuenta arriba, visible también en el escritorio", async () => {
    renderAdmin(buildMe());
    await screen.findByRole("link", { name: "Hoy" });

    const franjas = [...document.querySelectorAll("header")];
    expect(franjas).toHaveLength(1);
    // Ya no se esconde en el escritorio: es la barra de `a2`, no la franja
    // del cajón del móvil.
    expect(franjas[0].className).not.toContain("md:hidden");
    // La navegación del negocio NO está acá: sigue siendo de la lateral.
    expect(within(franjas[0]).queryByRole("navigation")).toBeNull();
  });

  it("los tres controles de cuenta viven en la barra: campana, tema y salida", async () => {
    renderAdmin(buildMe());
    await screen.findByRole("link", { name: "Hoy" });
    const barra = document.querySelector("header") as HTMLElement;

    expect(within(barra).getByRole("button", { name: /salir/i })).toBeInTheDocument();
    expect(within(barra).getByRole("button", { name: /modo (oscuro|claro)/i })).toBeInTheDocument();
    expect(within(barra).getByRole("button", { name: /Notificaciones/i })).toBeInTheDocument();

    // Y ya no están duplicados en la lateral del escritorio.
    const lateral = document.querySelector("aside") as HTMLElement;
    expect(within(lateral).queryByRole("button", { name: /salir/i })).toBeNull();
  });

  it("la sede baja de la lateral a la barra, y sigue siendo lo que alcanza a toda la app", async () => {
    listStores.mockResolvedValue([
      { id: 7, name: "Chapinero" },
      { id: 8, name: "Usaquén" },
    ]);
    renderAdmin(buildMe({ features: { multi_store: true } }));

    const barra = document.querySelector("header") as HTMLElement;
    const sede = await within(barra).findByRole("combobox", { name: "Sede activa" });
    expect(sede).toBeInTheDocument();
    // No quedó una segunda copia en la lateral.
    const lateral = document.querySelector("aside") as HTMLElement;
    expect(within(lateral).queryByRole("combobox", { name: "Sede activa" })).toBeNull();
  });

  it("con una sola sede la barra igual dice de dónde es lo que se mira", async () => {
    listStores.mockResolvedValue([{ id: 7, name: "Chapinero" }]);
    renderAdmin(buildMe());

    const barra = document.querySelector("header") as HTMLElement;
    // Sin desplegable —no hay nada que elegir— pero con el nombre a la vista:
    // `a2` nunca deja el hueco vacío.
    expect(await within(barra).findByText("Chapinero")).toBeInTheDocument();
    expect(within(barra).queryByRole("combobox", { name: "Sede activa" })).toBeNull();
  });

  it("la cabeza de la lateral dice la organización y la sede, y la persona vive en la barra", async () => {
    listStores.mockResolvedValue([{ id: 7, name: "Chapinero" }]);
    renderAdmin(buildMe());
    await screen.findByRole("link", { name: "Hoy" });

    const lateral = document.querySelector("aside") as HTMLElement;
    const nav = within(lateral).getByRole("navigation");
    const marca = within(lateral).getByText("Organización de prueba");
    // La identidad va ANTES de la navegación: es de quién es el escritorio.
    expect(marca.compareDocumentPosition(nav)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);

    const barra = document.querySelector("header") as HTMLElement;
    expect(within(barra).getByText(/Admin de prueba · administrador/)).toBeInTheDocument();
  });
});
