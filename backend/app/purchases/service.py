"""Reglas de negocio de `purchases` (SPEC-NEGOCIO §5.6; `features/fase-2-
costo-inventario/spec.md § Alcance de 2b`).

**Atomicidad de `create_reception`**: primero se VALIDA todo (proveedor,
`no_invoice`/`invoices_required`, cada insumo, las dos guardas de tecleo) sin
escribir nada — `app.core.db.get_db` comitea también ante un `AppError`, así
que la única forma de que "si algo falla no queda nada" sea cierta es que,
para cuando el primer `db.add()` ocurre, ya no pueda saltar ningún
`AppError` de negocio. Lo que SÍ puede fallar durante la escritura (una
dependencia de `app.inventory` que todavía no aterrizó, un error inyectado
en un test) es una excepción que NO es `AppError` — y ésas sí hacen
`rollback()` completo, que es exactamente la garantía que pide el checklist.

**Atomicidad de `reverse_reception`**: las dos guardas (`LOT_CONSUMED`,
`PAYABLE_HAS_PAYMENTS`) se revisan antes de tocar nada; la escritura en sí
(reversar cada lote + un movimiento espejo por línea + cancelar la cuenta por
pagar) corre dentro de un `SAVEPOINT` (`db.begin_nested()`) para que un
`AppError` que aparezca a mitad de un loop de varias líneas (por ejemplo,
`LOT_CONSUMED` en la línea 3 de 5, si alguien ya consumió ese lote después de
que este mismo request empezó) revierta también lo que las líneas 1 y 2 ya
habían escrito — mismo patrón que `reserve_next_number` + `issue_document` en
`app.fiscal.service` (`docs/ESTADO.md`, entrega 1b-2).
"""

from __future__ import annotations

from datetime import date, datetime, timedelta
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.audit.service import record_audit
from app.auth import service as auth_service
from app.auth.deps import Actor
from app.auth.models import Employee
from app.core import clock, tz
from app.core.errors import AppError, NotFoundError
from app.core.money import format_cop
from app.core.percent import format_pct_bp
from app.core.quantity import (
    COST_SCALE,
    QTY_SCALE,
    line_cost_micros,
    micros_to_pesos,
    parse_cost_micros,
    parse_qty_base,
)
from app.core.security import verify_secret
from app.inventory import hooks as inventory_hooks
from app.inventory.models import CostSource, Ingredient, MovementCause
from app.purchases import hooks as purchases_hooks
from app.purchases.models import (
    Payable,
    PayableStatus,
    Payment,
    PaymentMethod,
    Reception,
    ReceptionLine,
    ReceptionStatus,
    Supplier,
)
from app.purchases.schemas import ReceptionIn, ReceptionLineIn
from app.stores import service as stores_service
from app.stores.models import Store

# Guardas de tecleo (§4.1/§5.6, `features/fase-2-costo-inventario/spec.md`).
PACKAGE_GUARD_MIN_MULTIPLIER = 10
PACKAGE_GUARD_MAX_MULTIPLIER = 12
PRICE_JUMP_PCT = 15


# ---------------------------------------------------------------------------
# Proveedores.
# ---------------------------------------------------------------------------


def get_supplier_or_404(db: Session, *, organization_id: int, supplier_id: int) -> Supplier:
    row = db.get(Supplier, supplier_id)
    if row is None or row.organization_id != organization_id:
        raise NotFoundError("El proveedor no existe en esta organización")
    return row


def list_suppliers(db: Session, *, store_id: int, active: bool | None = None) -> list[Supplier]:
    stmt = select(Supplier).where(Supplier.store_id == store_id)
    if active is not None:
        stmt = stmt.where(Supplier.active == active)
    stmt = stmt.order_by(Supplier.name)
    return list(db.execute(stmt).scalars())


def _check_duplicate_nit(db: Session, *, store_id: int, nit: str | None, exclude_id: int | None = None) -> None:
    if not nit:
        return
    stmt = select(Supplier).where(Supplier.store_id == store_id, Supplier.nit == nit)
    if exclude_id is not None:
        stmt = stmt.where(Supplier.id != exclude_id)
    existing = db.execute(stmt).scalars().first()
    if existing is not None:
        raise AppError(
            code="SUPPLIER_DUPLICATE_NIT",
            message=f'Ya existe un proveedor con NIT "{nit}" en esta sede ("{existing.name}")',
            status=400,
        )


def create_supplier(db: Session, *, store: Store, data: Any) -> Supplier:
    _check_duplicate_nit(db, store_id=store.id, nit=data.nit)
    now = clock.now_utc()
    row = Supplier(
        organization_id=store.organization_id,
        store_id=store.id,
        name=data.name,
        nit=data.nit,
        payment_term_days=data.payment_term_days,
        contact_name=data.contact_name,
        contact_phone=data.contact_phone,
        invoices_required=data.invoices_required,
        active=data.active,
        created_at=now,
        updated_at=now,
    )
    db.add(row)
    db.flush()
    return row


def update_supplier(db: Session, *, supplier: Supplier, data: Any) -> Supplier:
    fields = data.model_dump(exclude_unset=True)
    if "nit" in fields:
        _check_duplicate_nit(db, store_id=supplier.store_id, nit=fields["nit"], exclude_id=supplier.id)
    for key, value in fields.items():
        setattr(supplier, key, value)
    supplier.updated_at = clock.now_utc()
    db.flush()
    return supplier


def deactivate_supplier(db: Session, *, supplier: Supplier) -> Supplier:
    supplier.active = False
    supplier.updated_at = clock.now_utc()
    db.flush()
    return supplier


