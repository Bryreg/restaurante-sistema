"""Lógica de `labels`: imprimir, leer por código, acabar o botar.

Reglas:
- **El «usar antes de» lo calcula el servidor** y queda congelado:
  - recibido → el vencimiento del lote del proveedor;
  - abierto → hoy + los días que dura abierto el insumo, sin pasarse del
    vencimiento del lote (lo que llegue primero);
  - producido → el vencimiento del lote producido (la vida útil de la
    preparación).
  Quien imprime puede poner una fecha MÁS CORTA, nunca más larga. Si no hay
  regla (insumo sin días de abierto y sin lote con fecha), la fecha la pone
  quien imprime: `400 LABEL_USE_BY_REQUIRED` hasta que la ponga.
- Imprimir no mueve inventario. Botar sí: es una merma
  (`app.inventory.service.register_waste`), con el PIN del responsable, como
  toda merma.
- Una etiqueta se cierra una sola vez (`409 LABEL_ALREADY_CLOSED`).
- Todo se valida antes de escribir (`get_db` comitea también ante un
  `AppError`).
"""

from __future__ import annotations

import secrets
from datetime import date, datetime, timedelta

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.auth.deps import Actor
from app.core import clock, features, tz
from app.core.errors import AppError, ConflictError, NotFoundError
from app.core.quantity import format_qty_base
from app.inventory.models import Ingredient, StockBatch, Waste
from app.inventory.units import entry_spec
from app.labels.models import FoodLabel, LabelKind, LabelSettings, LabelStatus, UseBySource
from app.labels.schemas import (
    LabelBoardOut,
    LabelCreateIn,
    LabelFinishIn,
    LabelOut,
    LabelSettingsIn,
    LabelSettingsOut,
    LabelSourcesOut,
    OpenableBatchOut,
    OpenableIngredientOut,
    ProducedSourceOut,
    ReceivedSourceOut,
)
from app.purchases.models import ReceptionDraft, ReceptionDraftLine, ReceptionDraftStatus
from app.recipes.models import Preparation, PrepBatch
from app.stores.models import Store

#: Sin 0/O, 1/I/L: se lee y se teclea sin dudar.
_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ"
_CODE_LEN = 8
#: Lo recibido y lo producido de estos últimos días se ofrece para etiquetar.
SOURCE_DAYS = 3
#: Una fecha manual no puede ir más allá de esto (dos años).
_MAX_MANUAL_DAYS = 730
_PREP_UNIT_LABEL = {"g": "g", "ml": "ml", "unit": "und"}


def _today(store: Store) -> date:
    return tz.today_business_date(store.cutoff_hour)


def normalize_code(raw: str) -> str:
    """Lo que llega del lector o del teclado → el código guardado. Acepta
    minúsculas, espacios, guiones y el prefijo `ET` que lleva el QR."""
    text = "".join(ch for ch in raw.upper() if ch.isalnum())
    if text.startswith("ET") and len(text) == _CODE_LEN + 2:
        text = text[2:]
    return text


def _new_code(db: Session) -> str:
    while True:
        code = "".join(secrets.choice(_ALPHABET) for _ in range(_CODE_LEN))
        if db.execute(select(FoodLabel.id).where(FoodLabel.code == code)).first() is None:
            return code


def _state(use_by: date | None, today: date) -> tuple[int | None, str]:
    if use_by is None:
        return None, "no_date"
    days = (use_by - today).days
    if days < 0:
        return days, "expired"
    if days == 0:
        return days, "today"
    if days == 1:
        return days, "tomorrow"
    return days, "ok"


def _waste_units(db: Session, rows: list[FoodLabel]) -> dict[int, str]:
    ing_ids = {r.ingredient_id for r in rows if r.ingredient_id is not None}
    prep_ids = {r.preparation_id for r in rows if r.preparation_id is not None}
    out: dict[int, str] = {}
    ingredients = (
        {i.id: i for i in db.execute(select(Ingredient).where(Ingredient.id.in_(ing_ids))).scalars()}
        if ing_ids
        else {}
    )
    preps = (
        {p.id: p for p in db.execute(select(Preparation).where(Preparation.id.in_(prep_ids))).scalars()}
        if prep_ids
        else {}
    )
    for r in rows:
        if r.ingredient_id is not None and r.ingredient_id in ingredients:
            out[r.id] = entry_spec(ingredients[r.ingredient_id]).unit
        elif r.preparation_id is not None and r.preparation_id in preps:
            out[r.id] = _PREP_UNIT_LABEL.get(preps[r.preparation_id].standard_yield_unit, "und")
        else:
            out[r.id] = "und"
    return out


