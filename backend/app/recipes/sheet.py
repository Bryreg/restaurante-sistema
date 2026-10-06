"""La ficha de chef de un plato o de una preparación (0039), y su versión
para imprimir.

La ficha suma a la receta lo que la cocina necesita para hacer el plato igual
cada vez: el método paso a paso, la porción servida, la estación, el tiempo,
el montaje, las notas del chef y la foto. Los **alérgenos no se escriben**:
se heredan de los insumos, también a través de las preparaciones, para que
nadie tenga que acordarse de actualizarlos cuando cambia una receta.

La versión imprimible ya viene **escalada en el servidor** (N porciones de un
plato, N tandas de una preparación): las cantidades no se multiplican en la
pantalla. La de cocina va sin costos; la del dueño, con el costo y el food
cost que ya calcula `app.recipes.cost`.
"""

from __future__ import annotations

import json
from datetime import datetime
from decimal import Decimal
from typing import Literal

from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.auth.deps import Actor
from app.core import clock
from app.core.errors import AppError
from app.photos.hooks import PhotoIn, store_photo
from app.recipes import units
from app.recipes.models import Preparation, PreparationLine, Recipe, RecipeSheet

StationLiteral = Literal["caliente", "fria", "parrilla", "pasteleria", "bar", "otra"]
MAX_DEPTH = 5


class RecipeSheetIn(BaseModel):
    method_steps: list[str] = Field(default_factory=list, max_length=60)
    portion: str | None = Field(default=None, max_length=120)
    station: StationLiteral | None = None
    prep_minutes: int | None = Field(default=None, ge=0, le=24 * 60)
    plating_notes: str | None = Field(default=None, max_length=4000)
    chef_notes: str | None = Field(default=None, max_length=4000)
    # Una foto nueva (data URL) o la dirección que ya tenía; `None` la deja.
    photo: PhotoIn | None = None
    clear_photo: bool = False


class RecipeSheetOut(BaseModel):
    product_id: int | None
    preparation_id: int | None
    method_steps: list[str]
    portion: str | None
    station: str | None
    prep_minutes: int | None
    plating_notes: str | None
    chef_notes: str | None
    photo_url: str | None
    updated_at: datetime | None
    updated_by_employee_name: str | None
    # Heredados de los insumos (también los de las preparaciones de adentro).
    allergens: list[str]


class PrintableComponentOut(BaseModel):
    kind: Literal["ingredient", "preparation"]
    name: str
    qty: str
    unit: str
    # Lo que lleva adentro una preparación, en la cantidad que este plato usa.
    components: list["PrintableComponentOut"] = Field(default_factory=list)


class PrintableCostOut(BaseModel):
    # Pesos, texto decimal con dos cifras; `None` = sin costo (nunca $ 0).
    total: str | None
    per_unit: str | None
    food_cost_pct: str | None
    net_price: int | None


class PrintableSheetOut(BaseModel):
    kind: Literal["product", "preparation"]
    id: int
    name: str
    # Plato: «1 porción» / «10 porciones»; preparación: «Rinde 2 kg».
    scale_text: str
    scale: int
    recipe_version: int | None
    sheet: RecipeSheetOut
    components: list[PrintableComponentOut]
    cost: PrintableCostOut | None
    generated_at: datetime


# ---------------------------------------------------------------------------


def _sheet_row(db: Session, *, product_id: int | None = None, preparation_id: int | None = None) -> RecipeSheet | None:
    stmt = select(RecipeSheet)
    stmt = (
        stmt.where(RecipeSheet.product_id == product_id)
        if product_id is not None
        else stmt.where(RecipeSheet.preparation_id == preparation_id)
    )
    return db.execute(stmt).scalar_one_or_none()


def _ingredient_allergens(db: Session, ingredient_ids: set[int]) -> set[str]:
    from app.inventory import allergens as allergens_lib
    from app.inventory.models import Ingredient

    if not ingredient_ids:
        return set()
    out: set[str] = set()
    for value in db.execute(select(Ingredient.allergens).where(Ingredient.id.in_(ingredient_ids))).scalars():
        out.update(allergens_lib.parse(value))
    return out


def _collect_ingredients(db: Session, *, preparation_ids: set[int], seen: set[int] | None = None) -> set[int]:
    """Los insumos de una o varias preparaciones, recursivo (con freno de ciclos)."""
    seen = seen if seen is not None else set()
    todo = preparation_ids - seen
    if not todo:
        return set()
    seen.update(todo)
    lines = db.execute(select(PreparationLine).where(PreparationLine.preparation_id.in_(todo))).scalars().all()
    ings = {l.ingredient_id for l in lines if l.ingredient_id is not None}
    subs = {l.component_preparation_id for l in lines if l.component_preparation_id is not None}
    return ings | _collect_ingredients(db, preparation_ids=subs, seen=seen)


def _ordered_allergens(codes: set[str]) -> list[str]:
    from app.inventory.allergens import ALLERGENS

    return [c for c in ALLERGENS if c in codes]


