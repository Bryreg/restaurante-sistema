"""**Cuadres** — la pantalla de administrador de Caja › Dinero, como la del café
(decisión del dueño, 2026-09-29).

Una tarjeta por turno con todo lo que el dueño viene a mirar, calculado acá
una sola vez (la pantalla no suma ni resta):

- la línea de números: con cuánto abrió, ventas en efectivo y tarjeta, y
  cómo cerró;
- los **cuadres** —Inicial, Relevo, Arqueo, Cierre—, cada uno «contó $X /
  debía $Y» con su diferencia y su foto, y su **desglose**: con lo que
  empezó + ventas en efectivo + otros ingresos − salidas una por una −
  retiros − consignado = debería haber; contó; diferencia; la base de
  respaldo aparte (no cuenta);
- quién estuvo (entrada → salida);
- **Movimientos de caja**: cada entrada y salida del cajón con su concepto,
  causa, proveedor, hora, foto y nota;
- al pie, el **desempeño por responsable**.

Nada de esto es una matemática nueva: el esperado sale de
`service.compute_breakdown` (o del desglose congelado del relevo, que nunca
se recalcula), el de apertura de `Shift.opening_expected` / el conteo
sellado, y lo que falta consignar de `app.banking.hooks`.
"""

from __future__ import annotations

from datetime import date, datetime
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.banking import hooks as banking_hooks
from app.core import features, tz
from app.shifts import hooks, reserve, service
from app.shifts.models import (
    BusinessDay,
    CashMovement,
    CashMovementKind,
    CashPickup,
    HandoverKind,
    Shift,
    ShiftHandover,
    ShiftRoster,
    ShiftStatus,
)
from app.stores.models import Store

STATUS_FILTERS = ("all", "closed", "open")

_KIND_LABEL = {
    "opening": "Inicial",
    "handover": "Relevo",
    "spot_check": "Arqueo",
    "close": "Cierre",
}


def _value(v: object) -> str:
    return str(getattr(v, "value", v))


def _shifts_in_range(
    db: Session, *, store: Store, date_from: date | None, date_to: date | None, status: str
) -> list[tuple[Shift, date]]:
    stmt = (
        select(Shift, BusinessDay.business_date)
        .join(BusinessDay, BusinessDay.id == Shift.business_day_id)
        .where(Shift.store_id == store.id)
    )
    if date_from is not None:
        stmt = stmt.where(BusinessDay.business_date >= date_from)
    if date_to is not None:
        stmt = stmt.where(BusinessDay.business_date <= date_to)
    if status == "closed":
        stmt = stmt.where(Shift.status == ShiftStatus.CLOSED)
    elif status == "open":
        stmt = stmt.where(Shift.status == ShiftStatus.OPEN)
    stmt = stmt.order_by(Shift.opened_at.desc(), Shift.id.desc())
    return [(shift, business_date) for shift, business_date in db.execute(stmt).all()]


def _reserve_apart(db: Session, shift: Shift) -> int | None:
    """La base de respaldo, que vive APARTE del cajón y no entra a ninguna
    cuenta: se muestra al pie del desglose para que nadie la sume. `None`
    si la sede no tiene base de respaldo (nunca `0`)."""
    if shift.cash_reserve:
        return int(shift.cash_reserve)
    if features.is_enabled(db, shift.organization_id, shift.store_id, reserve.FEATURE):
        amount = reserve.reserve_amount(db, shift.store_id)
        return int(amount) if amount else None
    return None


def _cash_outflows(movements: list[CashMovement], until: datetime | None) -> list[dict[str, Any]]:
    """Las salidas de efectivo (egresos del cajón), una por una, hasta el
    momento del cuadre: la sublista de «− Salidas de efectivo»."""
    out: list[dict[str, Any]] = []
    for m in movements:
        if _value(m.kind) != CashMovementKind.EXPENSE.value:
            continue
        if until is not None and m.at > until:
            continue
        out.append(
            {
                "at": m.at,
                "concept": service._movement_cause_label(m.cause),
                "note": m.note,
                "amount": m.amount,
            }
        )
    return out


def _desglose_from_breakdown(
    breakdown: dict[str, Any], *, counted: int | None, outflows: list[dict[str, Any]], reserve_apart: int | None
) -> dict[str, Any]:
    expected = breakdown.get("expected")
    difference = breakdown.get("difference")
    if difference is None and counted is not None and expected is not None:
        difference = counted - expected
    return {
        "base": breakdown.get("base"),
        "cash_sales": breakdown.get("cash_sales"),
        "incomes": breakdown.get("incomes"),
        "expenses": breakdown.get("expenses"),
        "expense_lines": outflows,
        "pickups": breakdown.get("pickups"),
        "deposits": breakdown.get("deposits"),
        "reserve_loan": breakdown.get("reserve_loan"),
        "expected": expected,
        "counted": counted,
        "difference": difference,
        "reserve_apart": reserve_apart,
    }