def labels_out(db: Session, rows: list[FoodLabel], *, today: date) -> list[LabelOut]:
    units = _waste_units(db, rows)
    result: list[LabelOut] = []
    for r in rows:
        days_left, state = _state(r.use_by, today)
        result.append(
            LabelOut(
                id=r.id,
                code=r.code,
                kind=r.kind.value,  # type: ignore[arg-type]
                ingredient_id=r.ingredient_id,
                preparation_id=r.preparation_id,
                stock_batch_id=r.stock_batch_id,
                prep_batch_id=r.prep_batch_id,
                reception_draft_line_id=r.reception_draft_line_id,
                item_name=r.item_name,
                lot_code=r.lot_code,
                qty_text=r.qty_text,
                note=r.note,
                made_at=r.made_at,
                business_date=r.business_date,
                use_by=r.use_by,
                use_by_source=r.use_by_source.value if r.use_by_source is not None else None,  # type: ignore[arg-type]
                employee_name=r.employee_name,
                status=r.status.value,  # type: ignore[arg-type]
                closed_at=r.closed_at,
                closed_by_employee_name=r.closed_by_employee_name,
                waste_id=r.waste_id,
                print_count=r.print_count,
                days_left=days_left,
                state=state,  # type: ignore[arg-type]
                waste_unit=units[r.id],
            )
        )
    return result


# ---------------------------------------------------------------------------
# El «usar antes de».
# ---------------------------------------------------------------------------


def _fefo_batch(db: Session, *, store_id: int, ingredient_id: int) -> StockBatch | None:
    """El lote que se está usando: el próximo a vencer con saldo, el mismo
    orden de `app.inventory.hooks.consume_lots_fefo` (sin fecha al final)."""
    stmt = (
        select(StockBatch)
        .where(
            StockBatch.store_id == store_id,
            StockBatch.ingredient_id == ingredient_id,
            StockBatch.reversed_at.is_(None),
            StockBatch.qty_remaining > 0,
        )
        .order_by(StockBatch.expires_at.is_(None), StockBatch.expires_at.asc(), StockBatch.received_at.asc())
    )
    return db.execute(stmt).scalars().first()


def opened_use_by(
    ingredient: Ingredient, batch: StockBatch | None, *, today: date
) -> tuple[date | None, UseBySource | None]:
    """Lo que llegue primero: los días que dura abierto o el vencimiento del
    lote. `(None, None)` si no hay ninguna de las dos reglas."""
    candidates: list[tuple[date, UseBySource]] = []
    if ingredient.opened_shelf_life_days is not None:
        candidates.append((today + timedelta(days=ingredient.opened_shelf_life_days), UseBySource.OPENED_SHELF_LIFE))
    if batch is not None and batch.expires_at is not None:
        candidates.append((batch.expires_at, UseBySource.SUPPLIER))
    if not candidates:
        return None, None
    return min(candidates, key=lambda c: c[0])


def _apply_manual(
    computed: date | None, source: UseBySource | None, manual: date | None, *, today: date, required: bool
) -> tuple[date | None, UseBySource | None]:
    if manual is None:
        if computed is None and required:
            raise AppError(
                "LABEL_USE_BY_REQUIRED",
                "Este producto no tiene regla de vencimiento: elegí la fecha «usar antes de». "
                "Para no tener que elegirla cada vez, poné cuántos días dura abierto en "
                "Inventario › Insumos (o la vida útil de la preparación).",
            )
        return computed, source
    if manual < today:
        raise AppError("VALIDATION_ERROR", "use_by: la fecha «usar antes de» no puede ser de un día que ya pasó")
    if manual > today + timedelta(days=_MAX_MANUAL_DAYS):
        raise AppError("VALIDATION_ERROR", "use_by: elegí una fecha dentro de los próximos dos años")
    if computed is not None and manual > computed:
        raise AppError(
            "LABEL_USE_BY_TOO_LATE",
            f"No puede durar más de lo que dice la regla: vence el {computed.isoformat()}. "
            "Podés poner una fecha más corta, nunca más larga.",
        )
    if computed is not None and manual == computed:
        return computed, source
    return manual, UseBySource.MANUAL


# ---------------------------------------------------------------------------
# Imprimir.
# ---------------------------------------------------------------------------


