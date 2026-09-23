import { useQuery } from "@tanstack/react-query";
import {
  Activity,
  BarChart3,
  Banknote,
  BellRing,
  BookOpen,
  CalendarDays,
  CircleAlert,
  ClipboardList,
  Clock,
  Coins,
  CookingPot,
  Ellipsis,
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
import { useState, useSyncExternalStore } from "react";
import { Link, NavLink, Outlet, useLocation } from "react-router-dom";
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
 * Los seis grupos, en el orden en que se dibujan, **con los nombres de la
 * maqueta `a2`** (`admin/a2/direccion.html`, arreglo `NAV`): el dueño la
 * miró contra la app desplegada y pidió «tal cual el diseño a2».
 *
 * Eran `Operación · Costos · Plata · Ley · Gente · Sistema`, un sustantivo
 * cada uno. a2 los escribe como frases con artículo —`EL DÍA`, `LA CARTA Y
 * EL COSTO`, `LO FISCAL`— que es cómo el dueño los nombra en voz alta. El
 * argumento que sostenía los sustantivos cortos era el ancho del rótulo de
 * grupo, y el rótulo de grupo no compite con nada: va solo en su renglón, a
 * 10 px, y `LA CARTA Y EL COSTO` entra en los 222 px sin truncar.
 *
 * Lo que **no** cambia es el nombre corto de cada entrada (`Documentos`,
 * `Rangos`, `Turnos`, `Devoluciones`): a2 los escribe largos y por eso
 * trunca «Devoluciones pend…» en su propio riel de 214 px. El corto tiene
 * que seguir siendo prefijo del largo para que el nombre accesible contenga
 * lo que se ve (WCAG 2.5.3), y truncar pierde eso.
 */
export const GRUPOS = [
  "¿CÓMO VA?",
  "¿QUÉ VENDÍ?",
  "¿CUÁNTO ME CUESTA?",
  "¿DÓNDE ESTÁ LA PLATA?",
  "¿ESTOY AL DÍA CON LA DIAN?",
  "¿QUIÉN TRABAJA?",
  "AJUSTES",
] as const;
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
  // ¿CÓMO VA? — la portada: el pulso del día y lo que requiere atención.
  "/admin/hoy": { grupo: "¿CÓMO VA?", icon: CalendarDays, label: "Hoy", title: "Hoy" },

  // ¿QUÉ VENDÍ? — la venta y a quién.
  "/admin/ventas": { grupo: "¿QUÉ VENDÍ?", icon: BarChart3, label: "Ventas", title: "Ventas" },
  "/admin/pedidos": {
    grupo: "¿QUÉ VENDÍ?",
    icon: ClipboardList,
    label: "Pedidos",
    title: "Pedidos",
    cuenta: "pedidos",
  },
  "/admin/clientes": { grupo: "¿QUÉ VENDÍ?", icon: Users, label: "Clientes", title: "Clientes" },

  // ¿CUÁNTO ME CUESTA? — la cadena que convierte un plato en plata gastada:
  // la ficha de la Carta lo vuelve un costo, por eso va con Inventario y Compras.
  "/admin/carta": { grupo: "¿CUÁNTO ME CUESTA?", icon: BookOpen, label: "Carta", title: "Carta" },
  "/admin/preparaciones": {
    grupo: "¿CUÁNTO ME CUESTA?",
    icon: CookingPot,
    label: "Preparaciones",
    title: "Preparaciones",
  },
  "/admin/inventario": {
    grupo: "¿CUÁNTO ME CUESTA?",
    icon: Package,
    label: "Inventario",
    title: "Inventario",
    cuenta: "inventario",
  },
  "/admin/compras": {
    grupo: "¿CUÁNTO ME CUESTA?",
    icon: ShoppingCart,
    label: "Compras",
    title: "Compras",
    cuenta: "compras",
  },
  "/admin/analitica": {
    grupo: "¿CUÁNTO ME CUESTA?",
    icon: Target,
    label: "Ingeniería de menú",
    title: "Ingeniería de menú",
  },
  "/admin/analitica?tab=varianza": {
    grupo: "¿CUÁNTO ME CUESTA?",
    icon: Activity,
    label: "Varianza y salud",
    title: "Varianza y salud",
  },
  "/admin/analitica?tab=reposicion": {
    grupo: "¿CUÁNTO ME CUESTA?",
    icon: PackagePlus,
    label: "Reposición",
    title: "Reposición",
  },

  // ¿DÓNDE ESTÁ LA PLATA? — caja, banco y gastos. Dinero abre el grupo.
  "/admin/dinero": { grupo: "¿DÓNDE ESTÁ LA PLATA?", icon: Banknote, label: "Dinero", title: "Dinero" },
  "/admin/banco": { grupo: "¿DÓNDE ESTÁ LA PLATA?", icon: Landmark, label: "Banco", title: "Banco" },
  "/admin/gastos": { grupo: "¿DÓNDE ESTÁ LA PLATA?", icon: Receipt, label: "Gastos", title: "Gastos" },

  // ¿ESTOY AL DÍA CON LA DIAN? — documentos, numeración, notas y devoluciones.
  "/admin/fiscal/documentos": {
    grupo: "¿ESTOY AL DÍA CON LA DIAN?",
    icon: FileText,
    label: "Documentos",
    title: "Documentos fiscales",
  },
  "/admin/fiscal/rangos": {
    grupo: "¿ESTOY AL DÍA CON LA DIAN?",
    icon: Hash,
    label: "Rangos",
    title: "Rangos de numeración",
  },
  "/admin/fiscal/notas": { grupo: "¿ESTOY AL DÍA CON LA DIAN?", icon: StickyNote, label: "Notas", title: "Notas" },
  "/admin/fiscal/devoluciones-pendientes": {
    grupo: "¿ESTOY AL DÍA CON LA DIAN?",
    icon: Undo2,
    label: "Devoluciones",
    title: "Devoluciones pendientes",
    cuenta: "devoluciones",
  },

  // ¿QUIÉN TRABAJA? — turnos del personal primero; después lo que se les paga.
  // `Clock` y no una silueta: «Clientes» ya es una silueta doble.
  "/admin/personal": { grupo: "¿QUIÉN TRABAJA?", icon: Clock, label: "Turnos", title: "Turnos y personal" },
  "/admin/nomina": { grupo: "¿QUIÉN TRABAJA?", icon: Wallet, label: "Nómina", title: "Nómina" },
  "/admin/nomina?tab=propinas": {
    grupo: "¿QUIÉN TRABAJA?",
    icon: Coins,
    label: "Propinas",
    title: "Propinas",
  },

  // AJUSTES — al pie. `BellRing` para la pantalla de reglas, `Bell` para la
  // campana: son dos cosas distintas y no pueden tener el mismo ícono.
  "/admin/features": { grupo: "AJUSTES", icon: ToggleLeft, label: "Funciones", title: "Funciones" },
  "/admin/settings": {
    grupo: "AJUSTES",
    icon: Settings,
    label: "Configuración",
    title: "Configuración",
  },
  "/admin/audit": { grupo: "AJUSTES", icon: ScrollText, label: "Historial", title: "Historial" },
  "/admin/notifications": {
    grupo: "AJUSTES",
    icon: BellRing,
    label: "Notificaciones",
    title: "Notificaciones",
  },
};

