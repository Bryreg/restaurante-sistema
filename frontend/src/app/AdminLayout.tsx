import { useQuery } from "@tanstack/react-query";
import {
  Activity,
  BarChart3,
  Banknote,
  BellRing,
  BookOpen,
  CalendarDays,
  ClipboardList,
  Clock,
  Coins,
  CookingPot,
  FileText,
  Hash,
  Landmark,
  LayoutGrid,
  LogOut,
  type LucideIcon,
  Menu,
  Package,
  PackagePlus,
  Receipt,
  ScrollText,
  Settings,
  ShoppingCart,
  StickyNote,
  Store,
  Target,
  ToggleLeft,
  Undo2,
  Users,
  Wallet,
} from "lucide-react";
import { useState } from "react";
import { NavLink, Outlet } from "react-router-dom";
import { toast } from "sonner";

import { logout } from "@/api/auth";
import { getToday } from "@/api/reports";

import { NotificationBell } from "@/features/notifications/NotificationBell";
import { analyticsFeature } from "@/features/analytics";
import { bankingFeature } from "@/features/banking";
import { catalogFeature } from "@/features/catalog";
import { customersFeature } from "@/features/customers";
import { expensesFeature } from "@/features/expenses";
import { fiscalFeature } from "@/features/fiscal";
import { inventoryFeature } from "@/features/inventory";
import { ordersFeature } from "@/features/orders";
import { payrollFeature } from "@/features/payroll";
import { purchasesFeature } from "@/features/purchases";
import { recipesFeature } from "@/features/recipes";
import { reportsFeature } from "@/features/reports";
import { shiftsFeature } from "@/features/shifts";
import { RailItemContent, railItemClass } from "@/components/admin/RailItem";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { errorMessage } from "@/lib/errors";
import { cn } from "@/lib/utils";

import type { NavItem } from "./nav";
import { useDensity } from "./density";
import { useSession } from "./session";
import { StoreSelectionProvider, useStoreSelection } from "./storeContext";
import { ThemeToggle } from "./theme";

const OWN_NAV: NavItem[] = [
  { to: "/admin/features", label: "Funciones", feature: undefined },
  { to: "/admin/settings", label: "Configuración", feature: undefined },
  { to: "/admin/audit", label: "Historial", feature: undefined },
  { to: "/admin/notifications", label: "Notificaciones", feature: undefined },
];

/**
 * Orden de SPEC-NEGOCIO §9.3: Hoy, Ventas, Pedidos, Carta, Preparaciones e
 * Inventario (pedido 2a) se intercalan junto a Carta, (Dinero, Turnos y
 * personal ya estaban), Documentos fiscales/Rangos/Notas/Devoluciones
 * pendientes y Clientes (pedido 1b-2), **Compras** justo después de
 * Inventario (pedido 2b: "Carta y recetas, Preparaciones, Inventario,
 * Compras, Dinero..." — la fila de la tabla §9.3) — y `OWN_NAV` cierra
 * igual que antes.
 *
 * Fase 3 (`features/fase-3-dinero-control/spec.md` § T5): `bankingFeature`,
 * `expensesFeature` y `payrollFeature`/`analyticsFeature` se agregan justo
 * después de Compras y antes de fiscal/turnos — "Banco", "Gastos", "Nómina"/
 * "Propinas" e "Ingeniería de menú"/"Reposición" completan la fila "Dinero y
 * control" de §14 que `shiftsFeature` (turnos, caja) ya empezaba.
 *
 * **Esta función no cambió con el rediseño del armazón, y es a propósito.**
 * Qué entradas se muestran lo sigue decidiendo `hasFeature` exactamente como
 * antes; lo que el rail agrega —grupo, ícono, recuento, nombre corto— es
 * apariencia, y vive en `RAIL`. El orden de acá deja de mandar en el dibujo
 * (manda `GRUPOS`) pero sigue siendo el orden dentro de cada grupo.
 */
