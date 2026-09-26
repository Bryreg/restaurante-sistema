"""Endpoints de `purchases` (`/api/v1/...`).

`POST /receptions` no lleva el prefijo `/admin` en el path (así lo fija el
contrato de la spec, literal), pero exige `current_admin` igual que el resto
del dominio: la recepción lleva precios unitarios y es pantalla de
**administrador**, nunca una ruta bajo sesión de dispositivo (misión de este
agente; `features/fase-2-costo-inventario/spec.md`, invariante heredado #2).
Todo el dominio detrás de `require_feature("purchases")`.
"""

from __future__ import annotations

from datetime import date
from typing import Any

from fastapi import APIRouter, Depends, Query, Request
from sqlalchemy.orm import Session

from app.stores.models import Store

from app.auth.deps import Actor, admin_store, current_admin, current_device, current_operator
from app.core import clock
from app.core.csv import csv_response, wants_csv
from app.core.db import get_db
from app.core.errors import AppError
from app.core.features import require_feature
from app.core.idempotency import hash_request_body, idempotency_key, run_idempotent
from app.core.quantity import format_cost_micros, format_qty_base
from app.inventory import hooks as inventory_hooks
from app.purchases import service
from app.purchases.models import Payable, Reception, ReceptionDraft, Supplier
from app.purchases.schemas import (
    ReceptionSuggestionsOut,
    DeviceReceptionIngredientOut,
    DeviceSupplierOut,
    ReceptionDraftAdminLineOut,
    ReceptionDraftAdminOut,
    ReceptionDraftCompleteIn,
    ReceptionDraftIn,
    ReceptionDraftLineOut,
    ReceptionDraftOut,
    ReceptionDraftRejectIn,
    PayableApproveIn,
    PayableOut,
    PaymentIn,
    PaymentOut,
    PaymentVoidIn,
    ReceptionIn,
    ReceptionLineOut,
    ReceptionOut,
    ReceptionReverseIn,
    SupplierIn,
    SupplierOut,
    PayablesSummaryOut,
    SupplierReliabilityOut,
    SupplierReliabilityRowOut,
    SuppliersReliabilityOut,
    SupplierUpdateIn,
)

router = APIRouter(dependencies=[Depends(require_feature("purchases"))])


# ---------------------------------------------------------------------------
# Presentación.
# ---------------------------------------------------------------------------


def _reception_out(db: Session, reception: Reception) -> ReceptionOut:
    lines = service.get_reception_lines(db, reception_id=reception.id)
    payable = service.get_payable_for_reception(db, reception_id=reception.id)
    line_outs = [
        ReceptionLineOut(
            id=line.id,
            ingredient_id=line.ingredient_id,
            qty_received=format_qty_base(line.qty_received_base),
            qty_invoiced=format_qty_base(line.qty_invoiced_base),
            purchase_unit_price=format_cost_micros(line.purchase_unit_price_micros),
            unit_cost=format_cost_micros(line.unit_cost_micros),
            final_unit_cost=format_cost_micros(line.final_unit_cost_micros),
            tax_base=line.tax_base,
            tax_rate=line.tax_rate,
            tax_amount=line.tax_amount,
            lot_code=line.lot_code,
            expires_at=line.expires_at,
            stock_batch_id=line.stock_batch_id,
            stock_movement_id=line.stock_movement_id,
        )
        for line in lines
    ]
    return ReceptionOut(
        id=reception.id,
        store_id=reception.store_id,
        supplier_id=reception.supplier_id,
        invoice_number=reception.invoice_number,
        invoice_date=reception.invoice_date,
        no_invoice=reception.no_invoice,
        invoice_total=reception.invoice_total,
        photo=reception.photo,
        received_by_employee_id=reception.received_by_employee_id,
        received_by_employee_name=reception.received_by_employee_name,
        status=reception.status.value,  # type: ignore[arg-type]
        price_confirmed=reception.price_confirmed,
        price_confirmed_by_employee_name=reception.price_confirmed_by_employee_name,
        at=reception.at,
        business_date=reception.business_date,
        reversed_at=reception.reversed_at,
        reversed_by_employee_name=reception.reversed_by_employee_name,
        payable_id=payable.id if payable is not None else None,
        lines=line_outs,
    )


