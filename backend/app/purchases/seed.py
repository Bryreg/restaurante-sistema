"""Datos de desarrollo de `purchases`: `seed_purchases(db, store)`.

La llama `app.seed.seed()` (territorio ajeno) después de
`app.inventory.seed.seed_inventory` — necesita insumos reales para poder
armar líneas de recepción. **Idempotente**: si la sede ya tiene algún
proveedor, no repite nada.

Dos proveedores (uno `invoices_required`), al menos dos recepciones
confirmadas con lote y vencimiento (la segunda con fecha POSTERIOR a la
primera y vencimientos distintos, para que el FEFO y el promedio ponderado
de `inventory`/2b tengan contra qué probarse en una base recién sembrada), y
una cuenta por pagar aprobada con un pago parcial.

Escribe las filas DIRECTO (como `seed_inventory`), sin pasar por
`app.purchases.service.create_reception`/`approve_payable`/`create_payment`:
esas funciones verifican PIN de verdad (`received_by_pin`/`authorizer_pin`)
contra el hash de una persona, y el seed no conoce en texto plano el PIN del
admin que `app.seed` crea (no es su territorio leer esa constante) — así que
reproduce la misma escritura atómica (un `record_movement` y un
`create_stock_batch` por línea, una cuenta por pagar) usando directamente al
primer `admin` activo de la organización como quien recibe/autoriza, igual
que `seed_inventory` inserta filas sin pasar por el router HTTP.
"""

from __future__ import annotations

from datetime import timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.auth.deps import Actor
from app.auth.models import Employee
from app.core import clock, tz
from app.core.quantity import line_cost_micros, micros_to_pesos, parse_cost_micros, parse_qty_base
from app.inventory import hooks as inventory_hooks
from app.inventory.models import CostSource, Ingredient, MovementCause
from app.purchases import hooks as purchases_hooks
from app.purchases.models import Payable, PayableStatus, Payment, PaymentMethod, Reception, ReceptionLine, ReceptionStatus, Supplier
from app.stores import service as stores_service
from app.stores.models import Store


def _find_admin(db: Session, *, organization_id: int) -> Employee | None:
    return db.execute(
        select(Employee).where(
            Employee.organization_id == organization_id, Employee.role == "admin", Employee.active.is_(True)
        )
    ).scalars().first()


def _make_reception(
    db: Session,
    *,
    store: Store,
    supplier: Supplier,
    admin: Employee,
    ingredients: list[Ingredient],
    invoice_number: str | None,
    business_date_offset_days: int,
    lot_suffix: str,
    expires_in_days: int,
) -> Reception:
    now = clock.now_utc() - timedelta(days=business_date_offset_days)
    business_date = tz.business_date_for(now, store.cutoff_hour)
    invoice_date = business_date
    fiscal = stores_service.current_fiscal(db, store.id, on=invoice_date)
    inc_responsible = fiscal.inc_responsible if fiscal is not None else True

    actor = Actor(
        kind="admin",
        organization_id=store.organization_id,
        store_id=None,
        employee_id=admin.id,
        employee_name=admin.name,
        role="admin",
    )

    reception = Reception(
        organization_id=store.organization_id,
        store_id=store.id,
        supplier_id=supplier.id,
        invoice_number=invoice_number,
        invoice_date=invoice_date,
        no_invoice=invoice_number is None,
        photo=None,
        received_by_employee_id=admin.id,
        received_by_employee_name=admin.name,
        created_by_employee_id=admin.id,
        created_by_employee_name=admin.name,
        status=ReceptionStatus.CONFIRMED,
        price_confirmed=False,
        price_confirmed_by_employee_id=None,
        price_confirmed_by_employee_name=None,
        at=now,
        business_date=business_date,
    )
    db.add(reception)
    db.flush()

    payable_amount = 0
    for idx, ingredient in enumerate(ingredients):
        qty_received_base = parse_qty_base("5" if ingredient.base_unit.value == "unit" else "5000")
        qty_invoiced_base = qty_received_base
        purchase_unit_price_micros = parse_cost_micros("50000")
        unit_cost_micros = purchase_unit_price_micros // ingredient.purchase_factor
        tax_amount = 0
        tax_per_base_unit_micros = 0
        final_unit_cost_micros = unit_cost_micros + tax_per_base_unit_micros

        line = ReceptionLine(
            reception_id=reception.id,
            ingredient_id=ingredient.id,
            qty_received_base=qty_received_base,
            qty_invoiced_base=qty_invoiced_base,
            purchase_unit_price_micros=purchase_unit_price_micros,
            unit_cost_micros=unit_cost_micros,
            final_unit_cost_micros=final_unit_cost_micros,
            tax_base=0,
            tax_rate=0,
            tax_amount=tax_amount,
            lot_code=f"L-{lot_suffix}-{idx + 1}",
            expires_at=(now + timedelta(days=expires_in_days)).date(),
        )
        db.add(line)
        db.flush()

        movement = inventory_hooks.record_movement(
            db,
            organization_id=store.organization_id,
            store_id=store.id,
            ingredient_id=ingredient.id,
            qty_base=qty_received_base,
            cause=MovementCause.PURCHASE,
            cost_micros=final_unit_cost_micros,
            cost_source=CostSource.LAST_PURCHASE,
            actor=actor,
            business_date=business_date,
            at=now,
            ref_type="reception_line",
            ref_id=line.id,
        )
        batch = purchases_hooks.create_stock_batch(
            db,
            organization_id=store.organization_id,
            store_id=store.id,
            ingredient_id=ingredient.id,
            qty_base=qty_received_base,
            unit_cost_micros=final_unit_cost_micros,
            cost_source=CostSource.LAST_PURCHASE,
            lot_code=line.lot_code,
            expires_at=line.expires_at,
            received_at=now,
            business_date=business_date,
            source_type="reception",
            source_id=reception.id,
        )
        line.stock_movement_id = movement.id
        line.stock_batch_id = getattr(batch, "id", None)
        db.flush()

        pretax_invoiced_micros = line_cost_micros(qty_invoiced_base, unit_cost_micros)
        payable_amount += micros_to_pesos(pretax_invoiced_micros) + tax_amount

    due_date = invoice_date + timedelta(days=supplier.payment_term_days)
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
    return reception