/**
 * La red de seguridad del rail: una entrada que el dominio agregue y que
 * nadie haya archivado acá **se sigue viendo**, al final de `EL SISTEMA` y con el
 * ícono genérico. `adminRail.test.tsx` falla si eso pasa, pero fallar en CI
 * no puede costar una entrada de navegación en producción.
 */
function filaDe(item: NavItem): FilaDelRail {
  return (
    RAIL[item.to] ?? { grupo: "AJUSTES", icon: LayoutGrid, label: item.label, title: item.label }
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
 * en que se leen las cuatro de `LA PLATA` es del armazón.
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

/**
 * `NavLink` decide «activo» sólo por la ruta e ignora el `?tab=`: con
 * «Nómina» (`/admin/nomina`) y «Propinas» (`/admin/nomina?tab=propinas`) en
 * el rail, las dos quedaban encendidas a la vez. Una entrada con `?tab=` está
 * activa sólo si la pestaña coincide; una sin él, sólo si ninguna hermana de
 * la misma ruta reclama la pestaña actual.
 */
export function entradaActiva(to: string, rutaActiva: boolean, search: string, todas: string[]): boolean {
  if (!rutaActiva) return false;
  const [ruta, query] = to.split("?");
  const tab = new URLSearchParams(search).get("tab");
  if (query !== undefined) return new URLSearchParams(query).get("tab") === tab;
  return !todas.some((otra) => {
    const [otraRuta, otraQuery] = otra.split("?");
    return otraRuta === ruta && otraQuery !== undefined && new URLSearchParams(otraQuery).get("tab") === tab;
  });
}

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
  const { search } = useLocation();
  const todas = items.map((item) => item.to);
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
                    className={({ isActive }) =>
                      railItemClass({ active: entradaActiva(item.to, isActive, search, todas), touch })
                    }
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
 * El rol en palabras. `me.user.role` viaja en inglés («admin»), como todo el
 * código (AGENTS.md § Nombres), y la barra superior de `a2` lo lee en
 * español: «Óscar Restrepo · administrador». El `?? role` del final es la
 * red: un rol nuevo se muestra crudo antes que desaparecer.
 */
const ROL_EN_PALABRAS: Record<string, string> = {
  admin: "administrador",
  owner: "administrador",
  supervisor: "supervisor",
  cashier: "responsable de caja",
  operator: "operador",
};

/**
 * La identidad, en la cabeza de la lateral: **de quién y de dónde** es este
 * escritorio. En `a2` (`.lateral .marca`) son dos renglones —la organización
 * en negrita y la sede debajo, apagada— separados del cuerpo del rail por un
 * filete. La persona ya no va acá: subió a la barra superior, junto al rol.
 */
function Identidad(): React.JSX.Element {
  const { me } = useSession();
  const { stores, activeStoreId } = useStoreSelection();
  const sede = stores.find((s) => s.id === activeStoreId)?.name ?? me?.store?.name;
  return (
    <div className="mb-1.5 flex items-center gap-2 border-b px-1.5 pb-2.5">
      <Store className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      <div className="min-w-0">
        <p className="truncate text-sm leading-tight font-bold">
          {me?.organization?.name ?? "Restaurante Sistema"}
        </p>
        {sede ? <p className="truncate text-xs text-muted-foreground">{sede}</p> : null}
      </div>
    </div>
  );
}

/**
 * **El selector de sede vuelve a la barra superior**, que es donde `a2` lo
 * pone (`.barra-cuenta > .selector`). El reparto del alcance no cambió —la
 * sede sigue alcanzando a toda la app, el período sigue en la cabecera de
 * pantalla y el filtro de una tabla en la barra de esa tabla—; lo que cambió
 * es dónde vive lo que alcanza a todo: en una barra de producto y no en la
 * cabeza de la navegación. El dueño miró las dos y eligió a2.
 *
 * Cuando hay una sola sede no hay nada que elegir, y `a2` igual muestra la
 * pastilla con el nombre: se dibuja el mismo chip, sin desplegable. Dejar el
 * hueco vacío hacía que la barra dijera de quién es el escritorio pero no de
 * dónde.
 */
function StoreSwitcher(): React.JSX.Element | null {
  const { hasFeature, me } = useSession();
  const { stores, activeStoreId, setActiveStoreId } = useStoreSelection();

  if (!hasFeature("multi_store") || stores.length <= 1) {
    const sola = stores.find((s) => s.id === activeStoreId)?.name ?? me?.store?.name;
    if (!sola) return null;
    return (
      <p className="flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-input bg-card px-2.5 text-sm">
        <Store className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span className="text-muted-foreground">Sede</span>
        <b className="truncate font-bold">{sola}</b>
      </p>
    );
  }

  return (
    <Select
      value={activeStoreId ? String(activeStoreId) : undefined}
      onValueChange={(next) => setActiveStoreId(Number(next))}
    >
      <SelectTrigger className="h-8 w-auto shrink-0 gap-1.5 bg-card" aria-label="Sede activa">
        <Store className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span className="text-muted-foreground">Sede</span>
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
 *
 * Dos formas: `"barra"` es el botón de la barra superior de `a2`
 * (`.ico-btn`, ícono + la palabra) y `"rail"` la fila del cajón del móvil,
 * donde no hay barra. El rótulo «Salir» se escribe literal en las dos: un
 * rótulo dentro de un atributo `render={…}` es invisible para
 * `src/audit/censo-controles.test.ts`.
 */
function LogoutButton({
  variant = "barra",
  touch = false,
}: {
  variant?: "barra" | "rail";
  touch?: boolean;
} = {}): React.JSX.Element {
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

  if (variant === "rail") {
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

  return (
    <button
      type="button"
      className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:opacity-50"
      title="Cerrar sesión"
      onClick={() => void handleLogout()}
      disabled={saliendo}
    >
      <LogOut className="size-4 shrink-0" aria-hidden="true" />
      Salir
    </button>
  );
}

/**
 * **La barra superior vuelve** (`admin/a2/direccion.html`, `.barra-cuenta`).
 *
 * El rediseño anterior la había disuelto —sede e identidad a la cabeza de la
 * lateral, campana/tema/salida al pie— con el argumento de que una barra le
 * cobra 56 px de alto a un portátil. La de `a2` cobra 34: es una franja de
 * un control de alto, no una cabecera de producto. Y a cambio junta en un
 * solo renglón las cuatro cosas que no son de ninguna pantalla: **de dónde**
 * (la sede), **quién** (persona y rol), y las tres salidas —avisos, tema,
 * cerrar sesión—. En la lateral quedaban mezcladas con la navegación del
 * negocio, que es lo contrario de lo que el patrón del alcance pide.
 *
 * En el móvil la misma barra lleva además el botón del cajón: es una sola
 * franja en las dos superficies, no una para cada una.
 */
function TopBar({
  storeId,
  menu,
}: {
  storeId: number | null;
  menu?: React.ReactNode;
}): React.JSX.Element {
  const { me } = useSession();
  const rol = me?.user?.role;
  const persona = me?.user?.name;
  return (
    <header className="sticky top-0 z-20 flex min-h-12 shrink-0 flex-wrap items-center gap-2 border-b bg-muted px-3 py-1.5">
      {menu}
      <StoreSwitcher />
      {persona ? (
        <p className="min-w-0 truncate text-xs text-muted-foreground">
          {persona}
          {rol ? ` · ${ROL_EN_PALABRAS[rol] ?? rol}` : null}
        </p>
      ) : null}
      <div className="ml-auto flex shrink-0 items-center gap-0.5">
        <NotificationBell storeId={storeId} />
        <ThemeToggle />
        <LogoutButton />
      </div>
    </header>
  );
}

/** El rail entero: identidad, navegación agrupada y —sólo en el móvil— la salida. */
function RailContenido({
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
    <>
      <div className="shrink-0">
        <Identidad />
      </div>
      {/* Sólo la lista rueda: la identidad queda fija. Con las veinticinco
          entradas encendidas el rail mide más que un portátil. */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <SidebarNav items={items} counts={counts} onNavigate={onNavigate} touch={touch} />
      </div>
      {/* El cajón del móvil se abre por encima de la barra superior y la
          tapa: la salida tiene que estar también acá adentro o queda sin
          alcance mientras el cajón está abierto. En el escritorio el cajón
          no existe y la salida vive una sola vez, en la barra. */}
      {touch ? (
        <div className="mt-auto flex shrink-0 flex-col border-t pt-1.5">
          <LogoutButton variant="rail" touch />
        </div>
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------------------
// El celular del dueño: la barra inferior (`docs/diseno/propuesta.html`,
// «Celular del dueño» y Momento 5).
// ---------------------------------------------------------------------------

/** El mismo corte que `md:` de Tailwind: por debajo de 768 px es el celular. */
const CONSULTA_CELULAR = "(max-width: 767.98px)";

function suscribirCelular(avisar: () => void): () => void {
  if (typeof window.matchMedia !== "function") return () => {};
  const consulta = window.matchMedia(CONSULTA_CELULAR);
  consulta.addEventListener("change", avisar);
  return () => consulta.removeEventListener("change", avisar);
}

function esCelular(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia(CONSULTA_CELULAR).matches;
}

/**
 * **La barra inferior se monta sólo en el celular**, no se esconde con CSS
 * nada más. Con `md:hidden` solo, el escritorio llevaría en el árbol una
 * segunda «Hoy» y una segunda «Ventas» invisibles, y cada `getByRole("link",
 * { name: "Hoy" })` de las pruebas —y cada lector de pantalla que no respete
 * `display` de algún ancestro— vería dos. Sin `matchMedia` (jsdom) es
 * escritorio: nada cambia.
 */
function useEsCelular(): boolean {
  return useSyncExternalStore(suscribirCelular, esCelular, () => false);
}

/**
 * «Avisos» no tiene pantalla propia, y es a propósito que no lleve a
 * `/admin/notifications`: esa pantalla es **el historial y las reglas** de
 * las notificaciones, y la campana es una lista que sólo marca leído. La
 * propuesta lo pide explícito —«los avisos llevan a la pantalla que resuelve,
 * nunca a una lista muerta»—, y la única lista de avisos donde cada renglón
 * lleva a donde se resuelve es «Requiere tu atención» de Hoy, que además
 * ya incluye las notificaciones del servidor (`today.alerts`). El ancla la
 * pone `features/reports/TodayPage.tsx` y la baja hasta ahí al llegar.
 */
const ANCLA_AVISOS = "requiere-atencion";

const CLASE_DESTINO =
  "flex min-h-14 flex-col items-center justify-center gap-0.5 px-1 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring";

function claseDestino(activo: boolean): string {
  return cn(
    CLASE_DESTINO,
    // La marca llena del rail (`railItemClass`) acá sería un bloque de 72 px
    // de color: la entrada activa se dice con el color del texto y una raya
    // arriba, y `aria-current` lo dice en voz alta.
    activo
      ? "text-primary shadow-[inset_0_2px_0_0_var(--primary)]"
      : "text-muted-foreground hover:text-foreground",
  );
}

/**
 * **Cuatro destinos y «Más»** (Hoy · Ventas · Plata · Avisos): lo que el
 * dueño mira un domingo desde el celular, sin abrir el cajón. «Más» abre el
 * cajón de siempre, con el rail entero agrupado por preguntas.
 *
 * Los flags siguen mandando: la barra se arma **desde `items`**, que ya pasó
 * por `buildNav(hasFeature)`. Una entrada apagada no está en `items` y por lo
 * tanto no está acá —la barra simplemente tiene un destino menos, no un hueco—.
 * «Plata» es la primera entrada que quede encendida del grupo `¿DÓNDE ESTÁ LA
 * PLATA?`, en el orden del rail: Dinero, y si Dinero está apagada, Banco.
 */
function BarraInferior({
  items,
  onMas,
  masAbierto,
}: {
  items: NavItem[];
  onMas: () => void;
  masAbierto: boolean;
}): React.JSX.Element {
  const { pathname, hash } = useLocation();
  const hoy = items.find((item) => item.to === "/admin/hoy");
  const ventas = items.find((item) => item.to === "/admin/ventas");
  const plata = items
    .filter((item) => filaDe(item).grupo === "¿DÓNDE ESTÁ LA PLATA?")
    .sort(porOrdenDelRail)[0];
  const enAvisos = pathname === "/admin/hoy" && hash === `#${ANCLA_AVISOS}`;
  const enPlata = plata ? pathname === plata.to.split("?")[0] : false;

  return (
    <nav
      aria-label="Accesos del celular"
      // `pb-[env(…)]`: en un iPhone sin botón la barra no queda debajo de la
      // raya de inicio.
      className="fixed inset-x-0 bottom-0 z-30 border-t bg-muted pb-[env(safe-area-inset-bottom)] md:hidden"
    >
      <ul className="grid auto-cols-fr grid-flow-col">
        {/* Los rótulos van escritos literal, uno por destino, y no desde un
            arreglo: el censo de controles lee el código, no el DOM. */}
        {hoy ? (
          <li>
            <Link
              to={hoy.to}
              aria-current={pathname === hoy.to && !enAvisos ? "page" : undefined}
              className={claseDestino(pathname === hoy.to && !enAvisos)}
            >
              <CalendarDays className="size-5" aria-hidden="true" />
              Hoy
            </Link>
          </li>
        ) : null}
        {ventas ? (
          <li>
            <Link
              to={ventas.to}
              aria-current={pathname === ventas.to ? "page" : undefined}
              className={claseDestino(pathname === ventas.to)}
            >
              <BarChart3 className="size-5" aria-hidden="true" />
              Ventas
            </Link>
          </li>
        ) : null}
        {plata ? (
          <li>
            <Link
              to={plata.to}
              // El nombre accesible es «Plata», lo que se ve (WCAG 2.5.3); a
              // qué pantalla lleva lo dice el `title`.
              title={filaDe(plata).title}
              aria-current={enPlata ? "page" : undefined}
              className={claseDestino(enPlata)}
            >
              <Banknote className="size-5" aria-hidden="true" />
              Plata
            </Link>
          </li>
        ) : null}
        {hoy ? (
          <li>
            <Link
              to={`${hoy.to}#${ANCLA_AVISOS}`}
              title="Hoy › Requiere tu atención"
              aria-current={enAvisos ? "location" : undefined}
              className={claseDestino(enAvisos)}
            >
              <CircleAlert className="size-5" aria-hidden="true" />
              Avisos
            </Link>
          </li>
        ) : null}
        <li>
          <button
            type="button"
            onClick={onMas}
            aria-haspopup="dialog"
            aria-expanded={masAbierto}
            title="Todas las secciones"
            className={cn(claseDestino(false), "w-full")}
          >
            <Ellipsis className="size-5" aria-hidden="true" />
            Más
          </button>
        </li>
      </ul>
    </nav>
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
  const celular = useEsCelular();

  return (
    <div className="oficina flex min-h-screen bg-background text-foreground">
      {/* 222 px medidos: el ancho al que los cuatro nombres largos dejan de
          truncar una vez acortados (`docs/PATRONES-ADMIN.md` § 1).
          El fondo va en el `aside`, que se estira con la página, y el
          `sticky` adentro: con las dos cosas en el mismo elemento la
          columna gris terminaba a la altura de la ventana y dejaba una
          franja blanca bajo el pliegue en toda pantalla más alta que el
          monitor. En `a2` la lateral es una celda de la grilla y llega
          siempre hasta abajo. */}
      <aside className={cn("hidden w-[222px] shrink-0 border-r bg-muted md:block")}>
        <div className="sticky top-0 flex h-screen flex-col p-2">
          <RailContenido items={items} counts={counts} />
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar
          storeId={activeStoreId}
          menu={
            <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
              <SheetTrigger
                render={
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="md:hidden"
                    aria-label="Abrir menú"
                  />
                }
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
                  onNavigate={() => setMobileOpen(false)}
                  touch
                />
              </SheetContent>
            </Sheet>
          }
        />
        {/* Con la barra inferior, el pie del contenido sube lo que ella mide
            (56 px + la raya de inicio del teléfono) y un poco de aire: el
            último renglón de la pantalla nunca queda tapado. */}
        <main
          className={cn(
            "min-w-0 flex-1 p-4 md:p-6",
            celular && "pb-[calc(5rem+env(safe-area-inset-bottom))] md:pb-6",
          )}
        >
          <Outlet />
        </main>
      </div>
      {celular ? (
        <BarraInferior items={items} onMas={() => setMobileOpen(true)} masAbierto={mobileOpen} />
      ) : null}
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