def create_labels(db: Session, *, store: Store, actor: Actor, data: LabelCreateIn) -> list[FoodLabel]:
    if actor.employee_id is None or not actor.employee_name:
        raise AppError("IDENTIFY_REQUIRED", "Identificate con tu PIN para imprimir etiquetas", status=401)
    today = _today(store)
    kind = LabelKind(data.kind)

    ingredient_id: int | None = None
    preparation_id: int | None = None
    stock_batch_id: int | None = None
    prep_batch_id: int | None = None
    draft_line_id: int | None = None
    lot_code: str | None = None
    item_name: str
    use_by: date | None
    source: UseBySource | None

    if kind is LabelKind.RECEIVED:
        if (data.stock_batch_id is None) == (data.reception_draft_line_id is None):
            raise AppError("VALIDATION_ERROR", "Elegí qué llegó: un lote recibido o un renglón de lo recibido en la tablet")
        if data.reception_draft_line_id is not None:
            line = db.get(ReceptionDraftLine, data.reception_draft_line_id)
            draft = db.get(ReceptionDraft, line.draft_id) if line is not None else None
            if line is None or draft is None or draft.store_id != store.id:
                raise NotFoundError("Ese renglón de la recepción no existe")
            if draft.status is ReceptionDraftStatus.REJECTED:
                raise ConflictError("Esa recepción se rechazó: no hay nada que etiquetar", code="RECEPTION_REJECTED")
            ingredient = db.get(Ingredient, line.ingredient_id)
            assert ingredient is not None
            draft_line_id, lot_code, computed = line.id, line.lot_code, line.expires_at
        else:
            batch = db.get(StockBatch, data.stock_batch_id)
            if batch is None or batch.store_id != store.id or batch.reversed_at is not None:
                raise NotFoundError("Ese lote no existe o su recepción se reversó")
            ingredient = db.get(Ingredient, batch.ingredient_id)
            assert ingredient is not None
            stock_batch_id, lot_code, computed = batch.id, batch.lot_code, batch.expires_at
        ingredient_id, item_name = ingredient.id, ingredient.name
        use_by, source = _apply_manual(
            computed, UseBySource.SUPPLIER if computed is not None else None, data.use_by, today=today, required=False
        )
    elif kind is LabelKind.OPENED:
        batch_opt: StockBatch | None = None
        if data.stock_batch_id is not None:
            batch_opt = db.get(StockBatch, data.stock_batch_id)
            if batch_opt is None or batch_opt.store_id != store.id or batch_opt.reversed_at is not None:
                raise NotFoundError("Ese lote no existe o su recepción se reversó")
            if data.ingredient_id is not None and data.ingredient_id != batch_opt.ingredient_id:
                raise AppError("VALIDATION_ERROR", "El lote elegido es de otro insumo: recargá la pantalla")
            target_id = batch_opt.ingredient_id
        elif data.ingredient_id is not None:
            target_id = data.ingredient_id
        else:
            raise AppError("VALIDATION_ERROR", "ingredient_id: elegí qué insumo abriste")
        ingredient_opt = db.get(Ingredient, target_id)
        if ingredient_opt is None or ingredient_opt.store_id != store.id or not ingredient_opt.active:
            raise NotFoundError("El insumo no existe")
        if batch_opt is None:
            batch_opt = _fefo_batch(db, store_id=store.id, ingredient_id=ingredient_opt.id)
        computed, computed_source = opened_use_by(ingredient_opt, batch_opt, today=today)
        use_by, source = _apply_manual(computed, computed_source, data.use_by, today=today, required=True)
        ingredient_id, item_name = ingredient_opt.id, ingredient_opt.name
        if batch_opt is not None:
            stock_batch_id, lot_code = batch_opt.id, batch_opt.lot_code
    else:
        if data.prep_batch_id is None:
            raise AppError("VALIDATION_ERROR", "prep_batch_id: elegí qué producción vas a etiquetar")
        prep_batch = db.get(PrepBatch, data.prep_batch_id)
        if prep_batch is None or prep_batch.store_id != store.id:
            raise NotFoundError("Esa producción no existe")
        preparation = db.get(Preparation, prep_batch.preparation_id)
        assert preparation is not None
        computed = prep_batch.expiry_date
        use_by, source = _apply_manual(
            computed,
            UseBySource.PREP_SHELF_LIFE if computed is not None else None,
            data.use_by,
            today=today,
            required=True,
        )
        preparation_id, prep_batch_id, item_name = preparation.id, prep_batch.id, preparation.name
        lot_code = f"P{prep_batch.id}"

    qty_text = data.qty_text.strip() if data.qty_text and data.qty_text.strip() else None
    note = data.note.strip() if data.note and data.note.strip() else None
    now = clock.now_utc()
    business_date = tz.business_date_for(now, store.cutoff_hour)

    rows: list[FoodLabel] = []
    for _ in range(data.copies):
        row = FoodLabel(
            organization_id=store.organization_id,
            store_id=store.id,
            code=_new_code(db),
            kind=kind,
            ingredient_id=ingredient_id,
            preparation_id=preparation_id,
            stock_batch_id=stock_batch_id,
            prep_batch_id=prep_batch_id,
            reception_draft_line_id=draft_line_id,
            item_name=item_name,
            lot_code=lot_code,
            qty_text=qty_text,
            note=note,
            made_at=now,
            business_date=business_date,
            use_by=use_by,
            use_by_source=source,
            employee_id=actor.employee_id,
            employee_name=actor.employee_name,
            status=LabelStatus.ACTIVE,
            print_count=1,
            last_printed_at=now,
        )
        db.add(row)
        db.flush()
        rows.append(row)
    return rows