export function buildNav(hasFeature: (key: string) => boolean): NavItem[] {
  const all = [
    ...reportsFeature.adminNav,
    ...ordersFeature.adminNav,
    ...catalogFeature.adminNav,
    ...recipesFeature.adminNav,
    ...inventoryFeature.adminNav,
    ...purchasesFeature.adminNav,
    ...bankingFeature.adminNav,
    ...expensesFeature.adminNav,
    ...payrollFeature.adminNav,
    ...analyticsFeature.adminNav,
    ...fiscalFeature.adminNav,
    ...shiftsFeature.adminNav,
    ...customersFeature.adminNav,
    ...OWN_NAV,
  ];
  return all.filter((item) => !item.feature || hasFeature(item.feature));
}

// ---------------------------------------------------------------------------
// El rail: grupos, íconos, nombres cortos y recuentos
// (`docs/PATRONES-ADMIN.md` § 1).
// ---------------------------------------------------------------------------

/**
 * Los seis grupos, en el orden en que se dibujan. Un sustantivo cada uno, y
 * eso es lo que deja acortar el ítem: bajo `Ley`, «Documentos fiscales» es
 * **Documentos** sin perder nada, y el rail de 222 px deja de truncar.
 */
export const GRUPOS = ["Operación", "Costos", "Plata", "Ley", "Gente", "Sistema"] as const;
export type Grupo = (typeof GRUPOS)[number];

/** Las cuatro entradas que llevan recuento. Todas salen de `GET /admin/today`. */
export type Recuento = "pedidos" | "inventario" | "compras" | "devoluciones";

export interface FilaDelRail {
  grupo: Grupo;
  /** El ícono propio. Ninguna entrada comparte el suyo con otra. */
  icon: LucideIcon;
  /** El texto visible en el rail: corto, para que entre en 222 px sin truncar. */
  label: string;
  /**
   * El nombre completo, que es el nombre accesible del enlace y su `title`.
   * **Tiene que ser idéntico al `label` del `NavItem` del dominio**, y
   * `__tests__/adminRail.test.tsx` lo verifica entrada por entrada: acá se
   * escribe a mano para que el censo de controles lo vea —el censo lee el
   * código y sólo mira archivos `.tsx`, así que los rótulos que viven en el
   * `index.ts` de cada dominio no estaban protegidos por nada—.
   */
  title: string;
  cuenta?: Recuento;
}

/**
 * De ruta a cómo se lee en el rail. La clave es el `to` del `NavItem`, que es
 * lo único estable: el dominio decide **si** la entrada existe (su flag) y **a
 * dónde** va; el armazón decide cómo se ve.
 *
 * Los cuatro nombres acortados son exactamente los que nombra el patrón 1
 * —Documentos, Rangos, Devoluciones, Turnos—. El resto entra entero: medido,
 * «Ingeniería de menú» son 18 caracteres y el rail da para 180 px de texto.
 * «Configuración» se queda como está y no pasa a «Ajustes» aunque la maqueta
 * lo llame así: el nombre corto tiene que ser un prefijo del largo para que
 * el nombre accesible siga conteniendo lo que se ve (WCAG 2.5.3), y
 * «Ajustes» no lo es.
 */
