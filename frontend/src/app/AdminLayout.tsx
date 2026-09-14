import { Bell, LayoutGrid, Menu, ScrollText, Settings, ToggleLeft } from "lucide-react";
import { useState } from "react";
import { NavLink, Outlet } from "react-router-dom";

import { NotificationBell } from "@/features/notifications/NotificationBell";
import { catalogFeature } from "@/features/catalog";
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
import { cn } from "@/lib/utils";

import type { NavItem } from "./nav";
import { useSession } from "./session";
import { StoreSelectionProvider, useStoreSelection } from "./storeContext";
import { ThemeToggle } from "./theme";

const OWN_NAV: NavItem[] = [
  { to: "/admin/features", label: "Funciones", feature: undefined, icon: ToggleLeft },
  { to: "/admin/settings", label: "Configuración", feature: undefined, icon: Settings },
  { to: "/admin/audit", label: "Historial", feature: undefined, icon: ScrollText },
  { to: "/admin/notifications", label: "Notificaciones", feature: undefined, icon: Bell },
];

function buildNav(hasFeature: (key: string) => boolean): NavItem[] {
  const all = [...OWN_NAV, ...shiftsFeature.adminNav, ...catalogFeature.adminNav];
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

function AdminChrome(): React.JSX.Element {
  const { me, hasFeature } = useSession();
  const { activeStoreId } = useStoreSelection();
  const [mobileOpen, setMobileOpen] = useState(false);
  const items = buildNav(hasFeature);

  return (
    <div className="flex min-h-screen bg-background text-foreground">
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