def _payable_out(db: Session, payable: Payable) -> PayableOut:
    balance = service.payable_balance(db, payable)
    today = clock.now_utc().date()
    invoice_total, invoice_discrepancy = service.get_invoice_discrepancy(db, payable=payable)
    return PayableOut(
        id=payable.id,
        store_id=payable.store_id,
        supplier_id=payable.supplier_id,
        reception_id=payable.reception_id,
        amount=payable.amount,
        balance=balance,
        status=payable.status.value,  # type: ignore[arg-type]
        due_date=payable.due_date,
        overdue=payable.due_date < today and balance > 0,
        approved_at=payable.approved_at,
        approved_by_employee_name=payable.approved_by_employee_name,
        business_date=payable.business_date,
        invoice_total=invoice_total,
        invoice_discrepancy=invoice_discrepancy,
        discrepancy_confirmed=payable.discrepancy_confirmed,
        discrepancy_confirmed_by_employee_name=payable.discrepancy_confirmed_by_employee_name,
    )


def _idempotent(
    db: Session, *, organization_id: int, scope: str, request: Request, payload: Any, fn: Any
) -> Any:
    key = idempotency_key(request)
    request_hash = hash_request_body(payload.model_dump(mode="json"))
    status, body = run_idempotent(
        db, organization_id=organization_id, scope=scope, key=key, request_hash=request_hash, fn=fn
    )
    return status, body


# ---------------------------------------------------------------------------
# Proveedores.
# ---------------------------------------------------------------------------


@router.get("/admin/suppliers")
def list_suppliers(
    store_id: int,
    active: bool | None = None,
    actor: Actor = Depends(current_admin),
    db: Session = Depends(get_db),
) -> list[SupplierOut]:
    store = admin_store(db, actor, store_id)
    rows = service.list_suppliers(db, store_id=store.id, active=active)
    return [SupplierOut.model_validate(r) for r in rows]


@router.get("/admin/suppliers/reliability")
def suppliers_reliability(
    store_id: int,
    date_from: date = Query(..., alias="from"),
    date_to: date = Query(..., alias="to"),
    actor: Actor = Depends(current_admin),
    db: Session = Depends(get_db),
) -> SuppliersReliabilityOut:
    """Todos los proveedores de la sede de una vez, para compararlos en la
    lista (informe de visualización #9). Misma matemática, por insumo, que
    `GET /admin/suppliers/{id}/reliability`."""
    store = admin_store(db, actor, store_id)
    rows = service.suppliers_reliability(db, store_id=store.id, date_from=date_from, date_to=date_to)
    return SuppliersReliabilityOut(
        store_id=store.id,
        date_from=date_from,
        date_to=date_to,
        rows=[SupplierReliabilityRowOut(date_from=date_from, date_to=date_to, **row) for row in rows],
    )


@router.post("/admin/suppliers", status_code=201)
def create_supplier(
    payload: SupplierIn,
    store_id: int,
    actor: Actor = Depends(current_admin),
    db: Session = Depends(get_db),
) -> SupplierOut:
    store = admin_store(db, actor, store_id)
    row = service.create_supplier(db, store=store, data=payload)
    return SupplierOut.model_validate(row)


@router.patch("/admin/suppliers/{supplier_id}")
def update_supplier(
    supplier_id: int,
    payload: SupplierUpdateIn,
    actor: Actor = Depends(current_admin),
    db: Session = Depends(get_db),
) -> SupplierOut:
    supplier = service.get_supplier_or_404(db, organization_id=actor.organization_id, supplier_id=supplier_id)
    row = service.update_supplier(db, supplier=supplier, data=payload)
    return SupplierOut.model_validate(row)


@router.delete("/admin/suppliers/{supplier_id}")
def delete_supplier(
    supplier_id: int, actor: Actor = Depends(current_admin), db: Session = Depends(get_db)
) -> SupplierOut:
    supplier = service.get_supplier_or_404(db, organization_id=actor.organization_id, supplier_id=supplier_id)
    row = service.deactivate_supplier(db, supplier=supplier)
    return SupplierOut.model_validate(row)