def _weighted_average_reference(db: Session, *, store_id: int, ingredient_id: int) -> int | None:
    """Referencia local de `purchases` para las guardas de tecleo: promedio
    ponderado de TODAS las recepciones confirmadas del insumo (histórico
    completo). Es una aproximación deliberadamente más simple que la que
    construye `inventory` para `resolve_ingredient_cost` ("desde el último
    conteo completo"): acá sólo hace falta un número contra el que
    comparar un precio recién tecleado, no la jerarquía de costo oficial."""
    rows = db.execute(
        select(ReceptionLine.qty_received_base, ReceptionLine.unit_cost_micros)
        .join(Reception, Reception.id == ReceptionLine.reception_id)
        .where(
            Reception.store_id == store_id,
            Reception.status == ReceptionStatus.CONFIRMED,
            ReceptionLine.ingredient_id == ingredient_id,
        )
    ).all()
    total_qty = sum(row[0] for row in rows)
    if total_qty <= 0:
        return None
    total_weighted = sum(row[0] * row[1] for row in rows)
    return total_weighted // total_qty


def _reference_cost_micros(db: Session, *, store_id: int, ingredient: Ingredient) -> int | None:
    weighted = _weighted_average_reference(db, store_id=store_id, ingredient_id=ingredient.id)
    if weighted is not None:
        return weighted
    if ingredient.official_cost_micros is not None:
        return ingredient.official_cost_micros
    if ingredient.estimated_cost_micros is not None:
        return ingredient.estimated_cost_micros
    return None


def _guard_code(reference_micros: int | None, entered_micros: int) -> str | None:
    if reference_micros is None or reference_micros <= 0 or entered_micros <= 0:
        return None
    if PACKAGE_GUARD_MIN_MULTIPLIER * reference_micros <= entered_micros <= PACKAGE_GUARD_MAX_MULTIPLIER * reference_micros:
        return "PRICE_LOOKS_LIKE_PACKAGE"
    diff = abs(entered_micros - reference_micros)
    if diff * 100 > PRICE_JUMP_PCT * reference_micros:
        return "PRICE_JUMP"
    return None


def _verify_received_by(db: Session, *, organization_id: int, store_id: int, pin: str) -> Employee:
    """El PIN de quien recibe es ATRIBUCIÓN (SPEC-NEGOCIO §5.6, misión de
    este agente), no una autorización con matriz de roles: cualquier persona
    activa de la sede (o de la organización, los admin) puede figurar como
    quien recibió — mismo patrón de búsqueda por PIN que
    `app.inventory.service._verify_responsible` para la merma (territorio
    ajeno, mismo criterio) y que `app.auth.service.verify_authorizer` (que
    sí exige rol admin/supervisor, y que este dominio usa aparte para las
    acciones que exigen autorización de verdad: aprobar, pagar, revertir)."""
    candidates = (
        db.execute(select(Employee).where(Employee.organization_id == organization_id, Employee.active.is_(True)))
        .scalars()
        .all()
    )
    in_scope = [e for e in candidates if e.store_id is None or e.store_id == store_id]
    for candidate in in_scope:
        if verify_secret(pin, candidate.pin_hash):
            return candidate
    raise AppError(code="RECEIVED_BY_PIN_INVALID", message="El PIN de quien recibe no corresponde a nadie activo de esta sede", status=400)


def get_reception_or_404(db: Session, *, organization_id: int, reception_id: int) -> Reception:
    row = db.get(Reception, reception_id)
    if row is None or row.organization_id != organization_id:
        raise NotFoundError("La recepción no existe en esta organización")
    return row


def list_receptions(
    db: Session,
    *,
    store_id: int,
    date_from: date | None = None,
    date_to: date | None = None,
    supplier_id: int | None = None,
    status: str | None = None,
) -> list[Reception]:
    stmt = select(Reception).where(Reception.store_id == store_id)
    if date_from is not None:
        stmt = stmt.where(Reception.business_date >= date_from)
    if date_to is not None:
        stmt = stmt.where(Reception.business_date <= date_to)
    if supplier_id is not None:
        stmt = stmt.where(Reception.supplier_id == supplier_id)
    if status is not None:
        stmt = stmt.where(Reception.status == status)
    stmt = stmt.order_by(Reception.at.desc())
    return list(db.execute(stmt).scalars())


def get_reception_lines(db: Session, *, reception_id: int) -> list[ReceptionLine]:
    stmt = select(ReceptionLine).where(ReceptionLine.reception_id == reception_id).order_by(ReceptionLine.id)
    return list(db.execute(stmt).scalars())


def get_payable_for_reception(db: Session, *, reception_id: int) -> Payable | None:
    return db.execute(select(Payable).where(Payable.reception_id == reception_id)).scalar_one_or_none()