def get_label(db: Session, *, store: Store, code: str) -> FoodLabel:
    normalized = normalize_code(code)
    row = db.execute(
        select(FoodLabel).where(FoodLabel.store_id == store.id, FoodLabel.code == normalized)
    ).scalar_one_or_none()
    if row is None:
        raise NotFoundError("No encontramos esa etiqueta en esta sede: revisá el código")
    return row


def reprint(db: Session, *, store: Store, code: str) -> FoodLabel:
    row = get_label(db, store=store, code=code)
    if row.status is not LabelStatus.ACTIVE:
        raise ConflictError("Esa etiqueta ya se cerró: imprimí una nueva", code="LABEL_ALREADY_CLOSED")
    row.print_count += 1
    row.last_printed_at = clock.now_utc()
    db.flush()
    return row


# ---------------------------------------------------------------------------
# Se acabó / se botó.
# ---------------------------------------------------------------------------


def finish(db: Session, *, store: Store, actor: Actor, code: str, data: LabelFinishIn) -> tuple[FoodLabel, Waste | None]:
    if actor.employee_id is None or not actor.employee_name:
        raise AppError("IDENTIFY_REQUIRED", "Identificate con tu PIN", status=401)
    row = get_label(db, store=store, code=code)
    if row.status is not LabelStatus.ACTIVE:
        raise ConflictError(
            f"Esa etiqueta ya se cerró ({'se acabó' if row.status is LabelStatus.USED_UP else 'se botó'})",
            code="LABEL_ALREADY_CLOSED",
        )

    waste: Waste | None = None
    closed_by_id, closed_by_name = actor.employee_id, actor.employee_name
    if data.outcome == "discarded" and features.is_enabled(db, store.organization_id, store.id, "inventory.waste"):
        if data.qty is None or not data.qty.strip():
            raise AppError("VALIDATION_ERROR", "qty: escribí cuánto se botó")
        if data.employee_pin is None or not data.employee_pin.strip():
            raise AppError("VALIDATION_ERROR", "employee_pin: la merma pide el PIN de la persona responsable")
        from app.inventory import service as inventory_service
        from app.inventory.schemas import WasteIn

        waste_unit = labels_out(db, [row], today=_today(store))[0].waste_unit
        note = (data.note or "").strip()
        waste = inventory_service.register_waste(
            db,
            store=store,
            data=WasteIn(
                ingredient_id=row.ingredient_id,
                preparation_id=row.preparation_id,
                qty=data.qty.strip(),
                entry_unit=waste_unit if row.ingredient_id is not None else None,
                type=data.waste_type,
                note=f"Etiqueta {row.code}" + (f" · {note}" if note else ""),
                employee_pin=data.employee_pin.strip(),
            ),
        )
        closed_by_id, closed_by_name = waste.employee_id, waste.employee_name

    row.status = LabelStatus.USED_UP if data.outcome == "used_up" else LabelStatus.DISCARDED
    row.closed_at = clock.now_utc()
    row.closed_by_employee_id = closed_by_id
    row.closed_by_employee_name = closed_by_name
    row.waste_id = waste.id if waste is not None else None
    db.flush()
    return row, waste


# ---------------------------------------------------------------------------
# Lecturas.
# ---------------------------------------------------------------------------


