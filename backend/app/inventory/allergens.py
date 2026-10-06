"""Los alérgenos que se declaran en un insumo: los 14 de declaración
obligatoria del Reglamento UE 1169/2011 (anexo II), que es la lista que usan
las cocinas profesionales. Lista cerrada: el código es lo que se guarda, la
palabra la pone la pantalla."""

from __future__ import annotations

from typing import Literal, get_args

AllergenCode = Literal[
    "gluten",
    "crustaceos",
    "huevo",
    "pescado",
    "mani",
    "soya",
    "lacteos",
    "frutos_secos",
    "apio",
    "mostaza",
    "sesamo",
    "sulfitos",
    "altramuces",
    "moluscos",
]

ALLERGENS: tuple[str, ...] = get_args(AllergenCode)


def parse(value: str | None) -> list[str]:
    if not value:
        return []
    return [code for code in value.split(",") if code in ALLERGENS]


def serialize(codes: list[str] | None) -> str | None:
    if not codes:
        return None
    seen = [c for c in ALLERGENS if c in set(codes)]
    return ",".join(seen) or None