def _prepare_line(
    db: Session,
    *,
    store: Store,
    idx: int,
    line: ReceptionLineIn,
    inc_responsible: bool,
) -> dict[str, Any]:
    ingredient = inventory_hooks.get_ingredient(db, store_id=store.id, ingredient_id=line.ingredient_id)
    if ingredient is None:
        raise NotFoundError(f"lines[{idx}]: el insumo {line.ingredient_id} no existe en esta sede")
    if not ingredient.active:
        raise AppError(
            code="INGREDIENT_INACTIVE",
            message=f'lines[{idx}]: el insumo "{ingredient.name}" está inactivo',
            status=400,
        )

    qty_received_base = parse_qty_base(line.qty_received, field=f"lines[{idx}].qty_received")
    qty_invoiced_base = parse_qty_base(line.qty_invoiced, field=f"lines[{idx}].qty_invoiced")
    if qty_received_base <= 0:
        raise AppError(code="VALIDATION_ERROR", message=f"lines[{idx}].qty_received: tiene que ser mayor a cero", status=400)
    if qty_invoiced_base <= 0:
        raise AppError(code="VALIDATION_ERROR", message=f"lines[{idx}].qty_invoiced: tiene que ser mayor a cero", status=400)

    purchase_unit_price_micros = parse_cost_micros(line.purchase_unit_price, field=f"lines[{idx}].purchase_unit_price")
    unit_cost_micros = purchase_unit_price_micros // ingredient.purchase_factor

    tax_per_base_unit_micros = 0
    if inc_responsible and line.tax_amount > 0:
        tax_amount_micros_total = line.tax_amount * COST_SCALE
        tax_per_base_unit_micros = (tax_amount_micros_total * QTY_SCALE) // qty_invoiced_base
    final_unit_cost_micros = unit_cost_micros + tax_per_base_unit_micros

    return {
        "ingredient": ingredient,
        "qty_received_base": qty_received_base,
        "qty_invoiced_base": qty_invoiced_base,
        "purchase_unit_price_micros": purchase_unit_price_micros,
        "unit_cost_micros": unit_cost_micros,
        "final_unit_cost_micros": final_unit_cost_micros,
        "tax_base": line.tax_base,
        "tax_rate": line.tax_rate,
        "tax_amount": line.tax_amount,
        "lot_code": line.lot_code,
        "expires_at": line.expires_at,
    }


def create_reception(db: Session, *, actor: Actor, store: Store, payload: ReceptionIn) -> Reception:
    supplier = get_supplier_or_404(db, organization_id=store.organization_id, supplier_id=payload.supplier_id)
    if supplier.store_id != store.id:
        raise NotFoundError("El proveedor no existe en esta sede")
    if not supplier.active:
        raise AppError(code="SUPPLIER_INACTIVE", message="El proveedor está inactivo; reactivalo antes de recibirle mercancía", status=400)

    if payload.no_invoice and supplier.invoices_required:
        raise AppError(
            code="INVOICE_REQUIRED",
            message=f'"{supplier.name}" está marcado como obligado a facturar; cargá número y fecha de factura, o desmarcá "obligado a facturar" en el proveedor',
            status=400,
        )

    received_by = _verify_received_by(db, organization_id=store.organization_id, store_id=store.id, pin=payload.received_by_pin)

    now = clock.now_utc()
    business_date = tz.business_date_for(now, store.cutoff_hour)
    fiscal = stores_service.current_fiscal(db, store.id, on=payload.invoice_date)
    inc_responsible = fiscal.inc_responsible if fiscal is not None else True

    # -- Fase 1: validar TODO antes de escribir nada (ver docstring del módulo). --
    prepared: list[dict[str, Any]] = []
    guard_triggered = False
    for idx, line in enumerate(payload.lines):
        prepared_line = _prepare_line(db, store=store, idx=idx, line=line, inc_responsible=inc_responsible)
        reference = _reference_cost_micros(db, store_id=store.id, ingredient=prepared_line["ingredient"])
        code = _guard_code(reference, prepared_line["unit_cost_micros"])
        if code is not None:
            if not payload.confirm_price:
                ingredient_name = prepared_line["ingredient"].name
                if code == "PRICE_LOOKS_LIKE_PACKAGE":
                    message = (
                        f'lines[{idx}]: el precio tecleado para "{ingredient_name}" parece un precio de empaque '
                        f"(entre {PACKAGE_GUARD_MIN_MULTIPLIER} y {PACKAGE_GUARD_MAX_MULTIPLIER} veces la referencia); "
                        "si es correcto, repetí la recepción con confirm_price: true"
                    )
                else:
                    message = (
                        f'lines[{idx}]: el precio de "{ingredient_name}" se aleja más de {format_pct_bp(PRICE_JUMP_PCT * 100, decimals=0)} del promedio '
                        "ponderado; si es correcto, repetí la recepción con confirm_price: true"
                    )
                raise AppError(code=code, message=message, status=409)
            guard_triggered = True
        prepared.append(prepared_line)

    # -- Fase 2: escribir. Ya no debería saltar ningún AppError de negocio. --
    reception = Reception(
        organization_id=store.organization_id,
        store_id=store.id,
        supplier_id=supplier.id,
        invoice_number=payload.invoice_number,
        invoice_date=payload.invoice_date,
        no_invoice=payload.no_invoice,
        invoice_total=payload.invoice_total,
        photo=payload.photo,
        received_by_employee_id=received_by.id,
        received_by_employee_name=received_by.name,
        created_by_employee_id=actor.employee_id or received_by.id,
        created_by_employee_name=actor.employee_name or received_by.name,
        status=ReceptionStatus.CONFIRMED,
        price_confirmed=guard_triggered,
        price_confirmed_by_employee_id=actor.employee_id if guard_triggered else None,
        price_confirmed_by_employee_name=actor.employee_name if guard_triggered else None,
        at=now,
        business_date=business_date,
    )
    db.add(reception)
    db.flush()

    payable_amount = 0
    for prepared_line in prepared:
        ingredient = prepared_line["ingredient"]
        line_row = ReceptionLine(
            reception_id=reception.id,
            ingredient_id=ingredient.id,
            qty_received_base=prepared_line["qty_received_base"],
            qty_invoiced_base=prepared_line["qty_invoiced_base"],
            purchase_unit_price_micros=prepared_line["purchase_unit_price_micros"],
            unit_cost_micros=prepared_line["unit_cost_micros"],
            final_unit_cost_micros=prepared_line["final_unit_cost_micros"],
            tax_base=prepared_line["tax_base"],
            tax_rate=prepared_line["tax_rate"],
            tax_amount=prepared_line["tax_amount"],
            lot_code=prepared_line["lot_code"],
            expires_at=prepared_line["expires_at"],
        )
        db.add(line_row)
        db.flush()

        movement = inventory_hooks.record_movement(
            db,
            organization_id=store.organization_id,
            store_id=store.id,
            ingredient_id=ingredient.id,
            qty_base=prepared_line["qty_received_base"],
            cause=MovementCause.PURCHASE,
            cost_micros=prepared_line["final_unit_cost_micros"],
            cost_source=CostSource.LAST_PURCHASE,
            actor=actor,
            business_date=business_date,
            at=now,
            ref_type="reception_line",
            ref_id=line_row.id,
        )
        batch = purchases_hooks.create_stock_batch(
            db,
            organization_id=store.organization_id,
            store_id=store.id,
            ingredient_id=ingredient.id,
            qty_base=prepared_line["qty_received_base"],
            unit_cost_micros=prepared_line["final_unit_cost_micros"],
            cost_source=CostSource.LAST_PURCHASE,
            lot_code=prepared_line["lot_code"],
            expires_at=prepared_line["expires_at"],
            received_at=now,
            business_date=business_date,
            source_type="reception",
            source_id=reception.id,
        )
        line_row.stock_movement_id = movement.id
        line_row.stock_batch_id = getattr(batch, "id", None)
        db.flush()

        pretax_invoiced_micros = line_cost_micros(prepared_line["qty_invoiced_base"], prepared_line["unit_cost_micros"])
        payable_amount += micros_to_pesos(pretax_invoiced_micros) + prepared_line["tax_amount"]

    due_date = payload.invoice_date + timedelta(days=supplier.payment_term_days)
    payable = Payable(
        organization_id=store.organization_id,
        store_id=store.id,
        supplier_id=supplier.id,
        reception_id=reception.id,
        amount=payable_amount,
        status=PayableStatus.PENDING_REVIEW,
        due_date=due_date,
        created_at=now,
        business_date=business_date,
    )
    db.add(payable)
    db.flush()

    record_audit(
        db,
        actor=actor,
        organization_id=store.organization_id,
        store_id=store.id,
        entity="reception",
        entity_id=reception.id,
        action="create",
        before=None,
        after={"supplier_id": supplier.id, "lines": len(prepared), "payable_id": payable.id, "amount": payable_amount},
    )
    return reception


