import { cleanup } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";

// `globals: false` en vite.config.ts: cada test importa lo que necesita de
// "vitest" en vez de depender de globals estilo Jest. Por eso el cleanup de
// Testing Library también se registra a mano acá.
afterEach(() => {
  cleanup();
});