@router.get("/admin/suppliers/{supplier_id}/reliability")
def supplier_reliability(
    supplier_id: int,
    date_from: date = Query(..., alias="from"),
    date_to: date = Query(..., alias="to"),
    actor: Actor = Depends(current_admin),
    db: Session = Depends(get_db),
) -> SupplierReliabilityOut:
    supplier = service.get_supplier_or_404(db, organization_id=actor.organization_id, supplier_id=supplier_id)
    data = service.supplier_reliability(db, supplier=supplier, date_from=date_from, date_to=date_to)
    return SupplierReliabilityOut(supplier_id=supplier.id, date_from=date_from, date_to=date_to, **data)


# ---------------------------------------------------------------------------
# Recepciones.
# ---------------------------------------------------------------------------


@router.post("/receptions", status_code=201)
def create_reception(
    payload: ReceptionIn,
    store_id: int,
    request: Request,
    actor: Actor = Depends(current_admin),
    db: Session = Depends(get_db),
) -> ReceptionOut:
    store = admin_store(db, actor, store_id)

    def _do() -> tuple[int, dict[str, Any]]:
        reception = service.create_reception(db, actor=actor, store=store, payload=payload)
        return 201, _reception_out(db, reception).model_dump(mode="json")

    status_code, body = _idempotent(
        db, organization_id=actor.organization_id, scope="purchases.receptions", request=request, payload=payload, fn=_do
    )
    return ReceptionOut.model_validate(body)


@router.get("/admin/receptions")
def list_receptions(
    store_id: int,
    request: Request,
    date_from: date | None = Query(None, alias="from"),
    date_to: date | None = Query(None, alias="to"),
    supplier_id: int | None = None,
    status: str | None = None,
    format: str | None = Query(None, description='"csv" exporta el listado como CSV'),
    actor: Actor = Depends(current_admin),
    db: Session = Depends(get_db),
) -> Any:
    del format  # declarado para el OpenAPI; el valor real lo lee `wants_csv(request)`.
    store = admin_store(db, actor, store_id)
    rows = service.list_receptions(
        db, store_id=store.id, date_from=date_from, date_to=date_to, supplier_id=supplier_id, status=status
    )
    out = [_reception_out(db, r) for r in rows]
    if wants_csv(request):
        flat = [
            {
                "id": r.id,
                "supplier_id": r.supplier_id,
                "invoice_number": r.invoice_number,
                "invoice_date": r.invoice_date.isoformat(),
                "no_invoice": r.no_invoice,
                "status": r.status,
                "business_date": r.business_date.isoformat(),
                "lines": len(r.lines),
            }
            for r in out
        ]
        return csv_response(flat, filename="receptions.csv")
    return out


@router.get("/admin/receptions/{reception_id}")
def get_reception(
    reception_id: int, actor: Actor = Depends(current_admin), db: Session = Depends(get_db)
) -> ReceptionOut:
    reception = service.get_reception_or_404(db, organization_id=actor.organization_id, reception_id=reception_id)
    admin_store(db, actor, reception.store_id)
    return _reception_out(db, reception)


def _reverse_reception(
    reception_id: int, payload: ReceptionReverseIn, actor: Actor, db: Session
) -> ReceptionOut:
    reception = service.get_reception_or_404(db, organization_id=actor.organization_id, reception_id=reception_id)
    admin_store(db, actor, reception.store_id)
    reversed_reception = service.reverse_reception(db, actor=actor, reception=reception, authorizer_pin=payload.authorizer_pin)
    return _reception_out(db, reversed_reception)


@router.patch("/admin/receptions/{reception_id}")
def patch_reverse_reception(
    reception_id: int,
    payload: ReceptionReverseIn,
    actor: Actor = Depends(current_admin),
    db: Session = Depends(get_db),
) -> ReceptionOut:
    return _reverse_reception(reception_id, payload, actor, db)


@router.delete("/admin/receptions/{reception_id}")
def delete_reverse_reception(
    reception_id: int,
    payload: ReceptionReverseIn,
    actor: Actor = Depends(current_admin),
    db: Session = Depends(get_db),
) -> ReceptionOut:
    return _reverse_reception(reception_id, payload, actor, db)