def seed_purchases(db: Session, store: Store) -> None:
    if db.execute(select(Supplier).where(Supplier.store_id == store.id)).scalars().first() is not None:
        return

    admin = _find_admin(db, organization_id=store.organization_id)
    if admin is None:
        print("  Compras: no hay ningún admin activo en la organización todavía; se omite (correlo de nuevo tras crear uno).")
        return

    now = clock.now_utc()
    supplier_a = Supplier(
        organization_id=store.organization_id,
        store_id=store.id,
        name="Distribuidora La Sabana",
        nit="900123456-1",
        payment_term_days=30,
        contact_name="Carlos Ruiz",
        contact_phone="3001234567",
        invoices_required=True,
        active=True,
        created_at=now,
        updated_at=now,
    )
    supplier_b = Supplier(
        organization_id=store.organization_id,
        store_id=store.id,
        name="Plaza de Mercado Paloquemao",
        nit=None,
        payment_term_days=0,
        contact_name=None,
        contact_phone=None,
        invoices_required=False,
        active=True,
        created_at=now,
        updated_at=now,
    )
    db.add_all([supplier_a, supplier_b])
    db.flush()

    ingredients = list(
        db.execute(
            select(Ingredient).where(Ingredient.store_id == store.id, Ingredient.active.is_(True)).order_by(Ingredient.id)
        ).scalars()
    )
    if not ingredients:
        print("  Compras: proveedores cargados; sin insumos todavía en la sede, se omiten recepciones (correlo tras app.inventory.seed).")
        return

    first_lines = ingredients[:2] if len(ingredients) >= 2 else ingredients[:1]
    second_lines = ingredients[1:3] if len(ingredients) >= 2 else ingredients[:1]

    reception_1 = _make_reception(
        db,
        store=store,
        supplier=supplier_a,
        admin=admin,
        ingredients=first_lines,
        invoice_number="FE-1001",
        business_date_offset_days=10,
        lot_suffix="A",
        expires_in_days=20,
    )
    _make_reception(
        db,
        store=store,
        supplier=supplier_b,
        admin=admin,
        ingredients=second_lines,
        invoice_number=None,
        business_date_offset_days=3,
        lot_suffix="B",
        expires_in_days=45,
    )

    # Una cuenta por pagar aprobada con un pago parcial: la de la primera
    # recepción (con factura, plazo de 30 días).
    payable = db.execute(select(Payable).where(Payable.reception_id == reception_1.id)).scalar_one()
    payable.status = PayableStatus.APPROVED
    payable.approved_at = now
    payable.approved_by_employee_id = admin.id
    payable.approved_by_employee_name = admin.name
    db.flush()

    partial_amount = max(1, payable.amount // 2)
    payment = Payment(
        organization_id=store.organization_id,
        store_id=store.id,
        payable_id=payable.id,
        amount=partial_amount,
        method=PaymentMethod.TRANSFER,
        paid_at=now,
        reference="Transferencia parcial de siembra",
        from_cash_drawer=False,
        cash_movement_id=None,
        employee_id=admin.id,
        employee_name=admin.name,
        authorized_by_employee_id=admin.id,
        authorized_by_employee_name=admin.name,
        created_at=now,
    )
    db.add(payment)
    db.flush()

    print(f"  Compras: 2 proveedores, 2 recepciones con lote y vencimiento, 1 cuenta por pagar aprobada con pago parcial (${partial_amount:,} de ${payable.amount:,}).")
