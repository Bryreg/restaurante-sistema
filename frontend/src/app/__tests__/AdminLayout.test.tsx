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
    adminNav: [{ to: "/admin/shifts", label: "Turnos y personal", feature: "cash.handovers" }],
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
) {
  return renderWithProviders(
    <Routes>
      <Route path="/admin" element={<AdminLayout />}>
        <Route index element={<div>contenido</div>} />
      </Route>
    </Routes>,
    { me, route: "/admin", session },
  );
}

beforeEach(() => {
  logout.mockReset();
  logout.mockResolvedValue(undefined);
  listStores.mockReset();
  listStores.mockResolvedValue([]);
  getToday.mockReset();
  getToday.mockRejectedValue(new ApiError(500, "UNKNOWN_ERROR", "sin datos en este test"));
});

describe("AdminLayout: sidebar por features", () => {
  it("oculta una entrada de navegación cuya feature está apagada", async () => {
    renderAdmin(buildMe({ features: { "cash.handovers": false } }));

    expect(await screen.findByRole("link", { name: "Carta" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Turnos y personal" })).not.toBeInTheDocument();
  });

  it("muestra la entrada cuando su feature está encendida", async () => {
    renderAdmin(buildMe({ features: { "cash.handovers": true } }));

    expect(await screen.findByRole("link", { name: "Turnos y personal" })).toBeInTheDocument();
  });

  it("una entrada sin `feature` siempre se muestra (Funciones, Configuración…)", async () => {
    renderAdmin(buildMe({ features: {} }));

    expect(await screen.findByRole("link", { name: "Funciones" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Configuración" })).toBeInTheDocument();
  });

  it("integra Hoy, Ventas, Pedidos, Documentos fiscales (núcleo, sin flag) y Clientes según su feature — pedido 1b-2, sin mockear esos dominios", async () => {
    renderAdmin(buildMe({ features: { customers: true } }));

    expect(await screen.findByRole("link", { name: "Hoy" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Ventas" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Pedidos" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Documentos fiscales" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Rangos de numeración" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Clientes" })).toBeInTheDocument();
  });

  it("«Clientes» respeta su feature: apagada, no se muestra", async () => {
    renderAdmin(buildMe({ features: { customers: false } }));

    await screen.findByRole("link", { name: "Hoy" });
    expect(screen.queryByRole("link", { name: "Clientes" })).not.toBeInTheDocument();
  });

  it("«Inventario» (inventory.perpetual) y «Preparaciones» (catalog.preps) — pedido 2a: apagadas, no se muestran", async () => {
    renderAdmin(buildMe({ features: { "inventory.perpetual": false, "catalog.preps": false } }));

    await screen.findByRole("link", { name: "Hoy" });
    expect(screen.queryByRole("link", { name: "Inventario" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Preparaciones" })).not.toBeInTheDocument();
  });

  it("«Inventario» y «Preparaciones» aparecen cuando su feature está encendida", async () => {
    renderAdmin(buildMe({ features: { "inventory.perpetual": true, "catalog.preps": true } }));

    expect(await screen.findByRole("link", { name: "Inventario" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Preparaciones" })).toBeInTheDocument();
  });

  it("«Compras» (purchases) — pedido 2b: apagada, no se muestra", async () => {
    renderAdmin(buildMe({ features: { purchases: false } }));

    await screen.findByRole("link", { name: "Hoy" });
    expect(screen.queryByRole("link", { name: "Compras" })).not.toBeInTheDocument();
  });

  it("«Compras» aparece cuando purchases está encendida, y enlaza a /admin/compras", async () => {
    renderAdmin(buildMe({ features: { purchases: true } }));

    const link = await screen.findByRole("link", { name: "Compras" });
    expect(link).toBeInTheDocument();
    expect(link).toHaveAttribute("href", "/admin/compras");
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

/**
 * `@/features/shifts` está mockeado arriba con una ruta que el producto no
 * tiene (`/admin/shifts`), para probar el filtrado por flags. Esa entrada cae
 * a propósito en la red de seguridad del rail —fondo de Sistema, ícono
 * genérico— y no es lo que estas afirmaciones miden. Que **ninguna** entrada
 * real caiga ahí lo prueba `adminRail.test.tsx`, que no mockea nada.
 */
const RUTA_DEL_MOCK = "/admin/shifts";

function entradasDelRail() {
  return [...document.querySelectorAll<HTMLAnchorElement>("nav a[href^='/admin']")].filter(
    (a) => a.getAttribute("href") !== RUTA_DEL_MOCK,
  );
}

describe("AdminLayout: el rail agrupado", () => {
  it("las entradas vienen repartidas en los seis grupos con rótulo, no en una lista plana", async () => {
    renderAdmin(
      buildMe({
        features: {
          "inventory.perpetual": true,
          purchases: true,
          customers: true,
          "money.deposits": true,
        },
      }),
    );

    await screen.findByRole("link", { name: "Hoy" });
    for (const grupo of [
      "EL DÍA",
      "LA CARTA Y EL COSTO",
      "LA PLATA",
      "LO FISCAL",
      "LA GENTE",
      "EL SISTEMA",
    ]) {
      expect(screen.getByRole("group", { name: grupo })).toBeInTheDocument();
    }
    // Y cada entrada vive dentro de su grupo, no suelta en la navegación.
    expect(
      within(screen.getByRole("group", { name: "EL DÍA" })).getByRole("link", { name: "Hoy" }),
    ).toBeInTheDocument();
    expect(
      within(screen.getByRole("group", { name: "LO FISCAL" })).getByRole("link", {
        name: "Documentos fiscales",
      }),
    ).toBeInTheDocument();
  });

  it("cada entrada trae su propio ícono: ninguno se repite y ninguno es el genérico de cuadrícula", async () => {
    renderAdmin(
      buildMe({
        features: {
          "inventory.perpetual": true,
          "catalog.preps": true,
          purchases: true,
          customers: true,
          "money.deposits": true,
          "money.obligations": true,
          payroll: true,
          "pos.tips": true,
          "analytics.menu_engineering": true,
          "inventory.variance": true,
          "inventory.replenishment": true,
        },
      }),
    );

    await screen.findByRole("link", { name: "Hoy" });
    const iconos = entradasDelRail().map((a) => a.querySelector("svg")?.getAttribute("class") ?? "");

    expect(iconos.length).toBeGreaterThanOrEqual(20);
    expect(iconos.filter((c) => c === "")).toEqual([]);
    expect(iconos.filter((c) => c.includes("lucide-layout-grid"))).toEqual([]);
    expect(new Set(iconos).size).toBe(iconos.length);
  });

  it("el nombre corto es lo que se ve y el largo es el nombre accesible", async () => {
    renderAdmin(buildMe());

    // «Documentos fiscales» no entra en 222 px; «Documentos» sí, y el enlace
    // se sigue llamando como se llamaba.
    const enlace = await screen.findByRole("link", { name: "Documentos fiscales" });
    expect(enlace).toHaveTextContent("Documentos");
    expect(enlace).not.toHaveTextContent("fiscales");
    expect(enlace).toHaveAttribute("title", "Documentos fiscales");
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

  it("las cuatro entradas con recuento lo muestran, y sale de `GET /admin/today`", async () => {
    conDatosDeHoy();
    renderAdmin(buildMe({ features: FLAGS }));

    // El número se ve…
    const pedidos = await screen.findByRole("link", { name: /^Pedidos,/ });
    expect(pedidos).toHaveTextContent("9");
    // …y se dice entero, con su unidad, para quien no lo ve.
    expect(pedidos).toHaveAccessibleName("Pedidos, 9 comandas abiertas");

    // 5 negativos + 9 bajo mínimo = 14: los avisos de Hoy cuentan los dos por
    // separado y una insignia que muestre sólo uno sub-informa la pantalla.
    expect(screen.getByRole("link", { name: "Inventario, 14 insumos en alerta" })).toHaveTextContent("14");
    expect(
      screen.getByRole("link", { name: "Compras, 2 cuentas por pagar sin resolver" }),
    ).toHaveTextContent("2");
    expect(
      screen.getByRole("link", { name: "Devoluciones pendientes, 2 pendientes" }),
    ).toHaveTextContent("2");

    // Un solo pedido al servidor, el mismo que ya hacía la pantalla Hoy.
    await waitFor(() => expect(getToday).toHaveBeenCalledWith(7));
  });

  it("un recuento en cero no se dibuja: una insignia en `0` es ruido permanente", async () => {
    conDatosDeHoy({ pending_refunds_count: 0, open_orders: [] });
    renderAdmin(buildMe({ features: FLAGS }));

    const devoluciones = await screen.findByRole("link", { name: "Devoluciones pendientes" });
    expect(devoluciones).not.toHaveTextContent("0");
    expect(screen.getByRole("link", { name: "Pedidos" })).toBeInTheDocument();
  });

  it("sin sede elegida no se inventa un recuento ni se pide el día", async () => {
    renderAdmin(buildMe({ features: FLAGS }));

    await screen.findByRole("link", { name: "Pedidos" });
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