# ---------------------------------------------------------------------------
# Cuentas por pagar y pagos.
# ---------------------------------------------------------------------------


@router.get("/admin/payables")
def list_payables(
    store_id: int,
    request: Request,
    status: str | None = None,
    supplier_id: int | None = None,
    overdue: bool | None = None,
    date_from: date | None = Query(None, alias="from"),
    date_to: date | None = Query(None, alias="to"),
    format: str | None = Query(None, description='"csv" exporta el listado como CSV'),
    actor: Actor = Depends(current_admin),
    db: Session = Depends(get_db),
) -> Any:
    del format
    store = admin_store(db, actor, store_id)
    rows = service.list_payables(
        db, store_id=store.id, status=status, supplier_id=supplier_id, overdue=overdue, date_from=date_from, date_to=date_to
    )
    out = [_payable_out(db, r) for r in rows]
    if wants_csv(request):
        return csv_response([r.model_dump(mode="json") for r in out], filename="payables.csv")
    return out


@router.get("/admin/payables/summary")
def payables_summary(
    store_id: int, actor: Actor = Depends(current_admin), db: Session = Depends(get_db)
) -> PayablesSummaryOut:
    """Cabecera de cuentas por pagar (informe de visualización #8). Va ANTES
    de `/admin/payables/{payable_id}`: si no, «summary» se intenta leer como
    id y responde 422."""
    store = admin_store(db, actor, store_id)
    return PayablesSummaryOut(store_id=store.id, **service.payables_summary(db, store_id=store.id))


@router.get("/admin/payables/{payable_id}")
def get_payable(
    payable_id: int, actor: Actor = Depends(current_admin), db: Session = Depends(get_db)
) -> PayableOut:
    """Agregado por `backend-obligaciones` (D-2,
    `features/fase-3-dinero-control/spec.md § 2`, contrato de API mínimo de
    T2): la única forma de leer UNA cuenta por pagar por id ya con
    `invoice_total`/`invoice_discrepancy`. Antes de esta fase sólo existía el
    listado (`GET /admin/payables`)."""
    payable = service.get_payable_or_404(db, organization_id=actor.organization_id, payable_id=payable_id)
    admin_store(db, actor, payable.store_id)
    return _payable_out(db, payable)


@router.post("/admin/payables/{payable_id}/approve")
def approve_payable(
    payable_id: int,
    payload: PayableApproveIn,
    actor: Actor = Depends(current_admin),
    db: Session = Depends(get_db),
) -> PayableOut:
    payable = service.get_payable_or_404(db, organization_id=actor.organization_id, payable_id=payable_id)
    admin_store(db, actor, payable.store_id)
    row = service.approve_payable(
        db, actor=actor, payable=payable, authorizer_pin=payload.authorizer_pin, confirm_discrepancy=payload.confirm_discrepancy
    )
    return _payable_out(db, row)


@router.get("/admin/payables/{payable_id}/payments")
def list_payments(
    payable_id: int,
    request: Request,
    include_voided: bool = Query(True, description="incluir los pagos anulados, marcados como tales"),
    format: str | None = Query(None, description='"csv" exporta el listado como CSV'),
    actor: Actor = Depends(current_admin),
    db: Session = Depends(get_db),
) -> Any:
    """El historial de pagos de una cuenta por pagar.

    Faltaba en el contrato de 2b, y sin él la cuenta por pagar estaba a
    medias: se podía registrar un pago y anular uno por id, pero no VERLOS.
    Un administrador que volvía al día siguiente no sabía qué se había
    pagado, y no podía anular nada porque el `payment_id` sólo había
    existido en la respuesta del `POST` que lo creó.

    Los anulados vienen incluidos y marcados (`voided_at`/`voided_reason`/
    `voided_by_employee_name`): son parte del historial. El saldo lo sigue
    derivando `payable_balance` de los pagos vivos, y es el único que lo
    decide."""
    del format
    payable = service.get_payable_or_404(db, organization_id=actor.organization_id, payable_id=payable_id)
    admin_store(db, actor, payable.store_id)
    rows = service.list_payments(db, payable_id=payable.id, include_voided=include_voided)
    out = [PaymentOut.model_validate(r) for r in rows]
    if wants_csv(request):
        return csv_response([r.model_dump(mode="json") for r in out], filename=f"payable-{payable.id}-payments.csv")
    return out