def _product_lines(db: Session, recipe: Recipe | None) -> tuple[int | None, list[tuple[int | None, int | None, int, str]]]:
    if recipe is None:
        return None, []
    from app.recipes.service import _current_recipe_lines

    version, lines = _current_recipe_lines(db, recipe)
    return (version.version if version else None), [(l.ingredient_id, l.preparation_id, l.qty_base, l.unit) for l in lines]


def _allergens_for(
    db: Session, lines: list[tuple[int | None, int | None, int, str]]
) -> list[str]:
    ings = {i for i, _p, _q, _u in lines if i is not None}
    preps = {p for _i, p, _q, _u in lines if p is not None}
    ings |= _collect_ingredients(db, preparation_ids=preps)
    return _ordered_allergens(_ingredient_allergens(db, ings))


def _sheet_out(
    row: RecipeSheet | None, *, product_id: int | None, preparation_id: int | None, allergens: list[str]
) -> RecipeSheetOut:
    steps: list[str] = []
    if row is not None and row.method_steps:
        try:
            raw = json.loads(row.method_steps)
            steps = [str(s) for s in raw if str(s).strip()] if isinstance(raw, list) else []
        except ValueError:
            steps = [row.method_steps]
    return RecipeSheetOut(
        product_id=product_id,
        preparation_id=preparation_id,
        method_steps=steps,
        portion=row.portion if row else None,
        station=row.station if row else None,
        prep_minutes=row.prep_minutes if row else None,
        plating_notes=row.plating_notes if row else None,
        chef_notes=row.chef_notes if row else None,
        photo_url=row.photo_url if row else None,
        updated_at=row.updated_at if row else None,
        updated_by_employee_name=row.updated_by_employee_name if row else None,
        allergens=allergens,
    )


def _owner(db: Session, actor: Actor, *, product_id: int | None, preparation_id: int | None) -> tuple[int, int]:
    """(organization_id, store_id) del dueño de la ficha, con su 404."""
    if product_id is not None:
        from app.catalog import service as catalog_service

        product = catalog_service.product_or_404(db, actor, product_id)
        return product.organization_id, product.store_id
    from app.recipes.service import preparation_or_404

    prep = preparation_or_404(db, actor, preparation_id)  # type: ignore[arg-type]
    return prep.organization_id, prep.store_id


def get_sheet(db: Session, actor: Actor, *, product_id: int | None = None, preparation_id: int | None = None) -> RecipeSheetOut:
    _owner(db, actor, product_id=product_id, preparation_id=preparation_id)
    row = _sheet_row(db, product_id=product_id, preparation_id=preparation_id)
    if product_id is not None:
        recipe = db.execute(select(Recipe).where(Recipe.product_id == product_id)).scalar_one_or_none()
        _v, lines = _product_lines(db, recipe)
    else:
        plines = db.execute(select(PreparationLine).where(PreparationLine.preparation_id == preparation_id)).scalars().all()
        lines = [(l.ingredient_id, l.component_preparation_id, l.qty_base, l.unit) for l in plines]
    return _sheet_out(row, product_id=product_id, preparation_id=preparation_id, allergens=_allergens_for(db, lines))


def put_sheet(
    db: Session, actor: Actor, data: RecipeSheetIn, *, product_id: int | None = None, preparation_id: int | None = None
) -> RecipeSheetOut:
    from app.audit.service import record_audit

    org_id, store_id = _owner(db, actor, product_id=product_id, preparation_id=preparation_id)
    row = _sheet_row(db, product_id=product_id, preparation_id=preparation_id)
    now = clock.now_utc()
    if row is None:
        row = RecipeSheet(
            organization_id=org_id, store_id=store_id, product_id=product_id, preparation_id=preparation_id,
            updated_at=now,
        )
        db.add(row)
    steps = [s.strip() for s in data.method_steps if s.strip()]
    row.method_steps = json.dumps(steps, ensure_ascii=False) if steps else None
    row.portion = (data.portion or "").strip() or None
    row.station = data.station
    row.prep_minutes = data.prep_minutes
    row.plating_notes = (data.plating_notes or "").strip() or None
    row.chef_notes = (data.chef_notes or "").strip() or None
    if data.clear_photo:
        row.photo_url = None
    elif data.photo is not None:
        row.photo_url = store_photo(db, data.photo, organization_id=org_id, store_id=store_id)
    row.updated_at = now
    row.updated_by_employee_id = actor.employee_id
    row.updated_by_employee_name = actor.employee_name
    db.flush()
    record_audit(
        db, actor=actor, organization_id=org_id, store_id=store_id, entity="recipe_sheet", entity_id=row.id,
        action="update", before=None,
        after={"product_id": product_id, "preparation_id": preparation_id, "steps": len(steps)},
    )
    return get_sheet(db, actor, product_id=product_id, preparation_id=preparation_id)


# ---------------------------------------------------------------------------
# Imprimible
# ---------------------------------------------------------------------------


def _qty_text(qty_base: int, unit: str) -> str:
    value = units.base_qty_to_decimal(qty_base, unit)
    text = format(value.quantize(Decimal("0.001")).normalize(), "f")
    return text