def board(db: Session, *, store: Store) -> LabelBoardOut:
    today = _today(store)
    rows = list(
        db.execute(
            select(FoodLabel)
            .where(FoodLabel.store_id == store.id, FoodLabel.status == LabelStatus.ACTIVE)
            .order_by(FoodLabel.use_by.is_(None), FoodLabel.use_by.asc(), FoodLabel.made_at.asc())
        ).scalars()
    )
    out = labels_out(db, rows, today=today)
    return LabelBoardOut(
        business_date=today,
        labels=out,
        expired=sum(1 for o in out if o.state == "expired"),
        today=sum(1 for o in out if o.state == "today"),
        tomorrow=sum(1 for o in out if o.state == "tomorrow"),
    )


def list_admin(
    db: Session, *, store: Store, status: str, date_from: date | None, date_to: date | None
) -> list[LabelOut]:
    stmt = select(FoodLabel).where(FoodLabel.store_id == store.id)
    if status == "active":
        stmt = stmt.where(FoodLabel.status == LabelStatus.ACTIVE)
    elif status == "closed":
        stmt = stmt.where(FoodLabel.status != LabelStatus.ACTIVE)
    if date_from is not None:
        stmt = stmt.where(FoodLabel.business_date >= date_from)
    if date_to is not None:
        stmt = stmt.where(FoodLabel.business_date <= date_to)
    if status == "active":
        stmt = stmt.order_by(FoodLabel.use_by.is_(None), FoodLabel.use_by.asc(), FoodLabel.made_at.asc())
    else:
        stmt = stmt.order_by(FoodLabel.made_at.desc())
    return labels_out(db, list(db.execute(stmt).scalars()), today=_today(store))


def _received_sources(db: Session, *, store: Store, since: date) -> list[ReceivedSourceOut]:
    """Lo que llegó en los últimos días, una sola vez cada cosa:
    - los renglones de lo recibido en la tablet (borradores pendientes o ya
      completados), que es lo que la cocina tiene en la mano en la puerta;
    - los lotes de las recepciones que el administrador cargó directo (sin
      borrador). Los lotes de un borrador completado NO se repiten: su
      renglón ya está en la lista, con sus etiquetas contadas."""
    printed_by_line: dict[int | None, int] = {
        k: n
        for k, n in db.execute(
            select(FoodLabel.reception_draft_line_id, func.count())
            .where(FoodLabel.store_id == store.id, FoodLabel.reception_draft_line_id.is_not(None))
            .group_by(FoodLabel.reception_draft_line_id)
        ).all()
    }
    printed_by_batch: dict[int | None, int] = {
        k: n
        for k, n in db.execute(
            select(FoodLabel.stock_batch_id, func.count())
            .where(FoodLabel.store_id == store.id, FoodLabel.kind == LabelKind.RECEIVED)
            .group_by(FoodLabel.stock_batch_id)
        ).all()
    }
    out: list[ReceivedSourceOut] = []
    draft_rows = db.execute(
        select(ReceptionDraftLine, ReceptionDraft, Ingredient)
        .join(ReceptionDraft, ReceptionDraft.id == ReceptionDraftLine.draft_id)
        .join(Ingredient, Ingredient.id == ReceptionDraftLine.ingredient_id)
        .where(
            ReceptionDraft.store_id == store.id,
            ReceptionDraft.status != ReceptionDraftStatus.REJECTED,
            ReceptionDraft.business_date >= since,
        )
        .order_by(ReceptionDraft.created_at.desc(), ReceptionDraftLine.id.asc())
    ).all()
    for line, draft, ing in draft_rows:
        out.append(
            ReceivedSourceOut(
                stock_batch_id=None,
                reception_draft_line_id=line.id,
                pending=draft.status is ReceptionDraftStatus.PENDING,
                ingredient_id=ing.id,
                name=ing.name,
                lot_code=line.lot_code,
                expires_at=line.expires_at,
                qty_received=format_qty_base(line.qty_purchase_milli),
                unit=line.purchase_unit,
                received_at=draft.created_at,
                labels_printed=int(printed_by_line.get(line.id, 0)),
            )
        )
    from_drafts = select(ReceptionDraft.reception_id).where(ReceptionDraft.reception_id.is_not(None))
    batches = db.execute(
        select(StockBatch, Ingredient)
        .join(Ingredient, Ingredient.id == StockBatch.ingredient_id)
        .where(
            StockBatch.store_id == store.id,
            StockBatch.reversed_at.is_(None),
            StockBatch.source_type == "reception",
            StockBatch.business_date >= since,
            StockBatch.source_id.not_in(from_drafts),
        )
        .order_by(StockBatch.received_at.desc())
    ).all()
    for b, ing in batches:
        out.append(
            ReceivedSourceOut(
                stock_batch_id=b.id,
                reception_draft_line_id=None,
                pending=False,
                ingredient_id=ing.id,
                name=ing.name,
                lot_code=b.lot_code,
                expires_at=b.expires_at,
                qty_received=format_qty_base(b.qty_received),
                unit=ing.base_unit.value,
                received_at=b.received_at,
                labels_printed=int(printed_by_batch.get(b.id, 0)),
            )
        )
    out.sort(key=lambda r: r.received_at, reverse=True)
    return out