@router.post("/admin/payables/{payable_id}/payments", status_code=201)
def create_payment(
    payable_id: int,
    payload: PaymentIn,
    request: Request,
    actor: Actor = Depends(current_admin),
    db: Session = Depends(get_db),
) -> PaymentOut:
    payable = service.get_payable_or_404(db, organization_id=actor.organization_id, payable_id=payable_id)
    admin_store(db, actor, payable.store_id)

    def _do() -> tuple[int, dict[str, Any]]:
        payment = service.create_payment(db, actor=actor, payable=payable, payload=payload)
        return 201, PaymentOut.model_validate(payment).model_dump(mode="json")

    status_code, body = _idempotent(
        db, organization_id=actor.organization_id, scope="purchases.payments", request=request, payload=payload, fn=_do
    )
    return PaymentOut.model_validate(body)


@router.post("/admin/payables/{payable_id}/payments/{payment_id}/void")
def void_payment(
    payable_id: int,
    payment_id: int,
    payload: PaymentVoidIn,
    actor: Actor = Depends(current_admin),
    db: Session = Depends(get_db),
) -> PaymentOut:
    payment = service.get_payment_or_404(db, organization_id=actor.organization_id, payment_id=payment_id)
    if payment.payable_id != payable_id:
        raise AppError(code="NOT_FOUND", message="Ese pago no pertenece a esta cuenta por pagar", status=404)
    admin_store(db, actor, payment.store_id)
    row = service.void_payment(db, actor=actor, payment=payment, reason=payload.reason, authorizer_pin=payload.authorizer_pin)
    return PaymentOut.model_validate(row)


# ---------------------------------------------------------------------------
# Recepciones por completar (recibir mercancía desde el POS).
#
# Las rutas de dispositivo (`/device/...` y `/reception-drafts`) NUNCA
# devuelven un costo ni un precio: proveedor, insumo, cantidad en unidad de
# compra, foto, estado, y la plata que el cajero entregó del cajón (que es
# plata del turno, no un costo). Todo detrás del mismo flag `purchases`.
# ---------------------------------------------------------------------------


def _device_store(db: Session, actor: Actor) -> Store:
    store = db.get(Store, actor.store_id)
    if store is None or store.organization_id != actor.organization_id:
        raise AppError(code="DEVICE_NOT_ACTIVATED", message="Activá el dispositivo con el PIN de sede", status=401)
    return store


def _supplier_name(db: Session, supplier_id: int) -> str:
    supplier = db.get(Supplier, supplier_id)
    return supplier.name if supplier is not None else f"Proveedor #{supplier_id}"


def _draft_line_outs(db: Session, draft: ReceptionDraft) -> list[ReceptionDraftAdminLineOut]:
    outs: list[ReceptionDraftAdminLineOut] = []
    for line in service.get_reception_draft_lines(db, draft_id=draft.id):
        ingredient = inventory_hooks.get_ingredient(db, store_id=draft.store_id, ingredient_id=line.ingredient_id)
        outs.append(
            ReceptionDraftAdminLineOut(
                id=line.id,
                ingredient_id=line.ingredient_id,
                ingredient_name=ingredient.name if ingredient is not None else f"Insumo #{line.ingredient_id}",
                quantity=format_qty_base(line.qty_purchase_milli),
                purchase_unit=line.purchase_unit,
                lot_code=line.lot_code,
                expires_at=line.expires_at,
                qty_base=format_qty_base(line.qty_base),
                base_unit=ingredient.base_unit.value if ingredient is not None else "",
            )
        )
    return outs


