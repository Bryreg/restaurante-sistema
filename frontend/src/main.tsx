import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { AppRouter } from "@/app/router";
import { SessionProvider } from "@/app/session";
import { AppThemeProvider } from "@/app/theme";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";

import "./index.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: false,
      refetchOnWindowFocus: false,
    },
  },
});

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error('No se encontró el elemento raíz "#root"');
}

createRoot(rootElement).render(
  <StrictMode>
    <AppThemeProvider>
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <SessionProvider>
            <AppRouter />
            <Toaster richColors closeButton />
          </SessionProvider>
        </TooltipProvider>
      </QueryClientProvider>
    </AppThemeProvider>
  </StrictMode>,
);