export const RAIL: Record<string, FilaDelRail> = {
  // Operación — lo que está pasando ahora.
  "/admin/hoy": { grupo: "Operación", icon: CalendarDays, label: "Hoy", title: "Hoy" },
  "/admin/ventas": { grupo: "Operación", icon: BarChart3, label: "Ventas", title: "Ventas" },
  "/admin/pedidos": {
    grupo: "Operación",
    icon: ClipboardList,
    label: "Pedidos",
    title: "Pedidos",
    cuenta: "pedidos",
  },

  // Costos — la cadena que convierte un plato en plata gastada: la receta de
  // la Carta es lo que lo vuelve un costo, y por eso va con Inventario y
  // Compras y no con Operación.
  "/admin/carta": { grupo: "Costos", icon: BookOpen, label: "Carta", title: "Carta" },
  "/admin/preparaciones": {
    grupo: "Costos",
    icon: CookingPot,
    label: "Preparaciones",
    title: "Preparaciones",
  },
  "/admin/inventario": {
    grupo: "Costos",
    icon: Package,
    label: "Inventario",
    title: "Inventario",
    cuenta: "inventario",
  },
  "/admin/compras": {
    grupo: "Costos",
    icon: ShoppingCart,
    label: "Compras",
    title: "Compras",
    cuenta: "compras",
  },
  "/admin/analitica": {
    grupo: "Costos",
    icon: Target,
    label: "Ingeniería de menú",
    title: "Ingeniería de menú",
  },
  "/admin/analitica?tab=varianza": {
    grupo: "Costos",
    icon: Activity,
    label: "Varianza y salud",
    title: "Varianza y salud",
  },
  "/admin/analitica?tab=reposicion": {
    grupo: "Costos",
    icon: PackagePlus,
    label: "Reposición",
    title: "Reposición",
  },

  // Plata.
  "/admin/dinero": { grupo: "Plata", icon: Banknote, label: "Dinero", title: "Dinero" },
  "/admin/banco": { grupo: "Plata", icon: Landmark, label: "Banco", title: "Banco" },
  "/admin/gastos": { grupo: "Plata", icon: Receipt, label: "Gastos", title: "Gastos" },
  "/admin/nomina": { grupo: "Plata", icon: Wallet, label: "Nómina", title: "Nómina" },
  "/admin/nomina?tab=propinas": {
    grupo: "Plata",
    icon: Coins,
    label: "Propinas",
    title: "Propinas",
  },

  // Ley.
  "/admin/fiscal/documentos": {
    grupo: "Ley",
    icon: FileText,
    label: "Documentos",
    title: "Documentos fiscales",
  },
  "/admin/fiscal/rangos": {
    grupo: "Ley",
    icon: Hash,
    label: "Rangos",
    title: "Rangos de numeración",
  },
  "/admin/fiscal/notas": { grupo: "Ley", icon: StickyNote, label: "Notas", title: "Notas" },
  "/admin/fiscal/devoluciones-pendientes": {
    grupo: "Ley",
    icon: Undo2,
    label: "Devoluciones",
    title: "Devoluciones pendientes",
    cuenta: "devoluciones",
  },

  // Gente. `Clock` y no una silueta: «Clientes» ya es una silueta doble, y a
  // 16 px una persona y dos personas se confunden.
  "/admin/personal": { grupo: "Gente", icon: Clock, label: "Turnos", title: "Turnos y personal" },
  "/admin/clientes": { grupo: "Gente", icon: Users, label: "Clientes", title: "Clientes" },

  // Sistema. `BellRing` para la pantalla de reglas, `Bell` para la campana del
  // pie: son dos cosas distintas y no pueden tener el mismo ícono.
  "/admin/features": { grupo: "Sistema", icon: ToggleLeft, label: "Funciones", title: "Funciones" },
  "/admin/settings": {
    grupo: "Sistema",
    icon: Settings,
    label: "Configuración",
    title: "Configuración",
  },
  "/admin/audit": { grupo: "Sistema", icon: ScrollText, label: "Historial", title: "Historial" },
  "/admin/notifications": {
    grupo: "Sistema",
    icon: BellRing,
    label: "Notificaciones",
    title: "Notificaciones",
  },
};

/**
 * La red de seguridad del rail: una entrada que el dominio agregue y que
 * nadie haya archivado acá **se sigue viendo**, al final de Sistema y con el
 * ícono genérico. `adminRail.test.tsx` falla si eso pasa, pero fallar en CI
 * no puede costar una entrada de navegación en producción.
 */
function filaDe(item: NavItem): FilaDelRail {
  return (
    RAIL[item.to] ?? { grupo: "Sistema", icon: LayoutGrid, label: item.label, title: item.label }
  );
}

/**
 * El orden **dentro** de un grupo es el de `RAIL`, no el de `buildNav`.
 *
 * `buildNav` concatena los dominios en el orden en que se fueron agregando
 * por fase, y eso alcanzaba cuando la lista era plana. Agrupada ya no: como
 * `shiftsFeature` entró en la fase 3, «Dinero» caía **después** de Banco,
 * Nómina y Propinas, y la pantalla principal de plata quedaba al final de su
 * propio grupo. El dominio sigue decidiendo si la entrada existe; el orden
 * en que se leen las cuatro de Plata es del armazón.
 */