def reverse_reception(db: Session, *, actor: Actor, reception: Reception, authorizer_pin: str) -> Reception:
    if reception.status == ReceptionStatus.REVERSED:
        raise AppError(code="RECEPTION_ALREADY_REVERSED", message="Esta recepción ya fue revertida", status=400)

    authorizer = auth_service.verify_authorizer(
        db,
        organization_id=reception.organization_id,
        store_id=reception.store_id,
        pin=authorizer_pin,
        action="purchases.reception_reverse",
        requested_by=actor,
    )

    payable = get_payable_for_reception(db, reception_id=reception.id)
    if payable is not None:
        live_payments = db.execute(
            select(func.count()).select_from(Payment).where(Payment.payable_id == payable.id, Payment.voided_at.is_(None))
        ).scalar_one()
        if live_payments:
            raise AppError(
                code="PAYABLE_HAS_PAYMENTS",
                message="Esta recepción tiene una cuenta por pagar con pagos vivos; anulalos antes de revertir la recepción",
                status=409,
            )

    lines = get_reception_lines(db, reception_id=reception.id)
    now = clock.now_utc()

    with db.begin_nested():
        for line in lines:
            if line.stock_batch_id is not None:
                purchases_hooks.reverse_stock_batch(db, batch_id=line.stock_batch_id)
            inventory_hooks.record_movement(
                db,
                organization_id=reception.organization_id,
                store_id=reception.store_id,
                ingredient_id=line.ingredient_id,
                qty_base=-line.qty_received_base,
                cause=MovementCause.RECEPTION_REVERSAL,
                cost_micros=line.final_unit_cost_micros,
                cost_source=CostSource.LAST_PURCHASE,
                actor=actor,
                business_date=reception.business_date,
                at=now,
                ref_type="reception_line_reversal",
                ref_id=line.id,
            )
        if payable is not None:
            payable.status = PayableStatus.CANCELLED
        reception.status = ReceptionStatus.REVERSED
        reception.reversed_at = now
        reception.reversed_by_employee_id = authorizer.id
        reception.reversed_by_employee_name = authorizer.name
        db.flush()

    record_audit(
        db,
        actor=actor,
        organization_id=reception.organization_id,
        store_id=reception.store_id,
        entity="reception",
        entity_id=reception.id,
        action="reverse",
        before={"status": "confirmed"},
        after={"status": "reversed"},
    )
    return reception


def _signed_bp(numerator: int, denominator: int) -> int:
    """`numerator / denominator` en puntos básicos, redondeo mitad hacia
    arriba sobre el valor absoluto y CON signo (`denominator > 0`). Nada de
    `//`, que trunca hacia abajo y corre los negativos, ni de `abs`, que
    pierde si el precio subió o bajó."""
    magnitude = (abs(numerator) * 20_000 + denominator) // (2 * denominator)
    return -magnitude if numerator < 0 else magnitude


def _weighted_median(pairs: list[tuple[int, int]]) -> int | None:
    """Mediana ponderada (inferior) de `(valor, peso)`. Pesos en cero valen
    todos igual (una línea regalada no puede borrar la mediana)."""
    if not pairs:
        return None
    if sum(w for _v, w in pairs) <= 0:
        pairs = [(v, 1) for v, _w in pairs]
    ordered = sorted((v, w) for v, w in pairs if w > 0)
    total = sum(w for _v, w in ordered)
    acc = 0
    for value, weight in ordered:
        acc += weight
        if acc * 2 >= total:
            return value
    return ordered[-1][0]