def _expand(
    db: Session, lines: list[tuple[int | None, int | None, int, str]], *, multiplier: Decimal, depth: int = 0
) -> list[PrintableComponentOut]:
    from app.inventory.models import Ingredient

    ing_ids = [i for i, _p, _q, _u in lines if i is not None]
    prep_ids = [p for _i, p, _q, _u in lines if p is not None]
    ings = {i.id: i for i in db.execute(select(Ingredient).where(Ingredient.id.in_(ing_ids))).scalars()} if ing_ids else {}
    preps = {p.id: p for p in db.execute(select(Preparation).where(Preparation.id.in_(prep_ids))).scalars()} if prep_ids else {}
    out: list[PrintableComponentOut] = []
    for ingredient_id, preparation_id, qty_base, unit in lines:
        scaled = int((Decimal(qty_base) * multiplier).to_integral_value())
        if ingredient_id is not None:
            ing = ings.get(ingredient_id)
            out.append(PrintableComponentOut(
                kind="ingredient", name=ing.name if ing else "—", qty=_qty_text(scaled, unit), unit=unit,
            ))
            continue
        prep = preps.get(preparation_id) if preparation_id is not None else None
        children: list[PrintableComponentOut] = []
        if prep is not None and depth < MAX_DEPTH and prep.standard_yield_qty > 0:
            plines = db.execute(select(PreparationLine).where(PreparationLine.preparation_id == prep.id)).scalars().all()
            child_mult = Decimal(scaled) / Decimal(prep.standard_yield_qty)
            children = _expand(
                db, [(l.ingredient_id, l.component_preparation_id, l.qty_base, l.unit) for l in plines],
                multiplier=child_mult, depth=depth + 1,
            )
        out.append(PrintableComponentOut(
            kind="preparation", name=prep.name if prep else "—", qty=_qty_text(scaled, unit), unit=unit,
            components=children,
        ))
    return out


def _money(value: Decimal | None) -> str | None:
    return None if value is None else format(value.quantize(Decimal("0.01")), "f")


def printable(
    db: Session, actor: Actor, *, product_id: int | None = None, preparation_id: int | None = None,
    scale: int = 1, with_costs: bool = False,
) -> PrintableSheetOut:
    if scale < 1 or scale > 500:
        raise AppError("VALIDATION_ERROR", "scale: entre 1 y 500", status=400)
    sheet = get_sheet(db, actor, product_id=product_id, preparation_id=preparation_id)
    n = Decimal(scale)
    if product_id is not None:
        from app.catalog import service as catalog_service
        from app.recipes.service import get_product_recipe

        product = catalog_service.product_or_404(db, actor, product_id)
        recipe = db.execute(select(Recipe).where(Recipe.product_id == product_id)).scalar_one_or_none()
        version, lines = _product_lines(db, recipe)
        cost_out: PrintableCostOut | None = None
        if with_costs:
            pr = get_product_recipe(db, actor=actor, product_id=product_id)
            unit_cost = Decimal(pr.theoretical_cost) if pr.theoretical_cost is not None else None
            cost_out = PrintableCostOut(
                total=_money(unit_cost * n if unit_cost is not None else None),
                per_unit=_money(unit_cost),
                food_cost_pct=str(pr.food_cost_pct) if pr.food_cost_pct is not None else None,
                net_price=pr.net_price,
            )
        return PrintableSheetOut(
            kind="product", id=product.id, name=product.name,
            scale_text="1 porción" if scale == 1 else f"{scale} porciones", scale=scale,
            recipe_version=version, sheet=sheet, components=_expand(db, lines, multiplier=n), cost=cost_out,
            generated_at=clock.now_utc(),
        )

    from app.recipes.service import preparation_admin_out, preparation_or_404

    prep = preparation_or_404(db, actor, preparation_id)  # type: ignore[arg-type]
    plines = db.execute(select(PreparationLine).where(PreparationLine.preparation_id == prep.id)).scalars().all()
    lines = [(l.ingredient_id, l.component_preparation_id, l.qty_base, l.unit) for l in plines]
    yield_text = f"{_qty_text(int(prep.standard_yield_qty * scale), prep.standard_yield_unit)} {prep.standard_yield_unit}"
    cost_out = None
    if with_costs:
        admin = preparation_admin_out(db, prep)
        per_unit = Decimal(admin.unit_cost) if admin.unit_cost is not None else None
        yield_units = units.base_qty_to_decimal(prep.standard_yield_qty, prep.standard_yield_unit) * n
        cost_out = PrintableCostOut(
            total=_money(per_unit * yield_units if per_unit is not None else None),
            per_unit=_money(per_unit), food_cost_pct=None, net_price=None,
        )
    return PrintableSheetOut(
        kind="preparation", id=prep.id, name=prep.name,
        scale_text=f"Rinde {yield_text}" + ("" if scale == 1 else f" ({scale} tandas)"), scale=scale,
        recipe_version=None, sheet=sheet, components=_expand(db, lines, multiplier=n), cost=cost_out,
        generated_at=clock.now_utc(),
    )
