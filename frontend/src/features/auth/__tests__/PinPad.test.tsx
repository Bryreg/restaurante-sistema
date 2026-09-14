import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { PinPad } from "@/components/PinPad";

describe("PinPad", () => {
  it("tiene un grupo con nombre y un botón con label por cada dígito", () => {
    render(<PinPad length={4} label="PIN personal" onSubmit={vi.fn()} />);

    expect(screen.getByRole("group", { name: "PIN personal" })).toBeInTheDocument();
    for (const digit of ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"]) {
      expect(screen.getByRole("button", { name: `Dígito ${digit}` })).toBeInTheDocument();
    }
    expect(screen.getByRole("button", { name: "Borrar último dígito" })).toBeInTheDocument();
  });

  it("es operable con el teclado físico y llama a onSubmit con el PIN completo", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<PinPad length={4} label="PIN personal" onSubmit={onSubmit} />);

    await user.keyboard("1234");

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith("1234");
  });

  it("Backspace por teclado borra el último dígito antes de enviar", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<PinPad length={4} label="PIN de sede" onSubmit={onSubmit} />);

    await user.keyboard("123{Backspace}23");

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith("1223");
  });

  it("es operable haciendo click en los botones", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<PinPad length={4} label="PIN personal" onSubmit={onSubmit} />);

    for (const digit of ["9", "0", "0", "0"]) {
      await user.click(screen.getByRole("button", { name: `Dígito ${digit}` }));
    }

    expect(onSubmit).toHaveBeenCalledWith("9000");
  });

  it("muestra el mensaje de error del servidor como alerta", () => {
    render(<PinPad length={4} label="PIN personal" onSubmit={vi.fn()} errorMessage="PIN_LOCKED: probá en 15 minutos" />);
    expect(screen.getByRole("alert")).toHaveTextContent("PIN_LOCKED: probá en 15 minutos");
  });
});
