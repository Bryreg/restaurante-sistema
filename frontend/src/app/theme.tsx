import { Moon, Sun } from "lucide-react";
import { ThemeProvider as NextThemesProvider, useTheme } from "next-themes";
import type { ReactNode } from "react";

import { RailItemContent, railItemClass } from "@/components/admin/RailItem";
import { Button } from "@/components/ui/button";

/**
 * Claro/oscuro con la clase `.dark` en `<html>` (contrato interno § 5). Es la
 * única cosa de este proyecto a la que sí se le permite vivir en
 * `localStorage` — el tema, no la sesión (AGENTS.md § "Sesión en cookie
 * httpOnly").
 */
export function AppThemeProvider({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <NextThemesProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
      {children}
    </NextThemesProvider>
  );
}

export interface ThemeToggleProps {
  /**
   * `"icon"` es el botón cuadrado de siempre. `"rail"` es la fila del pie de
   * la lateral del admin, donde el control bajó cuando la barra superior
   * dejó de existir (`docs/PATRONES-ADMIN.md` § 1).
   */
  variant?: "icon" | "rail";
  /** En el cajón del móvil la fila necesita el objetivo táctil. */
  touch?: boolean;
}

export function ThemeToggle({ variant = "icon", touch = false }: ThemeToggleProps = {}): React.JSX.Element {
  const { resolvedTheme, setTheme } = useTheme();
  const isDark = resolvedTheme === "dark";
  const Icono = isDark ? Sun : Moon;

  if (variant === "rail") {
    return (
      <button
        type="button"
        // Sin `aria-label`: el nombre accesible es el texto que se ve. Un
        // rótulo visible «Tema oscuro» con un nombre accesible «Cambiar a
        // modo oscuro» es justamente lo que WCAG 2.5.3 prohíbe — quien dicta
        // por voz lee la pantalla y nombra lo que ve.
        title={isDark ? "Cambiar a modo claro" : "Cambiar a modo oscuro"}
        aria-pressed={isDark}
        onClick={() => setTheme(isDark ? "light" : "dark")}
        className={railItemClass({ touch })}
      >
        <RailItemContent icon={Icono} label={isDark ? "Tema claro" : "Tema oscuro"} />
      </button>
    );
  }

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      aria-label={isDark ? "Cambiar a modo claro" : "Cambiar a modo oscuro"}
      aria-pressed={isDark}
      onClick={() => setTheme(isDark ? "light" : "dark")}
    >
      <Icono className="size-5" aria-hidden="true" />
    </Button>
  );
}