def _opening_cuadre(db: Session, shift: Shift) -> dict[str, Any]:
    """«Inicial: contó $X / debía $Y». Lo que debía haber sale de lo que el
    turno guardó al abrir: la apertura «igual al café» (`opening_expected`),
    el conteo sellado por sobres, o la base fija más los días marcados."""
    carried = hooks.carried_into(db, shift.id)
    count = service.opening_count_of_shift(db, shift.id)
    if shift.opening_expected is not None:
        expected: int | None = shift.opening_expected
    elif count is not None:
        expected = count.expected_total
    else:
        expected = shift.opening_fixed_base + sum(carried.values())
    counted = shift.opening_cash_total
    days = []
    if carried:
        dates = dict(
            db.execute(
                select(Shift.id, BusinessDay.business_date)
                .join(BusinessDay, BusinessDay.id == Shift.business_day_id)
                .where(Shift.id.in_(list(carried)))
            ).all()
        )
        days = [
            {"shift_id": sid, "business_date": dates.get(sid), "amount": amount}
            for sid, amount in sorted(carried.items(), key=lambda kv: (dates.get(kv[0]) or date.min, kv[0]))
        ]
    difference = counted - expected if expected is not None else None
    return {
        "kind": "opening",
        "label": _KIND_LABEL["opening"],
        "at": shift.opened_at,
        "employee_name": shift.opened_by_employee_name,
        "employee_id": shift.opened_by_employee_id,
        "counted": counted,
        "expected": expected,
        "difference": difference,
        "photo": None,
        "cause": _value(shift.opening_cause) if shift.opening_cause else None,
        "note": shift.opening_note,
        "desglose": {
            "fixed_base": shift.opening_fixed_base,
            "carried_days": days,
            "expected": expected,
            "counted": counted,
            "difference": difference,
            "surplus_consignable": max(0, difference) if difference is not None else None,
            "shortage": max(0, -difference) if difference is not None else None,
        },
    }


def _handover_cuadre(
    h: ShiftHandover, movements: list[CashMovement], reserve_apart: int | None
) -> dict[str, Any]:
    kind = _value(h.kind)
    # El desglose del relevo es el CONGELADO en el momento del relevo: no se
    # recalcula nunca (un ajuste de apertura posterior no lo reescribe).
    frozen = dict(h.breakdown or {})
    counted = int(frozen.get("counted", h.counted_cash))
    desglose = _desglose_from_breakdown(
        frozen, counted=counted, outflows=_cash_outflows(movements, h.at), reserve_apart=reserve_apart
    )
    return {
        "kind": "handover" if kind == HandoverKind.HANDOVER.value else "spot_check",
        "label": _KIND_LABEL["handover" if kind == HandoverKind.HANDOVER.value else "spot_check"],
        "at": h.at,
        "employee_name": h.from_responsible_name,
        "employee_id": h.from_responsible_id,
        "new_responsible_name": h.new_responsible_name,
        "counted": counted,
        "expected": desglose["expected"],
        "difference": desglose["difference"],
        "photo": h.photo,
        "cause": None,
        "note": None,
        "desglose": desglose,
    }


def _close_cuadre(
    db: Session, shift: Shift, movements: list[CashMovement], reserve_apart: int | None
) -> dict[str, Any] | None:
    if shift.status != ShiftStatus.CLOSED or shift.closed_at is None:
        return None
    count = service._get_active_close_count(db, shift.id)
    breakdown = service.compute_breakdown(db, shift, as_of=shift.closed_at)
    # El esperado y la diferencia son los que el cierre (o un ajuste de
    # apertura) dejó escritos en el turno: son los que valen.
    breakdown["expected"] = shift.expected_cash
    breakdown["difference"] = None if shift.closed_without_count else shift.difference
    counted = None if shift.closed_without_count else shift.counted_cash
    desglose = _desglose_from_breakdown(
        breakdown, counted=counted, outflows=_cash_outflows(movements, shift.closed_at), reserve_apart=reserve_apart
    )
    return {
        "kind": "close",
        "label": _KIND_LABEL["close"],
        "at": shift.closed_at,
        "employee_name": shift.closed_by_employee_name,
        "employee_id": shift.cash_responsible_id,
        "counted": counted,
        "expected": shift.expected_cash,
        "difference": desglose["difference"],
        "photo": count.photo if count is not None else None,
        "cause": _value(shift.close_cause) if shift.close_cause else None,
        "note": shift.close_note,
        "without_count": bool(shift.closed_without_count),
        "desglose": desglose,
    }


