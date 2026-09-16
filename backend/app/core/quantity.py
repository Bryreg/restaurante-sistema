"""Contrato numérico de cantidades de insumo (SPEC-NEGOCIO §4.1/§5.1;
`features/fase-2-costo-inventario/spec.md § Convenciones de ingeniería`).

El dinero ya vive en enteros de pesos (`app.core.money`). Las cantidades de
insumo **no son pesos**: viven en una unidad base por insumo (`g`, `ml`,
`unit`) y acá se fija, de una vez y para todo el equipo, cómo se guardan y se
combinan sin `float` ni `Decimal` persistido — "un `0.1 + 0.2` en una
varianza es un bug que nadie encuentra" (mandato del pedido 2a).

Publicado por `backend-inventario` **primero**, antes que ninguna otra pieza
de 2a: `backend-recetas` (fichas y preparaciones), `backend-recetas`/`orders`
(consumo al enviar) y `purchases` en 2b lo importan tal cual. Nadie lo
redefine ni lo aproxima con otra escala.

Constantes:
    QTY_SCALE  = 1000        cantidades: entero en MILÉSIMAS de la unidad base
    COST_SCALE = 1_000_000   costos: entero en MILLONÉSIMAS de peso por UNIDAD BASE ENTERA

Por qué milésimas y no gramos/mililitros enteros: un insumo puede recetarse
en fracciones finas (0,5 g de un saborizante) y el yield/cascada de
sustituto encadena divisiones; milésimas da margen sin necesitar más
escala. Por qué millonésimas de peso y no pesos enteros por línea: acumular
a pesos línea por línea en una ficha con diez insumos arrastra hasta 10
redondeos independientes — el food cost teórico de una ficha con veinte
líneas se desvía sistemáticamente hacia arriba. Se acumula en millonésimas a
lo largo de TODA la ficha y sólo se redondea a pesos en el borde
(`micros_to_pesos`), una vez.

**EN QUÉ ESCALA SALE UN COSTO (la regla que faltaba y causó B-2)**: este
módulo publica costos en dos formas, y son intercambiables sólo dentro de
cada una, nunca entre sí.

- **`format_cost_micros` es la ÚNICA forma correcta de publicar un costo POR
  UNIDAD BASE** (por gramo, por mililitro, por unidad) — es decir, todo
  `cost`/`official_cost`/`estimated_cost` de `app.inventory.schemas` y todo
  `unit_cost`/`total_cost`/`theoretical_cost` de `app.recipes.schemas`.
  Texto decimal, **precisión completa**, nunca redondeado a pesos: un costo
  real de $0,003/g (la sal de mesa del seed) publicado como pesos enteros
  redondeados da `0`, y `0` con `cost_source="official"` es exactamente el
  cero mudo que SPEC-NEGOCIO §4.1 prohíbe ("nunca un cero mudo"). Por esto
  estos campos se anotan `str | None` en los esquemas Pydantic, nunca `int`
  ni `float`: un campo `int | None` en uno de estos esquemas es, por
  definición, o bien pesos enteros redondeados (el cero mudo de arriba) o
  bien micros crudos sin escalar filtrándose a una respuesta HTTP (una cifra
  seis órdenes de magnitud más grande de lo que espera quien la lee) — las
  dos formas en que se manifestó B-2. `tests/core/test_quantity.py` audita
  esto por anotación de tipo sobre los esquemas publicados de los dos
  dominios; no es sólo una convención de docstring.
- **`micros_to_pesos` queda acotada a TOTALES DE PLATA de venta**: el
  snapshot `order_items.unit_cost`, los totales de un reporte. Redondea
  **una sola vez, al cerrar el total** — nunca por ítem, nunca por gramo,
  nunca dentro de una ficha o una cadena de preparaciones (ver el ejemplo
  numérico en su propio docstring, más abajo).
"""

from __future__ import annotations

from decimal import Decimal, InvalidOperation

from app.core.errors import AppError

QTY_SCALE = 1000
COST_SCALE = 1_000_000


def line_cost_micros(qty_base: int, cost_micros: int) -> int:
    """Costo de una línea, en millonésimas de peso.

    `qty_base` en milésimas de la unidad base; `cost_micros` en millonésimas
    de peso por unidad base ENTERA (no por milésima). División entera
    (trunca): el residuo de truncar cada línea es el precio de no redondear
    a pesos todavía — se sigue acumulando en millonésimas hasta el borde, así
    que ese residuo nunca se pierde de verdad, sólo viaja sin redondear.
    """
    return qty_base * cost_micros // QTY_SCALE