def _draft_device_out(db: Session, draft: ReceptionDraft) -> ReceptionDraftOut:
    """Lo que ve la tablet: se arma campo por campo (nunca un `model_dump`
    del modelo), para que un campo nuevo no llegue a la tablet sin querer."""
    lines = [
        ReceptionDraftLineOut(
            id=line.id,
            ingredient_id=line.ingredient_id,
            ingredient_name=line.ingredient_name,
            quantity=line.quantity,
            purchase_unit=line.purchase_unit,
            lot_code=line.lot_code,
            expires_at=line.expires_at,
        )
        for line in _draft_line_outs(db, draft)
    ]
    return ReceptionDraftOut(
        id=draft.id,
        supplier_id=draft.supplier_id,
        supplier_name=_supplier_name(db, draft.supplier_id),
        invoice_number=draft.invoice_number,
        no_invoice=draft.no_invoice,
        photo=draft.photo,
        status=draft.status.value,  # type: ignore[arg-type]
        cash_paid_amount=draft.cash_paid_amount,
        created_by_employee_name=draft.created_by_employee_name,
        created_at=draft.created_at,
        business_date=draft.business_date,
        rejected_reason=draft.rejected_reason,
        lines=lines,
    )


def _draft_admin_out(db: Session, draft: ReceptionDraft) -> ReceptionDraftAdminOut:
    return ReceptionDraftAdminOut(
        id=draft.id,
        store_id=draft.store_id,
        supplier_id=draft.supplier_id,
        supplier_name=_supplier_name(db, draft.supplier_id),
        invoice_number=draft.invoice_number,
        no_invoice=draft.no_invoice,
        photo=draft.photo,
        status=draft.status.value,  # type: ignore[arg-type]
        cash_paid_amount=draft.cash_paid_amount,
        cash_movement_id=draft.cash_movement_id,
        created_by_employee_id=draft.created_by_employee_id,
        created_by_employee_name=draft.created_by_employee_name,
        created_at=draft.created_at,
        business_date=draft.business_date,
        waiting_minutes=service.draft_waiting_minutes(draft),
        reception_id=draft.reception_id,
        completed_at=draft.completed_at,
        completed_by_employee_name=draft.completed_by_employee_name,
        rejected_at=draft.rejected_at,
        rejected_reason=draft.rejected_reason,
        rejected_by_employee_name=draft.rejected_by_employee_name,
        lines=_draft_line_outs(db, draft),
    )


@router.get("/device/suppliers")
def list_device_suppliers(
    actor: Actor = Depends(current_device), db: Session = Depends(get_db)
) -> list[DeviceSupplierOut]:
    """Proveedores activos para el selector del POS: `{id, name,
    invoices_required}` y nada más (ni NIT, ni plazo, ni confiabilidad)."""
    store = _device_store(db, actor)
    return [
        DeviceSupplierOut(id=s.id, name=s.name, invoices_required=s.invoices_required)
        for s in service.list_device_suppliers(db, store_id=store.id)
    ]


@router.get("/device/reception-ingredients")
def list_device_reception_ingredients(
    actor: Actor = Depends(current_device), db: Session = Depends(get_db)
) -> list[DeviceReceptionIngredientOut]:
    """Insumos activos para las líneas de una recepción en el POS: nombre y
    unidad de compra. `GET /device/ingredients` (de `inventory`, para la
    merma) no trae la unidad de compra, y la recepción se captura en ella."""
    store = _device_store(db, actor)
    return [
        DeviceReceptionIngredientOut(id=i.id, name=i.name, purchase_unit=i.purchase_unit, base_unit=i.base_unit.value)
        for i in service.list_device_reception_ingredients(db, store_id=store.id)
    ]


@router.get("/device/reception-suggestions")
def get_reception_suggestions(
    supplier_id: int = Query(...),
    actor: Actor = Depends(current_device),
    db: Session = Depends(get_db),
) -> ReceptionSuggestionsOut:
    """Qué se espera que llegue de ese proveedor, para precargar «Recibir
    mercancía»: lo aprobado en Solicitudes o la última compra. Sin precios."""
    store = _device_store(db, actor)
    return ReceptionSuggestionsOut(**service.reception_suggestions(db, store=store, supplier_id=supplier_id))