def cash_movements(db: Session, shift: Shift) -> list[dict[str, Any]]:
    """«Movimientos de caja» del turno: cada entrada (↑) y salida (↓) del
    cajón, en orden, con concepto, causa tipada, proveedor (pagos a
    proveedor), hora, foto, nota y el monto con signo. Reusa la cronología
    del turno (`service.build_timeline`), que ya trae nota, foto y
    proveedor; suma las consignaciones hechas desde el cajón."""
    out: list[dict[str, Any]] = []
    for e in service.build_timeline(db, shift):
        data = e.get("data") or {}
        kind = e["kind"]
        if kind == "movement":
            incoming = _value(data.get("kind")) == CashMovementKind.INCOME.value
            concept = data.get("cause_label") or ""
            out.append(
                {
                    "at": e["at"],
                    "direction": "in" if incoming else "out",
                    "kind": "movement",
                    "concept": concept,
                    "cause": _value(data.get("cause")),
                    "supplier_name": data.get("supplier_name"),
                    "employee_name": e.get("employee_name"),
                    "photo": data.get("photo"),
                    "note": data.get("note"),
                    "amount": int(data["amount"]) if incoming else -int(data["amount"]),
                }
            )
        elif kind == "pickup" and not data.get("reversed"):
            out.append(
                {
                    "at": e["at"],
                    "direction": "out",
                    "kind": "pickup",
                    "concept": "Retiro",
                    "cause": None,
                    "supplier_name": None,
                    "employee_name": e.get("employee_name"),
                    "photo": data.get("photo"),
                    "note": data.get("note"),
                    "amount": -int(data["amount"]),
                }
            )
        elif kind in ("reserve_take", "reserve_return"):
            take = kind == "reserve_take"
            out.append(
                {
                    "at": e["at"],
                    "direction": "in" if take else "out",
                    "kind": kind,
                    "concept": "Préstamo de la base de respaldo" if take else "Devolución a la base de respaldo",
                    "cause": None,
                    "supplier_name": None,
                    "employee_name": e.get("employee_name"),
                    "photo": None,
                    "note": None,
                    "amount": int(data["amount"]) if take else -int(data["amount"]),
                }
            )
    for d in banking_hooks.drawer_deposit_rows(db, shift.id):
        out.append(
            {
                "at": d["at"],
                "direction": "out",
                "kind": "deposit",
                "concept": "Consignación desde el cajón" + (f" · {d['bank_name']}" if d.get("bank_name") else ""),
                "cause": None,
                "supplier_name": None,
                "employee_name": d.get("employee_name"),
                "photo": d.get("photo"),
                "note": d.get("note"),
                "amount": -int(d["amount"]),  # type: ignore[call-overload]
            }
        )
    out.sort(key=lambda m: m["at"])
    return out


def shift_card(db: Session, shift: Shift, business_date: date, store: Store) -> dict[str, Any]:
    movements = list(
        db.execute(select(CashMovement).where(CashMovement.shift_id == shift.id).order_by(CashMovement.at)).scalars()
    )
    reserve_apart = _reserve_apart(db, shift)
    cuadres: list[dict[str, Any]] = [_opening_cuadre(db, shift)]
    handovers = db.execute(
        select(ShiftHandover).where(ShiftHandover.shift_id == shift.id).order_by(ShiftHandover.at)
    ).scalars()
    cuadres.extend(_handover_cuadre(h, movements, reserve_apart) for h in handovers)
    close = _close_cuadre(db, shift, movements, reserve_apart)
    if close is not None:
        cuadres.append(close)

    totals = hooks.get_sales_totals(db, shift.id)
    people = [
        {"employee_id": r.employee_id, "name": r.employee_name, "in_at": r.in_at, "out_at": r.out_at}
        for r in db.execute(
            select(ShiftRoster).where(ShiftRoster.shift_id == shift.id).order_by(ShiftRoster.in_at)
        ).scalars()
    ]
    is_open = shift.status == ShiftStatus.OPEN
    return {
        "shift_id": shift.id,
        "business_date": business_date,
        "status": _value(shift.status),
        "opened_at": shift.opened_at,
        "closed_at": shift.closed_at,
        "opened_by": shift.opened_by_employee_name,
        "cash_responsible": {"id": shift.cash_responsible_id, "name": shift.cash_responsible_name},
        "is_stale": service.is_shift_stale(db, shift, store) if is_open else False,
        "opening_mode": "envelopes" if shift.opening_mode == service.ENVELOPES else "fixed_base",
        "opening_cash_total": shift.opening_cash_total,
        # «Ventas $X» de la tarjeta: la suma la hace el servidor, no la pantalla.
        "sales_total": totals.cash + totals.card + totals.transfer + totals.other,
        "sales_cash": totals.cash,
        "sales_card": totals.card,
        "sales_transfer": totals.transfer,
        "sales_other": totals.other,
        # El esperado vivo mientras está abierto (la única fórmula); el del
        # cierre, cuando cerró.
        "expected_cash": service.compute_breakdown(db, shift)["expected"] if is_open else shift.expected_cash,
        "counted_cash": shift.counted_cash,
        "difference": shift.difference,
        "closed_without_count": bool(shift.closed_without_count),
        "to_deposit": shift.to_deposit,
        "close_photo": close["photo"] if close is not None else None,
        "cuadres": cuadres,
        "people": people,
        "movements": cash_movements(db, shift),
        "adjustments": len(shift.adjustments or []),
    }


