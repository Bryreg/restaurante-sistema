"""Receta sospechosa de unidad (§4.3, "los 18 «kg» donde iban 18 g"):
criterio doble, declarado en `app.recipes.service`:

1. Techo absoluto por unidad base (`SUSPICIOUS_CEILING_BASE_UNIT`): una línea
   que por sí sola supera 10 kg / 10 L / 500 unidades es sospechosa aunque no
   haya con qué compararla todavía (categoría nueva).
2. Mediana de su categoría (`SUSPICIOUS_CATEGORY_MULTIPLIER = 100`, con al
   menos `MIN_CATEGORY_SAMPLE` líneas comparables): una línea que se aparta
   dos órdenes de magnitud (>= 100x o <= 1/100) de la mediana de las demás
   líneas de insumos de su misma categoría, en su misma unidad base.
"""

from __future__ import annotations

from typing import Any

from sqlalchemy.orm import Session

from app.recipes import service
from app.recipes.schemas import ComponentLineIn, ProductRecipeIn


def test_suspicious_by_absolute_ceiling(
    db: Session, org: Any, store: Any, admin_actor: Any, make_ingredient: Any, make_product: Any
) -> None:
    ingredient = make_ingredient("Sal (techo)", category="Abarrotes (techo)", base_unit="g")
    product = make_product("Plato con 15kg de sal (techo)")
    service.put_product_recipe(
        db, actor=admin_actor, product_id=product.id,
        data=ProductRecipeIn(version=0, lines=[ComponentLineIn(ingredient_id=ingredient.id, qty="15", unit="kg")]),
    )
    normal_ingredient = make_ingredient("Arroz (techo normal)", category="Abarrotes (techo)", base_unit="g")
    normal_product = make_product("Plato con 200g de arroz (techo normal)")
    service.put_product_recipe(
        db, actor=admin_actor, product_id=normal_product.id,
        data=ProductRecipeIn(
            version=0, lines=[ComponentLineIn(ingredient_id=normal_ingredient.id, qty="200", unit="g")]
        ),
    )

    findings = service.suspicious_recipe_lines(db, store_id=store.id)
    flagged_products = {f["product_id"] for f in findings}
    assert product.id in flagged_products
    assert normal_product.id not in flagged_products
    reason = next(f["reason"] for f in findings if f["product_id"] == product.id)
    assert "techo" in reason


def test_suspicious_by_category_median_deviation(
    db: Session, org: Any, store: Any, admin_actor: Any, make_ingredient: Any, make_product: Any
) -> None:
    category = "Frutas (mediana)"
    samples = [("2", "unit"), ("3", "unit"), ("4", "unit"), ("3", "unit")]
    sample_product_ids: set[int] = set()
    for i, (qty, unit) in enumerate(samples):
        ingredient = make_ingredient(f"Fruta muestra {i}", category=category, base_unit=unit)
        product = make_product(f"Plato fruta muestra {i}")
        service.put_product_recipe(
            db, actor=admin_actor, product_id=product.id,
            data=ProductRecipeIn(version=0, lines=[ComponentLineIn(ingredient_id=ingredient.id, qty=qty, unit=unit)]),
        )
        sample_product_ids.add(product.id)

    outlier_ingredient = make_ingredient("Fruta atípica (mediana)", category=category, base_unit="unit")
    outlier_product = make_product("Plato con fruta atípica (mediana)")
    service.put_product_recipe(
        db, actor=admin_actor, product_id=outlier_product.id,
        data=ProductRecipeIn(
            version=0, lines=[ComponentLineIn(ingredient_id=outlier_ingredient.id, qty="400", unit="unit")]
        ),
    )  # 400 unidades: por debajo del techo (500) pero 100x+ la mediana (3) de su categoría.

    findings = service.suspicious_recipe_lines(db, store_id=store.id)
    flagged_products = {f["product_id"] for f in findings}
    assert outlier_product.id in flagged_products
    # Las muestras normales (mediana ~3) no deberían dispararse entre sí.
    assert not (sample_product_ids & flagged_products)
    reason = next(f["reason"] for f in findings if f["product_id"] == outlier_product.id)
    assert "mediana" in reason