@router.post("/reception-drafts", status_code=201)
def create_reception_draft(
    payload: ReceptionDraftIn,
    request: Request,
    actor: Actor = Depends(current_operator),
    db: Session = Depends(get_db),
) -> ReceptionDraftOut:
    """Quien está en el turno registra lo que llegó (sin precios). Si pagó
    de contado desde el cajón, sale como egreso del turno abierto, en la
    misma transacción. Idempotente (`Idempotency-Key`)."""
    store = _device_store(db, actor)

    def _do() -> tuple[int, dict[str, Any]]:
        draft = service.create_reception_draft(db, actor=actor, store=store, payload=payload)
        return 201, _draft_device_out(db, draft).model_dump(mode="json")

    status_code, body = _idempotent(
        db, organization_id=store.organization_id, scope="purchases.reception_drafts", request=request, payload=payload, fn=_do
    )
    return ReceptionDraftOut.model_validate(body)


@router.get("/reception-drafts")
def list_my_reception_drafts(
    actor: Actor = Depends(current_device), db: Session = Depends(get_db)
) -> list[ReceptionDraftOut]:
    """«Recibido hoy» del POS: las recepciones registradas en la sede en el
    día operativo en curso, con su estado. Sin montos de costo."""
    store = _device_store(db, actor)
    rows = service.list_reception_drafts(db, store_id=store.id, business_date=service.today_business_date(store))
    return [_draft_device_out(db, r) for r in rows]


@router.get("/admin/reception-drafts")
def list_reception_drafts(
    store_id: int,
    status: str | None = Query(None, description='"pending", "completed" o "rejected"; sin filtro, todas'),
    actor: Actor = Depends(current_admin),
    db: Session = Depends(get_db),
) -> list[ReceptionDraftAdminOut]:
    store = admin_store(db, actor, store_id)
    if status is not None and status not in ("pending", "completed", "rejected"):
        raise AppError(code="VALIDATION_ERROR", message='status: usá "pending", "completed" o "rejected"', status=400)
    rows = service.list_reception_drafts(db, store_id=store.id, status=status)
    return [_draft_admin_out(db, r) for r in rows]


@router.get("/admin/reception-drafts/{draft_id}")
def get_reception_draft(
    draft_id: int, actor: Actor = Depends(current_admin), db: Session = Depends(get_db)
) -> ReceptionDraftAdminOut:
    draft = service.get_reception_draft_or_404(db, organization_id=actor.organization_id, draft_id=draft_id)
    admin_store(db, actor, draft.store_id)
    return _draft_admin_out(db, draft)


@router.post("/admin/reception-drafts/{draft_id}/complete", status_code=201)
def complete_reception_draft(
    draft_id: int,
    payload: ReceptionDraftCompleteIn,
    request: Request,
    actor: Actor = Depends(current_admin),
    db: Session = Depends(get_db),
) -> ReceptionOut:
    """Completa la recepción del POS con precios: crea la recepción por el
    camino de siempre (lotes, costo, cuenta por pagar) y deja el borrador
    `completed` con el id de la recepción. Responde la recepción creada."""
    draft = service.get_reception_draft_or_404(db, organization_id=actor.organization_id, draft_id=draft_id)
    store = admin_store(db, actor, draft.store_id)

    def _do() -> tuple[int, dict[str, Any]]:
        reception = service.complete_reception_draft(db, actor=actor, store=store, draft=draft, payload=payload)
        return 201, _reception_out(db, reception).model_dump(mode="json")

    status_code, body = _idempotent(
        db,
        organization_id=actor.organization_id,
        scope=f"purchases.reception_drafts.{draft.id}.complete",
        request=request,
        payload=payload,
        fn=_do,
    )
    return ReceptionOut.model_validate(body)


@router.post("/admin/reception-drafts/{draft_id}/reject")
def reject_reception_draft(
    draft_id: int,
    payload: ReceptionDraftRejectIn,
    actor: Actor = Depends(current_admin),
    db: Session = Depends(get_db),
) -> ReceptionDraftAdminOut:
    draft = service.get_reception_draft_or_404(db, organization_id=actor.organization_id, draft_id=draft_id)
    admin_store(db, actor, draft.store_id)
    row = service.reject_reception_draft(db, actor=actor, draft=draft, reason=payload.reason)
    return _draft_admin_out(db, row)
