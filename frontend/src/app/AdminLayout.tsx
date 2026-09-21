import { Bell, LayoutGrid, LogOut, Menu, ScrollText, Settings, ToggleLeft } from "lucide-react";
import { useState } from "react";
import { NavLink, Outlet } from "react-router-dom";
import { toast } from "sonner";

import { logout } from "@/api/auth";

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
  { to: "/admin/features", label: "Funciones", feature: undefined, icon: ToggleLeft },
  { to: "/admin/settings", label: "Configuración", feature: undefined, icon: Settings },
  { to: "/admin/audit", label: "Historial", feature: undefined, icon: ScrollText },
  { to: "/admin/notifications", label: "Notificaciones", feature: undefined, icon: Bell },
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
 */
function buildNav(hasFeature: (key: string) => boolean): NavItem[] {
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

function SidebarNav({ items, onNavigate }: { items: NavItem[]; onNavigate?: () => void }) {
  return (
    <nav aria-label="Secciones de administración" className="flex flex-col gap-1">
      {items.map((item) => {
        const Icon = item.icon ?? LayoutGrid;
        return (
          <NavLink
            key={item.to}
            to={item.to}
            onClick={onNavigate}
            className={({ isActive }) =>
              cn(
                "flex min-h-11 items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                isActive
                  ? "bg-accent text-accent-foreground"
                  : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
              )
            }
          >
            <Icon className="size-4" aria-hidden="true" />
            {item.label}
          </NavLink>
        );
      })}
    </nav>
  );
}

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
      <SelectTrigger className="h-9 w-48" aria-label="Sede activa">
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
function LogoutButton(): React.JSX.Element {
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
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className="h-9 gap-2"
      title="Cerrar sesión"
      onClick={() => void handleLogout()}
      disabled={saliendo}
    >
      <LogOut className="size-4" aria-hidden="true" />
      Salir
    </Button>
  );
}

function AdminChrome(): React.JSX.Element {
  // Escritorio del dueño: cuerpo 14,5 px y filas de 34 px (m2b `.oficina`).
  useDensity("oficina");
  const { me, hasFeature } = useSession();
  const { activeStoreId } = useStoreSelection();
  const [mobileOpen, setMobileOpen] = useState(false);
  const items = buildNav(hasFeature);

  return (
    <div className="oficina flex min-h-screen bg-background text-foreground">
      <aside className="hidden w-64 shrink-0 border-r p-4 md:flex md:flex-col md:gap-4">
        <div className="px-1">
          <p className="text-sm font-semibold">{me?.organization?.name ?? "Restaurante Sistema"}</p>
          <p className="text-xs text-muted-foreground">{me?.user?.name}</p>
        </div>
        <SidebarNav items={items} />
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 items-center justify-between gap-2 border-b px-3 md:px-6">
          <div className="flex items-center gap-2">
            <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
              <SheetTrigger
                render={
                  <Button type="button" variant="ghost" size="icon" className="md:hidden" aria-label="Abrir menú" />
                }
              >
                <Menu className="size-5" aria-hidden="true" />
              </SheetTrigger>
              <SheetContent side="left" className="w-64 p-4">
                <SheetHeader>
                  <SheetTitle>{me?.organization?.name ?? "Restaurante Sistema"}</SheetTitle>
                </SheetHeader>
                <div className="mt-2">
                  <SidebarNav items={items} onNavigate={() => setMobileOpen(false)} />
                </div>
              </SheetContent>
            </Sheet>
            <StoreSwitcher />
          </div>
          <div className="flex items-center gap-1">
            <NotificationBell storeId={activeStoreId} />
            <ThemeToggle />
            <LogoutButton />
          </div>
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