const ORDEN = Object.keys(RAIL);
function porOrdenDelRail(a: NavItem, b: NavItem): number {
  const ia = ORDEN.indexOf(a.to);
  const ib = ORDEN.indexOf(b.to);
  // Una entrada que no esté en la tabla va al final, nunca se pierde.
  return (ia === -1 ? ORDEN.length : ia) - (ib === -1 ? ORDEN.length : ib);
}

/**
 * Los recuentos, y de dónde salen: **`GET /admin/today`, con la misma
 * `queryKey` que usa la pantalla Hoy** (`["admin-today", storeId]`). No hay
 * ni un pedido nuevo al servidor —parado en Hoy, react-query sirve la misma
 * entrada de caché a las dos y sale una sola petición—, y los cuatro números
 * son los que ya mira el dueño en los avisos de esa pantalla, así que el
 * rail y los avisos no pueden decir cosas distintas.
 *
 * El del inventario suma negativos **y** bajo mínimo: los avisos de Hoy
 * cuentan los dos por separado y una insignia que muestre sólo uno
 * sub-informa la pantalla (`docs/PATRONES-ADMIN.md`, desvío 3).
 *
 * Sin `refetchInterval` a propósito: la pantalla Hoy sondea cada 30 s y el
 * rail se cuelga de ese sondeo cuando estás ahí. Ponerlo también acá haría
 * sondear `/admin/today` desde las veinticuatro pantallas.
 */
function useRecuentos(storeId: number | null): Partial<Record<Recuento, number>> {
  const { data } = useQuery({
    queryKey: ["admin-today", storeId],
    queryFn: () => getToday(storeId as number),
    enabled: storeId !== null,
  });

  if (!data) return {};
  return {
    pedidos: (data.open_orders ?? []).length,
    inventario: (data.ingredients_negative ?? []).length + (data.ingredients_below_min ?? []).length,
    compras: (data.payables_overdue ?? []).length + (data.payables_pending_review_count ?? 0),
    devoluciones: data.pending_refunds_count ?? 0,
  };
}

/** Qué dice el recuento en voz alta. La insignia es un número; esto es el número con su unidad. */
const DICE: Record<Recuento, (n: number) => string> = {
  pedidos: (n) => `${n} comanda${n === 1 ? "" : "s"} abierta${n === 1 ? "" : "s"}`,
  inventario: (n) => `${n} insumo${n === 1 ? "" : "s"} en alerta`,
  compras: (n) => `${n} cuenta${n === 1 ? "" : "s"} por pagar sin resolver`,
  devoluciones: (n) => `${n} pendiente${n === 1 ? "" : "s"}`,
};

function SidebarNav({
  items,
  counts,
  onNavigate,
  touch = false,
}: {
  items: NavItem[];
  counts: Partial<Record<Recuento, number>>;
  onNavigate?: () => void;
  touch?: boolean;
}) {
  return (
    <nav aria-label="Secciones de administración" className="flex flex-col">
      {GRUPOS.map((grupo) => {
        const delGrupo = items
          .filter((item) => filaDe(item).grupo === grupo)
          .sort(porOrdenDelRail);
        if (delGrupo.length === 0) return null;
        return (
          <div key={grupo} className="flex flex-col">
            {/* El rótulo de grupo no es un encabezado de navegación con
                enlaces propios: es la etiqueta del bloque. `aria-hidden` lo
                saca del árbol y el `aria-label` del bloque lo dice una vez. */}
            <p
              aria-hidden="true"
              className="px-2 pb-1 pt-2.5 text-xs font-medium uppercase tracking-wider text-muted-foreground"
            >
              {grupo}
            </p>
            <div className="flex flex-col" role="group" aria-label={grupo}>
              {delGrupo.map((item) => {
                const fila = filaDe(item);
                const n = fila.cuenta ? counts[fila.cuenta] : undefined;
                const nombre =
                  fila.cuenta && n != null && n > 0
                    ? `${fila.title}, ${DICE[fila.cuenta](n)}`
                    : fila.title;
                return (
                  <NavLink
                    key={item.to}
                    to={item.to}
                    onClick={onNavigate}
                    title={fila.title}
                    aria-label={nombre}
                    className={({ isActive }) => railItemClass({ active: isActive, touch })}
                  >
                    <RailItemContent icon={fila.icon} label={fila.label} count={n} />
                  </NavLink>
                );
              })}
            </div>
          </div>
        );
      })}
    </nav>
  );
}