def sources(db: Session, *, store: Store) -> LabelSourcesOut:
    today = _today(store)
    since = today - timedelta(days=SOURCE_DAYS - 1)

    ingredients = list(
        db.execute(
            select(Ingredient)
            .where(Ingredient.store_id == store.id, Ingredient.active.is_(True))
            .order_by(Ingredient.name.asc())
        ).scalars()
    )
    openable: list[OpenableIngredientOut] = []
    for ing in ingredients:
        batch = _fefo_batch(db, store_id=store.id, ingredient_id=ing.id)
        preview, preview_source = opened_use_by(ing, batch, today=today)
        openable.append(
            OpenableIngredientOut(
                ingredient_id=ing.id,
                name=ing.name,
                category=ing.category,
                perishable=ing.perishable,
                opened_shelf_life_days=ing.opened_shelf_life_days,
                next_batch=(
                    OpenableBatchOut(stock_batch_id=batch.id, lot_code=batch.lot_code, expires_at=batch.expires_at)
                    if batch is not None
                    else None
                ),
                use_by_preview=preview,
                use_by_source_preview=preview_source.value if preview_source is not None else None,  # type: ignore[arg-type]
            )
        )

    received = _received_sources(db, store=store, since=since)

    printed_by_prep: dict[int | None, int] = {
        k: n
        for k, n in db.execute(
            select(FoodLabel.prep_batch_id, func.count())
            .where(FoodLabel.store_id == store.id, FoodLabel.kind == LabelKind.PRODUCED)
            .group_by(FoodLabel.prep_batch_id)
        ).all()
    }
    prep_rows = list(
        db.execute(
            select(PrepBatch, Preparation)
            .join(Preparation, Preparation.id == PrepBatch.preparation_id)
            .where(
                PrepBatch.store_id == store.id,
                PrepBatch.closed_at.is_(None),
                PrepBatch.business_date >= since,
            )
            .order_by(PrepBatch.produced_at.desc())
        ).all()
    )
    produced = [
        ProducedSourceOut(
            prep_batch_id=pb.id,
            preparation_id=p.id,
            name=p.name,
            qty_real=format_qty_base(pb.qty_real),
            unit=_PREP_UNIT_LABEL.get(pb.unit, pb.unit),
            expiry_date=pb.expiry_date,
            produced_at=pb.produced_at,
            produced_by=pb.produced_by_employee_name,
            labels_printed=int(printed_by_prep.get(pb.id, 0)),
        )
        for pb, p in prep_rows
    ]
    return LabelSourcesOut(business_date=today, openable=openable, received=received, produced=produced)


# ---------------------------------------------------------------------------
# Tamaño de la etiqueta.
# ---------------------------------------------------------------------------


def get_settings(db: Session, *, store: Store) -> LabelSettingsOut:
    row = db.get(LabelSettings, store.id)
    if row is None:
        return LabelSettingsOut(store_id=store.id, width_mm=50, height_mm=30)
    return LabelSettingsOut(store_id=store.id, width_mm=row.width_mm, height_mm=row.height_mm)


def put_settings(db: Session, *, store: Store, data: LabelSettingsIn) -> tuple[LabelSettingsOut, LabelSettingsOut]:
    before = get_settings(db, store=store)
    row = db.get(LabelSettings, store.id)
    now: datetime = clock.now_utc()
    if row is None:
        row = LabelSettings(store_id=store.id, width_mm=data.width_mm, height_mm=data.height_mm, updated_at=now)
        db.add(row)
    else:
        row.width_mm = data.width_mm
        row.height_mm = data.height_mm
        row.updated_at = now
    db.flush()
    return before, get_settings(db, store=store)