def _pct_from_bp(bp: int | None) -> int | None:
    """Puntos básicos a por ciento entero (compatibilidad de los campos
    `*_pct`), mitad hacia arriba sobre el valor absoluto, con signo."""
    if bp is None:
        return None
    return -((-bp + 50) // 100) if bp < 0 else (bp + 50) // 100


def _supplier_reliability_data(
    db: Session, *, supplier: Supplier, date_from: date, date_to: date
) -> dict[str, Any]:
    """Confiabilidad de un proveedor, calculada POR INSUMO (informe
    científico #5, analista #9).

    Antes se sumaba `qty_received_base` de todos los insumos juntos (gramos
    con mililitros con unidades) y la «deriva de precio» comparaba cada línea
    contra el costo promedio de TODOS los insumos del período (la sal contra
    la pechuga), con `//` que trunca y `abs` que borra si el precio subió o
    bajó. Ahora:

    - Recibido ÷ facturado se calcula dentro de cada insumo (misma unidad).
    - La deriva de cada línea es su costo unitario sin impuesto contra el de
      la línea ANTERIOR del mismo insumo con el mismo proveedor (aunque esa
      anterior sea de antes del período), con signo. La del insumo es la
      mediana de sus líneas ponderada por plata.
    - El resumen del proveedor es la mediana de sus insumos ponderada por la
      plata de cada insumo en el período.
    """
    history = db.execute(
        select(ReceptionLine, Reception)
        .join(Reception, Reception.id == ReceptionLine.reception_id)
        .where(
            Reception.supplier_id == supplier.id,
            Reception.status == ReceptionStatus.CONFIRMED,
            Reception.business_date <= date_to,
        )
        .order_by(Reception.at, Reception.id, ReceptionLine.id)
    ).all()

    receptions_in_window: dict[int, Reception] = {}
    last_cost: dict[int, int] = {}
    per_ingredient: dict[int, dict[str, Any]] = {}
    for line, reception in history:
        in_window = reception.business_date >= date_from
        previous = last_cost.get(line.ingredient_id)
        last_cost[line.ingredient_id] = line.unit_cost_micros
        if not in_window:
            continue
        receptions_in_window[reception.id] = reception
        bucket = per_ingredient.setdefault(
            line.ingredient_id,
            {"received": 0, "invoiced": 0, "spend_micros": 0, "drifts": [], "receptions": set()},
        )
        weight = line_cost_micros(line.qty_received_base, line.unit_cost_micros)
        bucket["received"] += line.qty_received_base
        bucket["invoiced"] += line.qty_invoiced_base
        bucket["spend_micros"] += weight
        bucket["receptions"].add(reception.id)
        if previous is not None and previous > 0:
            bucket["drifts"].append((_signed_bp(line.unit_cost_micros - previous, previous), weight))

    ingredients_by_id: dict[int, Ingredient] = {}
    if per_ingredient:
        ingredients_by_id = {
            row.id: row for row in db.execute(select(Ingredient).where(Ingredient.id.in_(per_ingredient))).scalars()
        }

    ingredient_rows: list[dict[str, Any]] = []
    for ingredient_id, bucket in per_ingredient.items():
        ingredient = ingredients_by_id.get(ingredient_id)
        received_bp = _signed_bp(bucket["received"], bucket["invoiced"]) if bucket["invoiced"] > 0 else None
        ingredient_rows.append(
            {
                "ingredient_id": ingredient_id,
                "name": ingredient.name if ingredient is not None else f"Insumo #{ingredient_id}",
                "base_unit": (
                    (ingredient.base_unit.value if hasattr(ingredient.base_unit, "value") else str(ingredient.base_unit))
                    if ingredient is not None
                    else ""
                ),
                "n_receptions": len(bucket["receptions"]),
                "received_over_invoiced_bp": received_bp,
                "price_drift_bp": _weighted_median(bucket["drifts"]),
                "n_price_comparisons": len(bucket["drifts"]),
                "spend": micros_to_pesos(bucket["spend_micros"]),
                "_weight": bucket["spend_micros"],
            }
        )
    ingredient_rows.sort(key=lambda r: (-r["_weight"], r["name"]))

    received_bp = _weighted_median(
        [(r["received_over_invoiced_bp"], r["_weight"]) for r in ingredient_rows if r["received_over_invoiced_bp"] is not None]
    )
    drift_bp = _weighted_median(
        [(r["price_drift_bp"], r["_weight"]) for r in ingredient_rows if r["price_drift_bp"] is not None]
    )
    n_receptions = len(receptions_in_window)
    with_invoice = sum(1 for r in receptions_in_window.values() if not r.no_invoice)
    invoice_share_bp = _signed_bp(with_invoice, n_receptions) if n_receptions else None
    spend_micros = sum(r["_weight"] for r in ingredient_rows)
    for row in ingredient_rows:
        del row["_weight"]

    return {
        "receptions": n_receptions,
        "received_over_invoiced_pct": _pct_from_bp(received_bp),
        "invoice_share_pct": _pct_from_bp(invoice_share_bp),
        "avg_price_drift_pct": _pct_from_bp(drift_bp),
        "received_over_invoiced_bp": received_bp,
        "invoice_share_bp": invoice_share_bp,
        "price_drift_bp": drift_bp,
        "n_receptions": n_receptions,
        "n_ingredients": len(ingredient_rows),
        "spend": micros_to_pesos(spend_micros),
        "ingredients": ingredient_rows,
    }


def supplier_reliability(db: Session, *, supplier: Supplier, date_from: date, date_to: date) -> dict[str, Any]:
    if date_from > date_to:
        raise AppError("VALIDATION_ERROR", "from: tiene que ser anterior o igual a to", status=400)
    return _supplier_reliability_data(db, supplier=supplier, date_from=date_from, date_to=date_to)


def suppliers_reliability(db: Session, *, store_id: int, date_from: date, date_to: date) -> list[dict[str, Any]]:
    """La confiabilidad de TODOS los proveedores de la sede, de una vez
    (`GET /admin/suppliers/reliability`), ordenados por nombre. Un proveedor
    sin recepciones en el período sale con `n_receptions: 0` y los
    indicadores en `null` — sin dato, no «100 %»."""
    if date_from > date_to:
        raise AppError("VALIDATION_ERROR", "from: tiene que ser anterior o igual a to", status=400)
    out: list[dict[str, Any]] = []
    for supplier in list_suppliers(db, store_id=store_id):
        data = _supplier_reliability_data(db, supplier=supplier, date_from=date_from, date_to=date_to)
        out.append({"supplier_id": supplier.id, "name": supplier.name, "active": supplier.active, **data})
    out.sort(key=lambda r: r["name"].lower())
    return out


# ---------------------------------------------------------------------------
# Cuentas por pagar y pagos.
# ---------------------------------------------------------------------------


def get_payable_or_404(db: Session, *, organization_id: int, payable_id: int) -> Payable:
    row = db.get(Payable, payable_id)
    if row is None or row.organization_id != organization_id:
        raise NotFoundError("La cuenta por pagar no existe en esta organización")
    return row


def payable_balance(db: Session, payable: Payable) -> int:
    """El saldo SE DERIVA siempre de los pagos vivos — nunca una columna
    (`AGENTS.md`: "una sola matemática, en el backend"; mismo criterio que
    el esperado de caja)."""
    paid = db.execute(
        select(func.coalesce(func.sum(Payment.amount), 0)).where(Payment.payable_id == payable.id, Payment.voided_at.is_(None))
    ).scalar_one()
    return payable.amount - int(paid)


def list_payables(
    db: Session,
    *,
    store_id: int,
    status: str | None = None,
    supplier_id: int | None = None,
    overdue: bool | None = None,
    date_from: date | None = None,
    date_to: date | None = None,
) -> list[Payable]:
    stmt = select(Payable).where(Payable.store_id == store_id)
    if status is not None:
        stmt = stmt.where(Payable.status == status)
    if supplier_id is not None:
        stmt = stmt.where(Payable.supplier_id == supplier_id)
    if date_from is not None:
        stmt = stmt.where(Payable.business_date >= date_from)
    if date_to is not None:
        stmt = stmt.where(Payable.business_date <= date_to)
    rows = list(db.execute(stmt.order_by(Payable.due_date)).scalars())
    if overdue is not None:
        today = clock.now_utc().date()
        filtered = []
        for row in rows:
            balance = payable_balance(db, row)
            is_overdue = row.due_date < today and balance > 0
            if is_overdue == overdue:
                filtered.append(row)
        rows = filtered
    return rows


def payables_summary(db: Session, *, store_id: int) -> dict[str, Any]:
    """Totales de cuentas por pagar para la cabecera de la pantalla
    (`GET /admin/payables/summary`, informe de visualización #8): cuánto se
    debe, cuánto está vencido, cuánto vence en 7 días, por antigüedad y por
    proveedor. El saldo sale de la MISMA regla que `payable_balance` (monto −
    pagos no anulados), y «vencida» es la MISMA que `PayableOut.overdue`
    (`due_date` antes de hoy y saldo > 0, con el mismo «hoy»), así que la
    cabecera no puede contradecir a la tabla de abajo."""
    today = clock.now_utc().date()
    paid_by_payable = {
        payable_id: int(paid)
        for payable_id, paid in db.execute(
            select(Payment.payable_id, func.sum(Payment.amount))
            .join(Payable, Payable.id == Payment.payable_id)
            .where(Payable.store_id == store_id, Payment.voided_at.is_(None))
            .group_by(Payment.payable_id)
        ).all()
    }
    payables = db.execute(
        select(Payable).where(Payable.store_id == store_id, Payable.status != PayableStatus.CANCELLED)
    ).scalars().all()

    aging_keys = ("current", "1_30", "31_60", "over_60")
    aging: dict[str, dict[str, Any]] = {key: {"bucket": key, "amount": 0, "count": 0} for key in aging_keys}
    by_supplier: dict[int, dict[str, int]] = {}
    total_open = total_overdue = due_next_7 = open_count = overdue_count = 0
    horizon = today + timedelta(days=7)
    for payable in payables:
        balance = payable.amount - paid_by_payable.get(payable.id, 0)
        if balance <= 0:
            continue
        total_open += balance
        open_count += 1
        supplier_bucket = by_supplier.setdefault(payable.supplier_id, {"open": 0, "overdue": 0})
        supplier_bucket["open"] += balance
        days_late = (today - payable.due_date).days
        if days_late > 0:
            total_overdue += balance
            overdue_count += 1
            supplier_bucket["overdue"] += balance
            key = "1_30" if days_late <= 30 else "31_60" if days_late <= 60 else "over_60"
        else:
            key = "current"
            if payable.due_date <= horizon:
                due_next_7 += balance
        aging[key]["amount"] += balance
        aging[key]["count"] += 1

    names = {
        supplier.id: supplier.name
        for supplier in db.execute(select(Supplier).where(Supplier.id.in_(by_supplier))).scalars()
    } if by_supplier else {}
    suppliers = [
        {"supplier_id": sid, "name": names.get(sid, f"Proveedor #{sid}"), **totals}
        for sid, totals in by_supplier.items()
    ]
    suppliers.sort(key=lambda r: (-r["open"], r["name"]))
    return {
        "as_of": today,
        "total_open": total_open,
        "total_overdue": total_overdue,
        "due_next_7_days": due_next_7,
        "open_count": open_count,
        "overdue_count": overdue_count,
        "aging": [aging[key] for key in aging_keys],
        "by_supplier": suppliers,
    }


def list_payments(db: Session, *, payable_id: int, include_voided: bool = True) -> list[Payment]:
    """El historial de pagos de una cuenta por pagar, del más viejo al más
    nuevo.

    Los anulados vienen INCLUIDOS por default y marcados: son parte del
    historial, y esconderlos dejaría un saldo que no cierra contra lo que la
    pantalla muestra —el administrador vería tres pagos y un saldo calculado
    sobre dos—. `payable_balance` sigue siendo el único que decide cuánto se
    debe, y sólo cuenta los vivos.

    Sin esta lectura, `POST .../payments/{id}/void` era inusable al día
    siguiente: el `payment_id` sólo existía en la respuesta del `POST` que lo
    creó, así que anular un pago de una sesión anterior era imposible."""
    stmt = select(Payment).where(Payment.payable_id == payable_id)
    if not include_voided:
        stmt = stmt.where(Payment.voided_at.is_(None))
    return list(db.execute(stmt.order_by(Payment.paid_at, Payment.id)).scalars())


def get_invoice_discrepancy(db: Session, *, payable: Payable) -> tuple[int | None, int | None]:
    """`(invoice_total, invoice_discrepancy)` para la salida de la cuenta por
    pagar (D-2, `features/fase-3-dinero-control/spec.md § 1`). Derivado
    siempre de `Reception.invoice_total` — nunca almacenado en `Payable`, que
    sigue siendo sólo el cálculo (`amount`). `invoice_discrepancy` es `None`
    cuando no hay `invoice_total` que comparar (la recepción no capturó
    papel, o es `no_invoice=True`)."""
    reception = db.get(Reception, payable.reception_id)
    invoice_total = reception.invoice_total if reception is not None else None
    if invoice_total is None:
        return None, None
    return invoice_total, invoice_total - payable.amount


def approve_payable(
    db: Session, *, actor: Actor, payable: Payable, authorizer_pin: str, confirm_discrepancy: bool = False
) -> Payable:
    if payable.status == PayableStatus.APPROVED:
        raise AppError(code="PAYABLE_ALREADY_APPROVED", message="Esta cuenta por pagar ya está aprobada", status=400)
    if payable.status == PayableStatus.CANCELLED:
        raise AppError(code="PAYABLE_CANCELLED", message="Esta cuenta por pagar fue cancelada (su recepción se revirtió)", status=400)

    # D-2: aprobarla exige reconocer la diferencia explícitamente, mismo
    # patrón que `confirm_price` en `create_reception` — `409` + repetir con
    # la confirmación, nunca una segunda forma de decir "ya sé, seguí".
    invoice_total, discrepancy = get_invoice_discrepancy(db, payable=payable)
    discrepancy_present = discrepancy is not None and discrepancy != 0
    if discrepancy_present and not confirm_discrepancy:
        raise AppError(
            code="INVOICE_DISCREPANCY",
            message=(
                f"La factura del proveedor dice {format_cop(invoice_total) if invoice_total is not None else '—'} pero el cálculo de la recepción da "
                f"{format_cop(payable.amount)}; si es correcto, repetí la aprobación con confirm_discrepancy: true"
            ),
            status=409,
        )

    authorizer = auth_service.verify_authorizer(
        db,
        organization_id=payable.organization_id,
        store_id=payable.store_id,
        pin=authorizer_pin,
        action="purchases.payable_approve",
        requested_by=actor,
    )
    payable.status = PayableStatus.APPROVED
    payable.approved_at = clock.now_utc()
    payable.approved_by_employee_id = authorizer.id
    payable.approved_by_employee_name = authorizer.name
    if discrepancy_present:
        payable.discrepancy_confirmed = True
        payable.discrepancy_confirmed_by_employee_id = actor.employee_id
        payable.discrepancy_confirmed_by_employee_name = actor.employee_name
    db.flush()
    record_audit(
        db,
        actor=actor,
        organization_id=payable.organization_id,
        store_id=payable.store_id,
        entity="payable",
        entity_id=payable.id,
        action="approve",
        before={"status": "pending_review"},
        after={
            "status": "approved",
            "invoice_discrepancy": discrepancy,
            "discrepancy_confirmed": payable.discrepancy_confirmed,
        },
    )
    return payable


def create_payment(db: Session, *, actor: Actor, payable: Payable, payload: Any) -> Payment:
    if payable.status != PayableStatus.APPROVED:
        raise AppError(
            code="PAYABLE_NOT_APPROVED",
            message="Aprobá la cuenta por pagar antes de registrar un pago, en Admin → Gastos → Cuentas por pagar",
            status=409,
        )
    if payload.amount <= 0:
        raise AppError(code="VALIDATION_ERROR", message="amount: el pago tiene que ser mayor a cero", status=400)

    balance = payable_balance(db, payable)
    if payload.amount > balance:
        raise AppError(
            code="PAYMENT_EXCEEDS_BALANCE",
            message=f"El pago ({format_cop(payload.amount)}) supera el saldo pendiente ({format_cop(balance)})",
            status=400,
        )

    authorizer = auth_service.verify_authorizer(
        db,
        organization_id=payable.organization_id,
        store_id=payable.store_id,
        pin=payload.authorizer_pin,
        action="purchases.payment_create",
        requested_by=actor,
    )

    cash_movement_id: int | None = None
    if payload.from_cash_drawer:
        # Validar-antes-de-escribir: si no hay turno abierto, esto levanta
        # `AppError("NO_OPEN_SHIFT", ..., 409)` ANTES de que exista ninguna
        # fila `Payment` — el pago no queda (checklist del pedido).
        from app.shifts import hooks as shifts_hooks

        movement = shifts_hooks.register_supplier_payment_expense(
            db,
            organization_id=payable.organization_id,
            store_id=payable.store_id,
            amount=payload.amount,
            actor=actor,
            note=f"Pago a proveedor — cuenta por pagar #{payable.id}",
            reference=payload.reference,
        )
        cash_movement_id = movement.id

    payment = Payment(
        organization_id=payable.organization_id,
        store_id=payable.store_id,
        payable_id=payable.id,
        amount=payload.amount,
        method=PaymentMethod(payload.method),
        # Una hora de pared sin zona (la que entrega `<input
        # type="datetime-local">`) se interpreta como hora de la sede, acá y
        # no en el navegador. Sin esto, `UTCDateTime` la rechaza al guardar y
        # el usuario recibe un `500`: registrar un pago desde la pantalla NO
        # funcionaba, y los tests no lo veían porque arman el JSON con `Z`.
        paid_at=tz.from_bogota_wall_clock(payload.paid_at),
        reference=payload.reference,
        from_cash_drawer=payload.from_cash_drawer,
        cash_movement_id=cash_movement_id,
        employee_id=actor.employee_id or authorizer.id,
        employee_name=actor.employee_name or authorizer.name,
        authorized_by_employee_id=authorizer.id,
        authorized_by_employee_name=authorizer.name,
        created_at=clock.now_utc(),
    )
    db.add(payment)
    db.flush()
    record_audit(
        db,
        actor=actor,
        organization_id=payable.organization_id,
        store_id=payable.store_id,
        entity="purchase_payment",
        entity_id=payment.id,
        action="create",
        before=None,
        after={"payable_id": payable.id, "amount": payment.amount, "from_cash_drawer": payment.from_cash_drawer},
    )
    return payment


def get_payment_or_404(db: Session, *, organization_id: int, payment_id: int) -> Payment:
    row = db.get(Payment, payment_id)
    if row is None or row.organization_id != organization_id:
        raise NotFoundError("El pago no existe en esta organización")
    return row


def void_payment(db: Session, *, actor: Actor, payment: Payment, reason: str, authorizer_pin: str) -> Payment:
    """Anula un pago (nunca lo borra). Ronda 2 — H-1 BLOQUEANTE: un pago que
    salió del cajón (`from_cash_drawer`) deja vivo un `CashMovement(kind=
    EXPENSE, cause=SUPPLIER_PAYMENT)`; si la anulación sólo tocara
    `voided_at`, el saldo de la cuenta por pagar volvería pero la caja nunca
    se enteraría — `compute_breakdown` seguiría restando esa plata y el
    cierre a ciegas mostraría un SOBRANTE fabricado por el monto anulado.

    Decisión del Conciliador/Maestro: **compensar**, nunca borrar. Antes de
    escribir una sola línea del pago (mismo patrón validar-antes-de-escribir
    que `create_reception`/`create_payment`), si el pago salió del cajón se
    crea un `CashMovement` compensatorio (`register_supplier_payment_
    reversal`, `kind=INCOME`, causa tipada `SUPPLIER_PAYMENT`) en el turno
    ABIERTO de la sede AL MOMENTO DE ANULAR — nunca en el turno original si
    ya cerró: un turno `CLOSED` es inviolable porque su conteo a ciegas ya
    ocurrió, y la plata vuelve al cajón HOY, que es lo que pasa físicamente.
    Sin turno abierto, el hook levanta `AppError("NO_OPEN_SHIFT", 409)` y
    ese mismo 409 sale tal cual: la anulación se rechaza completa, ni el
    reintegro ni `voided_at` quedan escritos, y el saldo de la cuenta por
    pagar no se mueve. `compute_breakdown` no cambia: el `INCOME` nuevo
    neutraliza el `EXPENSE` original por construcción, sin tocar el
    movimiento original (nada financiero se borra ni se reescribe).
    """
    if payment.voided_at is not None:
        raise AppError(code="PAYMENT_ALREADY_VOIDED", message="Este pago ya fue anulado", status=400)

    authorizer = auth_service.verify_authorizer(
        db,
        organization_id=payment.organization_id,
        store_id=payment.store_id,
        pin=authorizer_pin,
        action="purchases.payment_void",
        requested_by=actor,
    )

    reversal_movement_id: int | None = None
    if payment.from_cash_drawer:
        if payment.cash_movement_id is None:
            # Inconsistencia que no debería existir: no anular a ciegas.
            raise AppError(
                code="PAYMENT_CASH_MOVEMENT_MISSING",
                message=(
                    "Este pago salió del cajón pero no tiene un movimiento de caja asociado; "
                    "revisalo manualmente antes de anular (no se puede compensar un egreso que no existe)"
                ),
                status=409,
            )
        # Validar-antes-de-escribir: si no hay turno abierto, esto levanta
        # `AppError("NO_OPEN_SHIFT", ..., 409)` ANTES de tocar `voided_at` —
        # la anulación no queda (mismo contrato que `create_payment`).
        from app.shifts import hooks as shifts_hooks

        reversal = shifts_hooks.register_supplier_payment_reversal(
            db,
            organization_id=payment.organization_id,
            store_id=payment.store_id,
            amount=payment.amount,
            actor=actor,
            note=f"Reintegro por anulación del pago a proveedor #{payment.id}",
        )
        reversal_movement_id = reversal.id

    payment.voided_at = clock.now_utc()
    payment.voided_reason = reason
    payment.voided_by_employee_id = authorizer.id
    payment.voided_by_employee_name = authorizer.name
    db.flush()
    record_audit(
        db,
        actor=actor,
        organization_id=payment.organization_id,
        store_id=payment.store_id,
        entity="purchase_payment",
        entity_id=payment.id,
        action="void",
        before={"voided_at": None},
        after={"voided_at": payment.voided_at.isoformat(), "reversal_cash_movement_id": reversal_movement_id},
        reason=reason,
    )
    return payment