/**
 * La identidad, en la cabeza del rail: de quién es este escritorio. Va junto
 * al selector de sede porque las dos cosas contestan «¿de quién y de dónde es
 * lo que estoy mirando?», y esa pregunta alcanza a toda la app.
 */
function Identidad(): React.JSX.Element {
  const { me } = useSession();
  return (
    <div className="flex items-center gap-2 px-2 py-1">
      <Store className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      <div className="min-w-0">
        <p className="truncate text-sm font-semibold leading-tight">
          {me?.organization?.name ?? "Restaurante Sistema"}
        </p>
        <p className="truncate text-xs text-muted-foreground">{me?.user?.name}</p>
      </div>
    </div>
  );
}

/**
 * El selector de sede, ahora en la cabeza de la lateral y no en una barra
 * superior que ya no existe (`docs/PATRONES-ADMIN.md` § 1). El argumento es
 * el reparto del alcance: **la sede alcanza a toda la app**, el período vive
 * en la cabecera de cada pantalla y lo que filtra una tabla vive en la barra
 * de esa tabla. Un control puesto en el lugar equivocado miente sobre a
 * cuánto alcanza.
 *
 * La condición para dibujarlo no cambió: `multi_store` encendida y más de
 * una sede.
 */
function StoreSwitcher() {
  const { hasFeature } = useSession();
  const { stores, activeStoreId, setActiveStoreId } = useStoreSelection();

  if (!hasFeature("multi_store") || stores.length <= 1) {
    return null;
  }

  return (
    <Select
      value={activeStoreId ? String(activeStoreId) : undefined}
      onValueChange={(next) => setActiveStoreId(Number(next))}
    >
      <SelectTrigger className="h-9 w-full" aria-label="Sede activa">
        <SelectValue placeholder="Elegí una sede" />
      </SelectTrigger>
      <SelectContent>
        {stores.map((store) => (
          <SelectItem key={store.id} value={String(store.id)}>
            {store.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/**
 * La salida del admin. Existía `logout()` en `src/api/auth.ts` desde la fase
 * 1a y **ninguna pantalla la llamaba**: se podía entrar al admin y no había
 * forma de salir salvo borrar la cookie a mano. Con las credenciales del
 * seed publicadas, además, «cerrar sesión» es lo primero que alguien
 * necesita en una PC compartida.
 *
 * Si el servidor falla, la sesión del cliente NO se limpia: la cookie sigue
 * viva, así que dar por cerrada una sesión que no se cerró es peor que
 * avisar del error — al recargar volvería a entrar sola.
 */
function LogoutButton({ touch = false }: { touch?: boolean }): React.JSX.Element {
  const { clear } = useSession();
  const [saliendo, setSaliendo] = useState(false);

  async function handleLogout() {
    setSaliendo(true);
    try {
      await logout();
      // `clear()` deja `me` en `null` y el guard `RequireAdmin` de
      // `router.tsx` redirige a `/login`; no hace falta navegar a mano.
      clear();
    } catch (err) {
      toast.error(errorMessage(err));
      setSaliendo(false);
    }
  }

  return (
    <button
      type="button"
      className={railItemClass({ touch, className: "disabled:opacity-50" })}
      title="Cerrar sesión"
      onClick={() => void handleLogout()}
      disabled={saliendo}
    >
      <RailItemContent icon={LogOut} label="Salir" />
    </button>
  );
}

/**
 * El pie del rail: los tres controles de cuenta que bajaron de la barra
 * superior. Están abajo y no arriba porque no son navegación —no llevan a
 * una pantalla del negocio— y porque el eje escaso de un portátil es el
 * vertical: la barra superior cobraba 56 px de alto en las veinticuatro.
 */
function RailPie({ storeId, touch = false }: { storeId: number | null; touch?: boolean }) {
  return (
    <div className="mt-auto flex shrink-0 flex-col border-t pt-1.5">
      <NotificationBell storeId={storeId} variant="rail" touch={touch} />
      <ThemeToggle variant="rail" touch={touch} />
      <LogoutButton touch={touch} />
    </div>
  );
}

/** El rail entero: identidad, sede, navegación agrupada y el pie de cuenta. */
function RailContenido({
  items,
  counts,
  storeId,
  onNavigate,
  touch = false,
}: {
  items: NavItem[];
  counts: Partial<Record<Recuento, number>>;
  storeId: number | null;
  onNavigate?: () => void;
  touch?: boolean;
}) {
  return (
    <>
      <div className="flex shrink-0 flex-col gap-2 pb-2">
        <Identidad />
        <StoreSwitcher />
      </div>
      {/* Sólo la lista rueda: identidad, sede y pie quedan fijos. Con las
          veinticinco entradas encendidas el rail mide más que un portátil, y
          «Salir» no puede quedar bajo el pliegue. */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <SidebarNav items={items} counts={counts} onNavigate={onNavigate} touch={touch} />
      </div>
      <RailPie storeId={storeId} touch={touch} />
    </>
  );
}

function AdminChrome(): React.JSX.Element {
  // Escritorio del dueño: cuerpo 14,5 px y filas de 34 px (m2b `.oficina`).
  useDensity("oficina");
  const { hasFeature, me } = useSession();
  const { activeStoreId } = useStoreSelection();
  const [mobileOpen, setMobileOpen] = useState(false);
  const items = buildNav(hasFeature);
  const counts = useRecuentos(activeStoreId);

  return (
    <div className="oficina flex min-h-screen bg-background text-foreground">
      {/* 222 px medidos: el ancho al que los cuatro nombres largos dejan de
          truncar una vez acortados (`docs/PATRONES-ADMIN.md` § 1). */}
      <aside
        className={cn(
          "sticky top-0 hidden h-screen w-[222px] shrink-0 flex-col border-r bg-muted p-2 md:flex",
        )}
      >
        <RailContenido items={items} counts={counts} storeId={activeStoreId} />
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        {/* No hay barra superior en el escritorio (`md:hidden`). En el móvil
            el rail no cabe, así que queda esta franja con el cajón y nada
            más: el argumento del patrón 1 —los 56 px de alto que la barra le
            cobra a un portátil— es sobre el escritorio, donde el rail sí
            está siempre a la vista. */}
        <header className="flex h-12 items-center gap-2 border-b px-3 md:hidden">
          <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
            <SheetTrigger
              render={<Button type="button" variant="ghost" size="icon" aria-label="Abrir menú" />}
            >
              <Menu className="size-5" aria-hidden="true" />
            </SheetTrigger>
            <SheetContent side="left" className="flex w-[17rem] flex-col p-2">
              <SheetHeader className="p-0">
                <SheetTitle className="sr-only">
                  {me?.organization?.name ?? "Restaurante Sistema"}
                </SheetTitle>
              </SheetHeader>
              <RailContenido
                items={items}
                counts={counts}
                storeId={activeStoreId}
                onNavigate={() => setMobileOpen(false)}
                touch
              />
            </SheetContent>
          </Sheet>
          <p className="truncate text-sm font-semibold">
            {me?.organization?.name ?? "Restaurante Sistema"}
          </p>
        </header>
        <main className="min-w-0 flex-1 p-4 md:p-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}

/** Sidebar armado desde `NavItem[]` propios + `shiftsFeature`/`catalogFeature`. */
export default function AdminLayout(): React.JSX.Element {
  return (
    <StoreSelectionProvider>
      <AdminChrome />
    </StoreSelectionProvider>
  );
}