def performance(cards: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """«Desempeño por responsable»: por persona, cuántos cuadres hizo,
    cuántos con diferencia, la suma con signo y la peor diferencia (la de
    mayor valor absoluto, con su signo). Sólo cuentan los cuadres con
    conteo (un cierre administrativo no cuadró ni dejó de cuadrar)."""
    people: dict[Any, dict[str, Any]] = {}
    for card in cards:
        for c in card["cuadres"]:
            if c.get("difference") is None or c.get("employee_name") is None:
                continue
            key = c.get("employee_id") or c["employee_name"]
            p = people.setdefault(
                key,
                {
                    "employee_id": c.get("employee_id"),
                    "name": c["employee_name"],
                    "cuadres": 0,
                    "with_difference": 0,
                    "diff_total": 0,
                    "worst_difference": 0,
                },
            )
            d = int(c["difference"])
            p["cuadres"] += 1
            p["with_difference"] += 1 if d != 0 else 0
            p["diff_total"] += d
            if abs(d) > abs(p["worst_difference"]):
                p["worst_difference"] = d
    return sorted(people.values(), key=lambda p: (p["diff_total"], p["name"]))


def list_cuadres(
    db: Session, *, store: Store, date_from: date | None, date_to: date | None, status: str
) -> dict[str, Any]:
    cards = [shift_card(db, shift, bd, store) for shift, bd in _shifts_in_range(
        db, store=store, date_from=date_from, date_to=date_to, status=status
    )]
    return {"shifts": cards, "performance": performance(cards)}


# ---------------------------------------------------------------------------
# Descargas (CSV `;` + BOM, encabezados en español)
# ---------------------------------------------------------------------------


def _local(value: datetime | None) -> str:
    """Hora de Bogotá, como la lee el dueño en la planilla."""
    return tz.to_bogota(value).strftime("%Y-%m-%d %H:%M") if value is not None else ""


def cuadres_csv_rows(cards: list[dict[str, Any]]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for card in cards:
        for c in card["cuadres"]:
            rows.append(
                {
                    "Fecha": card["business_date"].isoformat(),
                    "Turno": card["shift_id"],
                    "Estado": {"open": "Abierto", "closed": "Cerrado", "cancelled": "Cancelado"}.get(
                        card["status"], card["status"]
                    ),
                    "Cuadre": c["label"],
                    "Hora": _local(c.get("at")),
                    "Responsable": c.get("employee_name") or "",
                    "Contó": "" if c.get("counted") is None else c["counted"],
                    "Debía": "" if c.get("expected") is None else c["expected"],
                    "Diferencia": "" if c.get("difference") is None else c["difference"],
                    "Causa": c.get("cause") or "",
                    "Nota": c.get("note") or "",
                    "Foto": "Sí" if c.get("photo") else "No",
                }
            )
    return rows


def movements_csv_rows(cards: list[dict[str, Any]]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for card in cards:
        for m in card["movements"]:
            rows.append(
                {
                    "Fecha": card["business_date"].isoformat(),
                    "Turno": card["shift_id"],
                    "Hora": _local(m["at"]),
                    "Tipo": "Entrada" if m["direction"] == "in" else "Salida",
                    "Concepto": m["concept"],
                    "Proveedor": m.get("supplier_name") or "",
                    "Quién": m.get("employee_name") or "",
                    "Monto": m["amount"],
                    "Nota": m.get("note") or "",
                    "Foto": "Sí" if m.get("photo") else "No",
                }
            )
    return rows


def performance_csv_rows(perf: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [
        {
            "Responsable": p["name"],
            "Cuadres": p["cuadres"],
            "Con diferencia": p["with_difference"],
            "Diferencia total": p["diff_total"],
            "Peor diferencia": p["worst_difference"],
        }
        for p in perf
    ]