def micros_to_pesos(micros: int) -> int:
    """Redondeo half-up de millonésimas de peso a pesos enteros.

    **Acotada a TOTALES DE PLATA de venta**: el snapshot congelado
    `order_items.unit_cost`, o un total ya cerrado de un reporte (el
    margen bruto de una comanda, la suma de mermas del día). Redondea **una
    sola vez, al cerrar ese total** — nunca por ítem de una ficha, nunca por
    gramo, nunca dentro de una cadena insumo → preparación → plato, donde el
    redondeo intermedio es exactamente el bug que subestima costos en
    cadena (ver `test_line_cost_micros_accumulates_without_intermediate_rounding`).

    **Nunca se usa para publicar un costo por unidad base** (por gramo, por
    mililitro) — ni en `app.inventory.schemas` ni en `app.recipes.schemas`.
    Ese es trabajo de `format_cost_micros`, no de esta función: la sal de
    mesa del seed cuesta $0,003/g, y `micros_to_pesos(3_000)` (0,003 de
    millón) redondea a `0` — el cero mudo que §4.1 prohíbe. Si el número que
    estás por redondear es "cuánto cuesta un gramo/mililitro/unidad de este
    insumo o preparación", parás acá y usás `format_cost_micros` en su
    lugar; si es "cuánto costó esta línea de venta ya vendida, en pesos,
    para mostrarla", entonces sí es esta función.
    """
    if micros >= 0:
        return (micros + COST_SCALE // 2) // COST_SCALE
    return -((-micros + COST_SCALE // 2) // COST_SCALE)


def apply_yield(qty_base: int, yield_pct: int) -> int:
    """Cantidad a descontar del insumo dado lo que la receta pide LIMPIO.

    La ficha expresa cantidad limpia (lo que el cocinero pesa después de
    pelar/deshuesar); el consumo teórico tiene que descontar más que eso,
    porque el insumo bruto rinde menos. `qty_base ÷ (yield_pct / 100)`,
    redondeado **hacia arriba** (`ceil`), nunca hacia abajo: redondear hacia
    abajo subestima el consumo — es el modo de falla documentado de la
    referencia, donde todos los costos quedaban subestimados y la varianza
    se leía como robo crónico. `yield_pct` es entero 1..100 (100 = sin
    merma, la cantidad no cambia).

    `apply_yield(qty_base, yield_pct) == -(-qty_base * 100 // yield_pct)`
    (truco de la doble negación para `ceil` con división entera de Python,
    que trunca hacia `-inf`, no hacia cero).
    """
    if not (1 <= yield_pct <= 100):
        raise AppError(
            code="VALIDATION_ERROR",
            message="yield_pct: el rendimiento tiene que ser un entero entre 1 y 100",
        )
    return -(-qty_base * 100 // yield_pct)


def parse_qty_base(value: str, *, field: str = "qty") -> int:
    """Convierte la cantidad que manda el cliente — **string decimal**
    (`"18.5"`), nunca un número JSON — a un entero en milésimas de la unidad
    base del insumo. Un `float` de JSON nunca llega hasta acá con forma de
    `float` de Python: los esquemas de entrada declaran el campo como `str`,
    así que un número JSON sin comillas ya lo rechaza la validación de
    Pydantic antes de esta función; esta función además defiende el mismo
    contrato para quien la llame directo (tests, otros servicios).

    Acepta coma o punto decimal. Cualquier cantidad con más de tres
    decimales (más fino que la milésima) es `400 VALIDATION_ERROR`: guardar
    de menos ahí sería, otra vez, subestimar silenciosamente.
    """
    if isinstance(value, float):
        raise AppError(
            code="VALIDATION_ERROR",
            message=f"{field}: enviá la cantidad como texto decimal (\"18.5\"), no como número",
        )
    if not isinstance(value, str):
        raise AppError(
            code="VALIDATION_ERROR", message=f"{field}: enviá la cantidad como texto decimal"
        )
    text = value.strip().replace(",", ".")
    if text == "":
        raise AppError(code="VALIDATION_ERROR", message=f"{field}: la cantidad es obligatoria")
    try:
        parsed = Decimal(text)
    except InvalidOperation as exc:
        raise AppError(
            code="VALIDATION_ERROR", message=f"{field}: \"{value}\" no es una cantidad decimal válida"
        ) from exc
    scaled = parsed * QTY_SCALE
    if scaled != scaled.to_integral_value():
        raise AppError(
            code="VALIDATION_ERROR",
            message=f"{field}: no admite más de tres decimales (la unidad base se guarda en milésimas)",
        )
    return int(scaled)


def parse_cost_micros(value: str, *, field: str = "cost") -> int:
    """Costo en pesos por unidad base ENTERA, como string decimal — mismo
    contrato de entrada que `parse_qty_base` (nunca un `float` de JSON), pero
    escalado a `COST_SCALE` en vez de `QTY_SCALE`: `"18000.5"` ->
    `18_000_500_000` millonésimas. Rechaza más de seis decimales y
    cualquier valor negativo (un costo no puede ser negativo; "sin costo
    todavía" se manda como `null`, nunca como un número)."""
    if isinstance(value, float):
        raise AppError(
            code="VALIDATION_ERROR",
            message=f"{field}: enviá el costo como texto decimal, no como número",
        )
    if not isinstance(value, str):
        raise AppError(code="VALIDATION_ERROR", message=f"{field}: enviá el costo como texto decimal")
    text = value.strip().replace(",", ".")
    if text == "":
        raise AppError(code="VALIDATION_ERROR", message=f"{field}: el costo no puede quedar vacío; omitilo si no hay costo")
    try:
        parsed = Decimal(text)
    except InvalidOperation as exc:
        raise AppError(
            code="VALIDATION_ERROR", message=f"{field}: \"{value}\" no es un costo decimal válido"
        ) from exc
    if parsed < 0:
        raise AppError(code="VALIDATION_ERROR", message=f"{field}: un costo no puede ser negativo")
    scaled = parsed * COST_SCALE
    if scaled != scaled.to_integral_value():
        raise AppError(
            code="VALIDATION_ERROR",
            message=f"{field}: no admite más de seis decimales (el costo se guarda en millonésimas de peso)",
        )
    return int(scaled)


def format_cost_micros(micros: int) -> str:
    """Inverso de `parse_cost_micros`: **la ÚNICA forma correcta de publicar
    un costo por unidad base** (por gramo, por mililitro, por unidad
    entera) en cualquier esquema de respuesta de `inventory` o `recipes`
    (`IngredientOut.cost`/`.official_cost`/`.estimated_cost`,
    `StockRowOut.cost`, `StockMovementOut.cost`, `WasteAdminOut.cost`,
    `PreparationAdminOut.unit_cost`, `PrepBatchAdminOut.total_cost`/
    `.unit_cost`, `ProductRecipeOut.theoretical_cost`, y cualquier campo de
    costo nuevo que se agregue después). No redondea a pesos — texto
    decimal con precisión completa — porque redondear acá es exactamente el
    cero mudo que §4.1 prohíbe: la sal de mesa del seed cuesta $0,003/g
    (`cost_source="official"`); `format_cost_micros(3_000)` publica
    `"0.003"`, mientras que pasar ese mismo `3_000` por `micros_to_pesos`
    (que es para OTRA cosa, ver su docstring) daría `0` — un costo oficial
    real leído como si no hubiera costo. `18_000_500_000 -> "18000.5"`.
    `micros_to_pesos` es la función hermana, pero para una escala y un uso
    completamente distintos (totales de plata de venta, no costos por
    unidad base); no son intercambiables."""
    sign = "-" if micros < 0 else ""
    whole, frac = divmod(abs(micros), COST_SCALE)
    frac_str = f"{frac:06d}".rstrip("0")
    return f"{sign}{whole}.{frac_str}" if frac_str else f"{sign}{whole}"


def format_qty_base(qty_base: int) -> str:
    """Inverso de `parse_qty_base`: milésimas -> texto decimal, para que
    ninguna respuesta lleve un `float` de JSON. `1250 -> "1.25"`,
    `-400 -> "-0.4"`, `3000 -> "3"`."""
    sign = "-" if qty_base < 0 else ""
    whole, frac = divmod(abs(qty_base), QTY_SCALE)
    frac_str = f"{frac:03d}".rstrip("0")
    return f"{sign}{whole}.{frac_str}" if frac_str else f"{sign}{whole}"
