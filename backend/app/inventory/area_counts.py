"""Conteo corto por área (`inventory.shift_counts`): la lógica y la única
matemática de sus faltantes.

Como en los restaurantes grandes, cada área responde por lo suyo: el del bar
cuenta licores, el de cocina carnes y vegetales. El administrador arma las
áreas, dice quién es de cuál y qué artículos clave cuenta cada una (5–15, no
todo el inventario). En el POS la persona identificada ve **sólo la lista de
su área**, a ciegas (sin stock del sistema ni conteo anterior), y cuenta al
abrir (quien entra) y al cerrar (quien sale). El administrador puede pedir
además un **recuento sorpresa** de 1–5 artículos a un área.

**Nada de esto mueve el libro**: un conteo corto no ajusta el stock (eso lo
hace el conteo completo, `service.apply_count`). Mide y avisa; **nunca
bloquea** abrir ni cerrar el turno.

La matemática (una sola, acá; la pantalla la pinta como llega):

- **Faltante de la noche** — en un conteo de APERTURA, contra el último
  CIERRE de la misma área.
- **Faltante del turno** — en un conteo de CIERRE, contra la última APERTURA
  de la misma área y el mismo día operativo.
- En los dos: ``esperado = contado_antes + entradas − salidas`` en la ventana
  ``(instante_antes, instante_ahora]``, con entradas y salidas leídas del
  libro de movimientos por `service._movement_sum` (la misma suma que usa
  la varianza) — recepciones, traslados recibidos, producción, consumo
  teórico de ventas por receta, merma, consumo interno y traslados enviados.
  Se excluye `count_adjustment`: el ajuste de un conteo completo corrige el
  libro, no mueve nada físico.
  ``faltante = esperado − contado_ahora`` (positivo = faltó; negativo =
  sobró).
- **Recuento sorpresa** — contra el stock del sistema en ese instante
  (`hooks.current_stock(..., as_of=contado_en)`, la misma lectura que usa
  `apply_count`).
- **Valorizado** con `hooks.resolve_ingredient_cost` (sólo en respuestas de
  administrador): `micros_to_pesos(line_cost_micros(faltante, costo))`. Sin
  costo, `None` — nunca `$ 0`.
- **Umbral** por sede (`AreaCountSettings`): se marca cuando la diferencia
  supera el porcentaje de lo esperado **y** el monto (una frontera en `None`
  no se exige; sin costo conocido manda sólo el porcentaje).

**Artículo por artículo y obligatorio al abrir** (0030, decisión 5 del
dueño). La apertura y el cierre de un área son una SESIÓN (un `AreaCount` con
`session_key` único por área, momento y día operativo) que se llena de a un
artículo: cada artículo se guarda al contarlo (`record_item`) con quién y a
qué hora, cualquier persona identificada puede contar cualquier área (quien
termina primero ayuda al otro), y nadie ve la cantidad que tecleó otro —sólo
«contado por Kevin 7:10»—. Recontar agrega otra entrada: manda la última y
la anterior queda en el historial. La sesión está completa cuando todos los
artículos de la lista del día tienen conteo. Nada de esto exige una caja
abierta: la ventana es el día operativo (hora de corte de la sede), y el
faltante de la noche se mide de la hora del último cierre a la hora de cada
artículo contado al abrir, con la misma fórmula.

La apertura del área de cada persona es **obligatoria**: `opening_gate`
dice si quien está identificado tiene que contar primero (la pantalla lo
lleva a Conteo y frena las demás, salvo el KDS, que sólo avisa en rojo). Eso
no toca la caja ni las ventas en el servidor: sigue siendo cierto que el
conteo corto nunca bloquea abrir ni cerrar el turno.

**Conteo completo mensual**: el día `monthly_full_count_day` (1–28) la lista
de apertura de cada área es su lista corta más TODOS los insumos activos de
sus categorías (`CountArea.full_count_categories`). Sigue siendo obligatoria
y filtrable; el tope de 15 es sólo de la lista corta.

Todo se valida antes de escribir (`get_db` comitea también ante un
`AppError`, `tests/audit/test_write_before_reject.py`).
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime

from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.auth.deps import Actor
from app.auth.models import Employee
from app.core import clock, tz
from app.core.errors import AppError, NotFoundError
from app.core.money import format_cop
from app.core.percent import format_pct_bp
from app.core.quantity import format_qty_base, line_cost_micros, micros_to_pesos
from app.inventory import hooks, service
from app.inventory.units import entry_qty_to_base, entry_spec
from app.inventory.models import (
    AreaCount,
    AreaCountLine,
    AreaCountMoment,
    AreaCountSettings,
    AreaRecountRequest,
    AreaRecountStatus,
    CountArea,
    CountAreaItem,
    CountAreaMember,
    Ingredient,
    MovementCause,
)
from app.inventory.schemas import (
    AdminAreaCountStatusOut,
    AreaCountDetailOut,
    AreaCountDoneOut,
    AreaCountEntryOut,
    AreaCountIn,
    AreaCountItemIn,
    AreaCountItemOut,
    AreaCountItemSavedOut,
    AreaCountLineIn,
    AreaCountLineOut,
    AreaCountMarkOut,
    AreaCountOut,
    AreaCountProgressOut,
    AreaCountReceiptOut,
    AreaCountSettingsIn,
    AreaCountSettingsOut,
    AreaCountSheetAreaOut,
    AreaCountSheetItemOut,
    AreaOpeningPendingOut,
    AreaRecountAnswerIn,
    AreaRecountRequestIn,
    AreaRecountRequestOut,
    CountAreaCategoriesIn,
    CountAreaIn,
    CountAreaItemsIn,
    CountAreaMemberIn,
    CountAreaMemberOut,
    CountAreaOut,
    CountAreaUpdateIn,
    DeviceAreaCountBoardOut,
    DeviceAreaCountSheetOut,
    DeviceAreaRecountOut,
    DeviceOpeningGateOut,
)
from app.stores.models import Store

FEATURE = "inventory.shift_counts"

#: Defaults del umbral (se usan mientras la sede no guarde los suyos).
DEFAULT_THRESHOLD_PCT_BP = 200  # 2 %
DEFAULT_THRESHOLD_AMOUNT = 20_000  # $ 20.000

#: Artículos por área: la lista es corta a propósito («no todo el inventario»).
MAX_ITEMS_PER_AREA = 15
MAX_RECOUNT_ITEMS = 5

#: Sin conteo todavía en el día, desde esta hora de Bogotá (y hasta la hora
#: de corte de la sede, de madrugada) el POS sugiere «Cierre» en vez de
#: «Apertura»: a esa hora lo probable es que se esté cerrando.
SUGGEST_CLOSING_FROM_LOCAL_HOUR = 20

#: Causas que NO son un flujo físico: el ajuste de un conteo completo
#: corrige el libro. Excluidas igual que en la varianza (`variance_report`).
_NOT_A_FLOW = (MovementCause.COUNT_ADJUSTMENT,)


# ---------------------------------------------------------------------------
# Unidades: cómo se teclea cada artículo y cómo se convierte (una vez, acá).
# ---------------------------------------------------------------------------


def _to_base(ingredient: Ingredient, raw: str) -> int:
    """Lo tecleado en la unidad cómoda → milésimas de la unidad base. La
    conversión vive en `units.entry_qty_to_base` (la misma de la merma);
    acá sólo se suma la regla propia del conteo: la botella se cuenta en
    enteras y décimas de la abierta, y la unidad, sin fracción."""
    spec = entry_spec(ingredient)
    text = raw.strip().replace(",", ".")
    if spec.mode == "bottle" and "." in text and len(text.split(".", 1)[1].rstrip("0")) > 1:
        raise AppError(
            code="VALIDATION_ERROR",
            message=f"{ingredient.name}: contá las botellas enteras y la abierta en décimas (por ejemplo 2,3)",
        )
    return entry_qty_to_base(ingredient, text)


def item_out(ingredient: Ingredient) -> AreaCountItemOut:
    spec = entry_spec(ingredient)
    return AreaCountItemOut(
        ingredient_id=ingredient.id,
        name=ingredient.name,
        base_unit=ingredient.base_unit.value,  # type: ignore[arg-type]
        entry_mode=spec.mode,  # type: ignore[arg-type]
        entry_unit=spec.unit,
    )


# ---------------------------------------------------------------------------
# Umbral.
# ---------------------------------------------------------------------------


def thresholds(db: Session, store: Store) -> tuple[int | None, int | None]:
    """`(porcentaje_bp, monto)` vigentes. Lectura pura: sin fila guardada,
    los defaults (no crea nada al leer)."""
    row = db.get(AreaCountSettings, store.id)
    if row is None:
        return DEFAULT_THRESHOLD_PCT_BP, DEFAULT_THRESHOLD_AMOUNT
    return row.threshold_pct_bp, row.threshold_amount


def _reading(pct_bp: int | None, amount: int | None) -> str:
    if pct_bp is not None and amount is not None:
        regla = (
            f"Se marca un artículo cuando su diferencia pasa del {format_pct_bp(pct_bp)} de lo esperado "
            f"y además de {format_cop(amount)}. Sin costo conocido, manda sólo el porcentaje."
        )
    elif pct_bp is not None:
        regla = f"Se marca un artículo cuando su diferencia pasa del {format_pct_bp(pct_bp)} de lo esperado."
    elif amount is not None:
        regla = (
            f"Se marca un artículo cuando su diferencia vale más de {format_cop(amount)}. "
            "Sin costo conocido, se marca toda diferencia."
        )
    else:
        regla = "Sin umbral: se marca toda diferencia, por chica que sea."
    return regla + " Nunca bloquea abrir ni cerrar el turno: sólo avisa en Hoy."


def monthly_full_count_day(db: Session, store: Store) -> int | None:
    """El día del mes del conteo completo, o `None` (apagado, el default)."""
    row = db.get(AreaCountSettings, store.id)
    return row.monthly_full_count_day if row is not None else None


def is_full_count_day(db: Session, store: Store, business_date: date) -> bool:
    day = monthly_full_count_day(db, store)
    return day is not None and business_date.day == day


def _next_full_count_date(day: int, today: date) -> date:
    if today.day <= day:
        return today.replace(day=day)
    year, month = (today.year + 1, 1) if today.month == 12 else (today.year, today.month + 1)
    return date(year, month, day)


def _monthly_reading(day: int | None, today: date) -> str:
    if day is None:
        return (
            "Conteo completo mensual apagado: todos los días la apertura cuenta la lista corta de cada área."
        )
    nxt = _next_full_count_date(day, today)
    cuando = "hoy" if nxt == today else f"el {nxt.day:02d}/{nxt.month:02d}/{nxt.year}"
    return (
        f"El día {day} de cada mes la apertura de cada área cuenta su lista corta y además todos los insumos "
        f"activos de sus categorías. Sigue siendo obligatoria. El próximo es {cuando}."
    )


def settings_out(db: Session, store: Store) -> AreaCountSettingsOut:
    pct_bp, amount = thresholds(db, store)
    day = monthly_full_count_day(db, store)
    today = tz.today_business_date(store.cutoff_hour)
    return AreaCountSettingsOut(
        store_id=store.id,
        threshold_pct_bp=pct_bp,
        threshold_amount=amount,
        reading=_reading(pct_bp, amount),
        monthly_full_count_day=day,
        monthly_reading=_monthly_reading(day, today),
        full_count_today=day is not None and today.day == day,
    )


def update_settings(db: Session, store: Store, data: AreaCountSettingsIn) -> AreaCountSettingsOut:
    now = clock.now_utc()
    row = db.get(AreaCountSettings, store.id)
    if row is None:
        row = AreaCountSettings(
            store_id=store.id,
            threshold_pct_bp=DEFAULT_THRESHOLD_PCT_BP,
            threshold_amount=DEFAULT_THRESHOLD_AMOUNT,
            updated_at=now,
        )
        db.add(row)
    row.threshold_pct_bp = data.threshold_pct_bp
    row.threshold_amount = data.threshold_amount
    # Guardar el umbral sin mandar el día no apaga el conteo completo.
    if "monthly_full_count_day" in data.model_fields_set:
        row.monthly_full_count_day = data.monthly_full_count_day
    row.updated_at = now
    db.flush()
    return settings_out(db, store)


def _is_flagged(
    *, shortage: int, pct_bp: int | None, value: int | None, limit_pct: int | None, limit_amount: int | None
) -> bool:
    if shortage == 0:
        return False
    pct_ok = limit_pct is None or pct_bp is None or pct_bp >= limit_pct
    amount_ok = limit_amount is None or value is None or abs(value) >= limit_amount
    return pct_ok and amount_ok


# ---------------------------------------------------------------------------
# Áreas, miembros y artículos (administrador).
# ---------------------------------------------------------------------------


def list_areas(db: Session, *, store: Store, active_only: bool = False) -> list[CountArea]:
    stmt = select(CountArea).where(CountArea.store_id == store.id)
    if active_only:
        stmt = stmt.where(CountArea.active.is_(True))
    return list(db.execute(stmt.order_by(CountArea.name, CountArea.id)).scalars().all())


def area_or_404(db: Session, *, store: Store, area_id: int) -> CountArea:
    area = db.get(CountArea, area_id)
    if area is None or area.store_id != store.id or area.organization_id != store.organization_id:
        raise NotFoundError("El área de conteo no existe")
    return area


def _name_taken(db: Session, *, store: Store, name: str, exclude_id: int | None) -> bool:
    stmt = select(CountArea.id).where(CountArea.store_id == store.id, func.lower(CountArea.name) == name.lower())
    if exclude_id is not None:
        stmt = stmt.where(CountArea.id != exclude_id)
    return db.execute(stmt).first() is not None


def create_area(db: Session, *, store: Store, data: CountAreaIn) -> CountArea:
    name = data.name.strip()
    if not name:
        raise AppError(code="VALIDATION_ERROR", message="Escribí el nombre del área (por ejemplo Bar o Cocina)")
    if _name_taken(db, store=store, name=name, exclude_id=None):
        raise AppError(code="AREA_NAME_TAKEN", message=f"Ya hay un área «{name}» en esta sede: usá otro nombre", status=409)
    now = clock.now_utc()
    area = CountArea(
        organization_id=store.organization_id, store_id=store.id, name=name, active=True, created_at=now, updated_at=now
    )
    db.add(area)
    db.flush()
    return area


def update_area(db: Session, *, store: Store, area: CountArea, data: CountAreaUpdateIn) -> CountArea:
    name = data.name.strip() if data.name is not None else None
    if name is not None and not name:
        raise AppError(code="VALIDATION_ERROR", message="Escribí el nombre del área")
    if name is not None and _name_taken(db, store=store, name=name, exclude_id=area.id):
        raise AppError(code="AREA_NAME_TAKEN", message=f"Ya hay un área «{name}» en esta sede: usá otro nombre", status=409)
    if name is not None:
        area.name = name
    if data.active is not None:
        area.active = data.active
    area.updated_at = clock.now_utc()
    db.flush()
    return area


def _area_item_rows(db: Session, *, area_id: int) -> list[CountAreaItem]:
    stmt = (
        select(CountAreaItem)
        .where(CountAreaItem.area_id == area_id, CountAreaItem.active.is_(True))
        .order_by(CountAreaItem.position, CountAreaItem.id)
    )
    return list(db.execute(stmt).scalars().all())


def area_ingredients(db: Session, *, area: CountArea) -> list[Ingredient]:
    """Los artículos clave del área, en el orden en que el administrador los
    puso, sin los insumos dados de baja."""
    rows = _area_item_rows(db, area_id=area.id)
    ingredients = {
        i.id: i
        for i in db.execute(
            select(Ingredient).where(Ingredient.id.in_([r.ingredient_id for r in rows]))
        ).scalars()
    } if rows else {}
    out: list[Ingredient] = []
    for r in rows:
        ing = ingredients.get(r.ingredient_id)
        if ing is not None and ing.active:
            out.append(ing)
    return out


def set_area_items(db: Session, *, store: Store, area: CountArea, data: CountAreaItemsIn) -> CountArea:
    ids = data.ingredient_ids
    if len(set(ids)) != len(ids):
        raise AppError(code="VALIDATION_ERROR", message="Hay un artículo repetido en la lista")
    if len(ids) > MAX_ITEMS_PER_AREA:
        raise AppError(
            code="VALIDATION_ERROR",
            message=f"Una lista de conteo corto lleva como máximo {MAX_ITEMS_PER_AREA} artículos: dejá sólo los clave",
        )
    if not area.active:
        raise AppError(code="AREA_INACTIVE", message=f"El área «{area.name}» está desactivada: activala para armar su lista")
    found = {
        i.id: i
        for i in db.execute(
            select(Ingredient).where(Ingredient.id.in_(ids), Ingredient.store_id == store.id)
        ).scalars()
    } if ids else {}
    for ing_id in ids:
        ing = found.get(ing_id)
        if ing is None or not ing.active:
            raise AppError(code="VALIDATION_ERROR", message="Uno de los artículos no es un insumo activo de esta sede")
    existing = {
        r.ingredient_id: r
        for r in db.execute(select(CountAreaItem).where(CountAreaItem.store_id == store.id)).scalars()
    }
    for ing_id in ids:
        row = existing.get(ing_id)
        if row is not None and row.active and row.area_id != area.id:
            other = db.get(CountArea, row.area_id)
            if other is not None and other.active:
                raise AppError(
                    code="ITEM_IN_OTHER_AREA",
                    message=(
                        f"«{found[ing_id].name}» ya se cuenta en {other.name}: sacalo de esa lista primero "
                        "(un insumo se cuenta en un solo área)"
                    ),
                )

    now = clock.now_utc()
    wanted = set(ids)
    for row in existing.values():
        if row.area_id == area.id and row.active and row.ingredient_id not in wanted:
            row.active = False
            row.updated_at = now
    for position, ing_id in enumerate(ids):
        row = existing.get(ing_id)
        if row is None:
            db.add(
                CountAreaItem(
                    organization_id=store.organization_id,
                    store_id=store.id,
                    area_id=area.id,
                    ingredient_id=ing_id,
                    position=position,
                    active=True,
                    updated_at=now,
                )
            )
        else:
            row.area_id = area.id
            row.position = position
            row.active = True
            row.updated_at = now
    db.flush()
    return area


def _category_key(name: str) -> str:
    return " ".join(name.split()).casefold()


def area_categories(area: CountArea) -> list[str]:
    return [c for c in (area.full_count_categories or []) if c.strip()]


def set_area_categories(db: Session, *, store: Store, area: CountArea, data: CountAreaCategoriesIn) -> CountArea:
    """Qué categorías de insumo cuenta el área el día del conteo completo.
    Una categoría es de un solo área (activa): contada a medias en dos, el
    libro —un saldo por insumo— no se podría comparar con ninguna."""
    if not area.active:
        raise AppError(code="AREA_INACTIVE", message=f"El área «{area.name}» está desactivada: activala primero")
    cleaned: list[str] = []
    seen: set[str] = set()
    for raw in data.categories:
        name = " ".join(raw.split())
        if not name:
            raise AppError(code="VALIDATION_ERROR", message="Hay una categoría vacía: escribí su nombre o sacala")
        if len(name) > 100:
            raise AppError(code="VALIDATION_ERROR", message=f"«{name[:30]}…» es demasiado largo para una categoría")
        key = _category_key(name)
        if key in seen:
            raise AppError(code="VALIDATION_ERROR", message=f"La categoría «{name}» está repetida")
        seen.add(key)
        cleaned.append(name)
    for other in list_areas(db, store=store, active_only=True):
        if other.id == area.id:
            continue
        taken = {_category_key(c) for c in area_categories(other)}
        clash = next((c for c in cleaned if _category_key(c) in taken), None)
        if clash is not None:
            raise AppError(
                code="CATEGORY_IN_OTHER_AREA",
                message=f"«{clash}» ya la cuenta {other.name} en el conteo completo: sacala de esa área primero",
            )
    area.full_count_categories = cleaned
    area.updated_at = clock.now_utc()
    db.flush()
    return area


def _short_list_elsewhere(db: Session, *, store: Store, area: CountArea) -> set[int]:
    """Insumos que están en la lista corta de OTRA área activa: se cuentan
    allá aunque su categoría sea de ésta (un insumo, un área)."""
    stmt = (
        select(CountAreaItem.ingredient_id)
        .join(CountArea, CountArea.id == CountAreaItem.area_id)
        .where(
            CountAreaItem.store_id == store.id,
            CountAreaItem.active.is_(True),
            CountAreaItem.area_id != area.id,
            CountArea.active.is_(True),
        )
    )
    return set(db.execute(stmt).scalars().all())


def full_list(db: Session, *, store: Store, area: CountArea) -> list[Ingredient]:
    """La lista del conteo completo: la lista corta (en su orden) y después
    todos los insumos activos de las categorías del área, por nombre."""
    short = area_ingredients(db, area=area)
    keys = {_category_key(c) for c in area_categories(area)}
    if not keys:
        return short
    have = {i.id for i in short} | _short_list_elsewhere(db, store=store, area=area)
    candidates = db.execute(
        select(Ingredient).where(
            Ingredient.store_id == store.id, Ingredient.active.is_(True), Ingredient.category.is_not(None)
        )
    ).scalars().all()
    extra = sorted(
        (i for i in candidates if i.id not in have and _category_key(i.category or "") in keys),
        key=lambda i: (i.name.casefold(), i.id),
    )
    return short + extra


def list_for(db: Session, *, store: Store, area: CountArea, business_date: date) -> tuple[str, list[Ingredient]]:
    """`(scope, artículos)` que cuenta el área ese día operativo: la lista
    completa el día del conteo mensual, la corta los demás."""
    if is_full_count_day(db, store, business_date):
        return "full", full_list(db, store=store, area=area)
    return "short", area_ingredients(db, area=area)


def _member_rows(db: Session, *, store: Store) -> list[CountAreaMember]:
    stmt = select(CountAreaMember).where(CountAreaMember.store_id == store.id, CountAreaMember.active.is_(True))
    return list(db.execute(stmt.order_by(CountAreaMember.employee_name)).scalars().all())


def set_member(db: Session, *, store: Store, data: CountAreaMemberIn) -> CountAreaMember | None:
    employee = db.get(Employee, data.employee_id)
    if (
        employee is None
        or employee.organization_id != store.organization_id
        or (employee.store_id is not None and employee.store_id != store.id)
    ):
        raise NotFoundError("La persona no existe en esta sede")
    area: CountArea | None = None
    if data.area_id is not None:
        area = area_or_404(db, store=store, area_id=data.area_id)
        if not area.active:
            raise AppError(code="AREA_INACTIVE", message=f"El área «{area.name}» está desactivada: activala primero")
        if not employee.active:
            raise AppError(code="VALIDATION_ERROR", message=f"{employee.name} está inactivo: no se le asigna área")
    row = db.execute(
        select(CountAreaMember).where(
            CountAreaMember.store_id == store.id, CountAreaMember.employee_id == employee.id
        )
    ).scalar_one_or_none()
    now = clock.now_utc()
    if area is None:
        if row is not None and row.active:
            row.active = False
            row.updated_at = now
            db.flush()
        return row
    if row is None:
        row = CountAreaMember(
            organization_id=store.organization_id,
            store_id=store.id,
            area_id=area.id,
            employee_id=employee.id,
            employee_name=employee.name,
            active=True,
            updated_at=now,
        )
        db.add(row)
    else:
        row.area_id = area.id
        row.employee_name = employee.name
        row.active = True
        row.updated_at = now
    db.flush()
    return row


def area_out(db: Session, area: CountArea, members: list[CountAreaMember], store: Store) -> CountAreaOut:
    return CountAreaOut(
        id=area.id,
        name=area.name,
        active=area.active,
        members=[
            CountAreaMemberOut(employee_id=m.employee_id, employee_name=m.employee_name)
            for m in members
            if m.area_id == area.id
        ],
        items=[item_out(i) for i in area_ingredients(db, area=area)],
        categories=area_categories(area),
        full_count_items=len(full_list(db, store=store, area=area)),
    )


def areas_out(db: Session, *, store: Store) -> list[CountAreaOut]:
    members = _member_rows(db, store=store)
    return [area_out(db, a, members, store) for a in list_areas(db, store=store)]


# ---------------------------------------------------------------------------
# El POS: la lista del área de quien está identificado.
# ---------------------------------------------------------------------------


def member_area(db: Session, *, store: Store, employee_id: int) -> CountArea | None:
    row = db.execute(
        select(CountAreaMember).where(
            CountAreaMember.store_id == store.id,
            CountAreaMember.employee_id == employee_id,
            CountAreaMember.active.is_(True),
        )
    ).scalar_one_or_none()
    if row is None:
        return None
    area = db.get(CountArea, row.area_id)
    return area if area is not None and area.active else None


def _latest_count(db: Session, *, area_id: int, moment: AreaCountMoment, business_date: date) -> AreaCount | None:
    stmt = (
        select(AreaCount)
        .where(AreaCount.area_id == area_id, AreaCount.moment == moment, AreaCount.business_date == business_date)
        .order_by(AreaCount.counted_at.desc(), AreaCount.id.desc())
        .limit(1)
    )
    return db.execute(stmt).scalars().first()


def _done(count: AreaCount | None) -> AreaCountDoneOut | None:
    if count is None:
        return None
    return AreaCountDoneOut(count_id=count.id, counted_at=count.counted_at, employee_name=count.employee_name)


def suggested_moment(*, store: Store, now: datetime, opening_done: bool, closing_done: bool) -> str:
    """Qué momento propone el POS. Ya contó al abrir → «Cierre». Nada todavía:
    «Apertura», salvo de noche (desde `SUGGEST_CLOSING_FROM_LOCAL_HOUR` hasta
    la hora de corte, que ya es madrugada del mismo día operativo). La
    persona lo puede cambiar: es una sugerencia, no una regla."""
    if opening_done or closing_done:
        return "closing"
    local_hour = tz.to_bogota(now).hour
    late = local_hour >= SUGGEST_CLOSING_FROM_LOCAL_HOUR or local_hour < store.cutoff_hour
    return "closing" if late else "opening"


def _pending_recounts(db: Session, *, area_id: int) -> list[AreaRecountRequest]:
    stmt = (
        select(AreaRecountRequest)
        .where(AreaRecountRequest.area_id == area_id, AreaRecountRequest.status == AreaRecountStatus.PENDING)
        .order_by(AreaRecountRequest.requested_at, AreaRecountRequest.id)
    )
    return list(db.execute(stmt).scalars().all())


def _ingredients_by_id(db: Session, ids: list[int]) -> dict[int, Ingredient]:
    if not ids:
        return {}
    return {i.id: i for i in db.execute(select(Ingredient).where(Ingredient.id.in_(ids))).scalars()}


def _recount_items(db: Session, req: AreaRecountRequest) -> list[Ingredient]:
    found = _ingredients_by_id(db, list(req.ingredient_ids))
    return [found[i] for i in req.ingredient_ids if i in found]


def device_board(db: Session, *, store: Store, actor: Actor) -> DeviceAreaCountBoardOut:
    now = clock.now_utc()
    business_date = tz.business_date_for(now, store.cutoff_hour)

    def empty(reason: str) -> DeviceAreaCountBoardOut:
        return DeviceAreaCountBoardOut(
            area_id=None, area_name=None, reason=reason, business_date=business_date.isoformat(), items=[],
            suggested_moment="opening", opening_done=None, closing_done=None, recounts=[],
        )

    if actor.employee_id is None:
        return empty("Identificate con tu PIN para ver la lista de tu área")
    area = member_area(db, store=store, employee_id=actor.employee_id)
    if area is None:
        return empty(
            "No tenés un área de conteo asignada. Pedile al administrador que te asigne una en "
            "Inventario › Conteo por área"
        )
    items = area_ingredients(db, area=area)
    opening = _latest_count(db, area_id=area.id, moment=AreaCountMoment.OPENING, business_date=business_date)
    closing = _latest_count(db, area_id=area.id, moment=AreaCountMoment.CLOSING, business_date=business_date)
    recounts = [
        DeviceAreaRecountOut(
            id=r.id,
            requested_at=r.requested_at,
            requested_by_employee_name=r.requested_by_employee_name,
            note=r.note,
            items=[item_out(i) for i in _recount_items(db, r)],
        )
        for r in _pending_recounts(db, area_id=area.id)
    ]
    return DeviceAreaCountBoardOut(
        area_id=area.id,
        area_name=area.name,
        reason=None if items else f"El área {area.name} todavía no tiene artículos para contar. Avisale al administrador",
        business_date=business_date.isoformat(),
        items=[item_out(i) for i in items],
        suggested_moment=suggested_moment(  # type: ignore[arg-type]
            store=store, now=now, opening_done=opening is not None, closing_done=closing is not None
        ),
        opening_done=_done(opening),
        closing_done=_done(closing),
        recounts=recounts,
    )


def _parse_lines(
    lines: list[AreaCountLineIn], *, expected: list[Ingredient], what: str
) -> list[tuple[Ingredient, int, str, str]]:
    """Valida que venga **cada** artículo de la lista, una sola vez, y
    convierte. No existe «todo igual»: un artículo que no se tecleó no está
    contado (un cero se escribe)."""
    by_id = {i.id: i for i in expected}
    seen: set[int] = set()
    out: list[tuple[Ingredient, int, str, str]] = []
    for line in lines:
        ing = by_id.get(line.ingredient_id)
        if ing is None:
            raise AppError(code="VALIDATION_ERROR", message=f"Uno de los artículos no está en {what}")
        if line.ingredient_id in seen:
            raise AppError(code="VALIDATION_ERROR", message=f"«{ing.name}» viene dos veces: contalo una sola")
        seen.add(line.ingredient_id)
        qty_base = _to_base(ing, line.qty)
        out.append((ing, qty_base, line.qty.strip(), entry_spec(ing).unit))
    missing = [i.name for i in expected if i.id not in seen]
    if missing:
        raise AppError(
            code="COUNT_INCOMPLETE",
            message=f"Falta contar: {', '.join(missing)}. Si no hay, escribí 0",
        )
    return out


def _write_count(
    db: Session,
    *,
    store: Store,
    actor: Actor,
    area: CountArea,
    moment: AreaCountMoment,
    parsed: list[tuple[Ingredient, int, str, str]],
    recount_request_id: int | None,
    now: datetime,
) -> AreaCount:
    assert actor.employee_id is not None and actor.employee_name is not None
    count = AreaCount(
        organization_id=store.organization_id,
        store_id=store.id,
        area_id=area.id,
        area_name=area.name,
        moment=moment,
        recount_request_id=recount_request_id,
        counted_at=now,
        business_date=tz.business_date_for(now, store.cutoff_hour),
        employee_id=actor.employee_id,
        employee_name=actor.employee_name,
        scope=None if moment == AreaCountMoment.SPOT else "short",
    )
    db.add(count)
    db.flush()
    for ing, qty_base, entered, unit in parsed:
        db.add(
            AreaCountLine(
                count_id=count.id, ingredient_id=ing.id, qty_base=qty_base, entered_qty=entered, entered_unit=unit,
                counted_at=now, employee_id=actor.employee_id, employee_name=actor.employee_name,
            )
        )
    db.flush()
    return count


def _require_person(actor: Actor) -> None:
    if actor.employee_id is None or not actor.employee_name:
        raise AppError(code="IDENTIFY_REQUIRED", message="Identificate con tu PIN para registrar el conteo", status=401)


def register_count(db: Session, *, store: Store, actor: Actor, data: AreaCountIn) -> AreaCount:
    _require_person(actor)
    assert actor.employee_id is not None
    area = member_area(db, store=store, employee_id=actor.employee_id)
    if area is None:
        raise AppError(
            code="NO_COUNT_AREA",
            message="No tenés un área de conteo asignada: pedile al administrador que te asigne una en Inventario",
        )
    items = area_ingredients(db, area=area)
    if not items:
        raise AppError(code="COUNT_AREA_EMPTY", message=f"El área {area.name} no tiene artículos para contar todavía")
    parsed = _parse_lines(data.lines, expected=items, what=f"la lista de {area.name}")
    return _write_count(
        db, store=store, actor=actor, area=area, moment=AreaCountMoment(data.moment), parsed=parsed,
        recount_request_id=None, now=clock.now_utc(),
    )


def recount_or_404(db: Session, *, store: Store, request_id: int) -> AreaRecountRequest:
    row = db.execute(
        select(AreaRecountRequest).where(AreaRecountRequest.id == request_id).with_for_update()
    ).scalar_one_or_none()
    if row is None or row.store_id != store.id or row.organization_id != store.organization_id:
        raise NotFoundError("El recuento no existe")
    return row


def answer_recount(
    db: Session, *, store: Store, actor: Actor, request_id: int, data: AreaRecountAnswerIn
) -> AreaCount:
    _require_person(actor)
    assert actor.employee_id is not None
    req = recount_or_404(db, store=store, request_id=request_id)
    area = member_area(db, store=store, employee_id=actor.employee_id)
    if area is None or area.id != req.area_id:
        raise AppError(
            code="RECOUNT_OTHER_AREA",
            message="Este recuento es de otra área: lo tiene que hacer alguien de esa área",
            status=403,
        )
    if req.status != AreaRecountStatus.PENDING:
        raise AppError(code="RECOUNT_ALREADY_ANSWERED", message="Este recuento ya lo hizo otra persona", status=409)
    parsed = _parse_lines(data.lines, expected=_recount_items(db, req), what="este recuento")
    now = clock.now_utc()
    count = _write_count(
        db, store=store, actor=actor, area=area, moment=AreaCountMoment.SPOT, parsed=parsed,
        recount_request_id=req.id, now=now,
    )
    req.status = AreaRecountStatus.ANSWERED
    req.answered_at = now
    db.flush()
    return count


def receipt_out(db: Session, count: AreaCount) -> AreaCountReceiptOut:
    return AreaCountReceiptOut(
        id=count.id,
        area_name=count.area_name,
        moment=count.moment.value,  # type: ignore[arg-type]
        counted_at=count.counted_at,
        employee_name=count.employee_name,
        lines_count=len(_lines(db, count)),
    )


# ---------------------------------------------------------------------------
# Artículo por artículo (0030): la sesión, las entradas y lo que ve la tablet.
# ---------------------------------------------------------------------------


def _entry_time(line: AreaCountLine, count: AreaCount) -> datetime:
    return line.counted_at or count.counted_at


def _entry_name(line: AreaCountLine, count: AreaCount) -> str:
    return line.employee_name or count.employee_name


@dataclass
class _Mark:
    """El estado de un artículo en un área, momento y día: la entrada que
    manda (la última) y cuántas hubo."""

    line: AreaCountLine
    count: AreaCount
    entries: int

    @property
    def at(self) -> datetime:
        return _entry_time(self.line, self.count)

    @property
    def name(self) -> str:
        return _entry_name(self.line, self.count)


def _marks(db: Session, *, area_id: int, moment: AreaCountMoment, business_date: date) -> dict[int, _Mark]:
    """Por insumo, la última entrada de ese área, momento y día operativo —en
    cualquiera de sus conteos: la sesión artículo por artículo o un conteo de
    lista entera—. Manda la última; las demás cuentan en `entries`."""
    rows = db.execute(
        select(AreaCountLine, AreaCount)
        .join(AreaCount, AreaCount.id == AreaCountLine.count_id)
        .where(
            AreaCount.area_id == area_id,
            AreaCount.moment == moment,
            AreaCount.business_date == business_date,
        )
    ).all()
    ordered = sorted(rows, key=lambda r: (_entry_time(r[0], r[1]), r[0].id))
    out: dict[int, _Mark] = {}
    for line, count in ordered:
        prev = out.get(line.ingredient_id)
        out[line.ingredient_id] = _Mark(line=line, count=count, entries=(prev.entries + 1) if prev else 1)
    return out


def _progress(items: list[Ingredient], marks: dict[int, _Mark]) -> AreaCountProgressOut:
    mine = [marks[i.id] for i in items if i.id in marks]
    complete = bool(items) and len(mine) == len(items)
    people: list[str] = []
    for m in sorted(mine, key=lambda m: (m.at, m.line.id)):
        if m.name not in people:
            people.append(m.name)
    return AreaCountProgressOut(
        counted=len(mine),
        total=len(items),
        complete=complete,
        completed_at=max(m.at for m in mine) if complete else None,
        people=people,
    )


def _mark_out(mark: _Mark | None) -> AreaCountMarkOut | None:
    if mark is None:
        return None
    return AreaCountMarkOut(employee_name=mark.name, counted_at=mark.at, entries=mark.entries)


def _session_key(area_id: int, moment: AreaCountMoment, business_date: date) -> str:
    return f"{area_id}:{moment.value}:{business_date.isoformat()}"


def _session_for(
    db: Session,
    *,
    store: Store,
    actor: Actor,
    area: CountArea,
    moment: AreaCountMoment,
    business_date: date,
    scope: str,
    now: datetime,
) -> AreaCount:
    """La sesión de ese área, momento y día; la crea el primer artículo. Dos
    tablets a la vez: el índice único de `session_key` deja entrar a una y
    la otra relee la que ganó (nunca dos sesiones del mismo momento)."""
    assert actor.employee_id is not None and actor.employee_name is not None
    key = _session_key(area.id, moment, business_date)
    stmt = select(AreaCount).where(AreaCount.session_key == key)
    found = db.execute(stmt).scalar_one_or_none()
    if found is not None:
        return found
    try:
        with db.begin_nested():
            count = AreaCount(
                organization_id=store.organization_id,
                store_id=store.id,
                area_id=area.id,
                area_name=area.name,
                moment=moment,
                recount_request_id=None,
                counted_at=now,
                business_date=business_date,
                employee_id=actor.employee_id,
                employee_name=actor.employee_name,
                scope=scope,
                session_key=key,
            )
            db.add(count)
            db.flush()
    except IntegrityError:
        found = db.execute(stmt).scalar_one_or_none()
        if found is None:
            raise
        return found
    return count


@dataclass(frozen=True)
class SavedItem:
    area: CountArea
    count: AreaCount
    line: AreaCountLine
    ingredient: Ingredient
    moment: AreaCountMoment


def record_item(db: Session, *, store: Store, actor: Actor, data: AreaCountItemIn) -> SavedItem:
    """Guarda UN artículo contado. Cualquier persona identificada puede
    contar cualquier área (quien termina primero ayuda). Recontar agrega otra
    entrada: manda la última. Todo se valida antes de escribir."""
    _require_person(actor)
    assert actor.employee_id is not None and actor.employee_name is not None
    area = area_or_404(db, store=store, area_id=data.area_id)
    if not area.active:
        raise AppError(code="AREA_INACTIVE", message=f"El área «{area.name}» está desactivada: no se cuenta")
    now = clock.now_utc()
    business_date = tz.business_date_for(now, store.cutoff_hour)
    scope, items = list_for(db, store=store, area=area, business_date=business_date)
    ingredient = next((i for i in items if i.id == data.ingredient_id), None)
    if ingredient is None:
        raise AppError(
            code="ITEM_NOT_IN_LIST",
            message=f"Ese artículo no está en la lista de {area.name} de hoy: recargá la lista",
        )
    moment = AreaCountMoment(data.moment)
    qty_base = _to_base(ingredient, data.qty)
    count = _session_for(
        db, store=store, actor=actor, area=area, moment=moment, business_date=business_date, scope=scope, now=now
    )
    line = AreaCountLine(
        count_id=count.id,
        ingredient_id=ingredient.id,
        qty_base=qty_base,
        entered_qty=data.qty.strip(),
        entered_unit=entry_spec(ingredient).unit,
        counted_at=now,
        employee_id=actor.employee_id,
        employee_name=actor.employee_name,
    )
    db.add(line)
    db.flush()
    return SavedItem(area=area, count=count, line=line, ingredient=ingredient, moment=moment)


def saved_item_out(db: Session, *, store: Store, saved: SavedItem) -> AreaCountItemSavedOut:
    business_date = saved.count.business_date
    _scope, items = list_for(db, store=store, area=saved.area, business_date=business_date)
    marks = _marks(db, area_id=saved.area.id, moment=saved.moment, business_date=business_date)
    return AreaCountItemSavedOut(
        area_id=saved.area.id,
        area_name=saved.area.name,
        moment=saved.moment.value,  # type: ignore[arg-type]
        ingredient_id=saved.ingredient.id,
        ingredient_name=saved.ingredient.name,
        count_id=saved.count.id,
        counted_at=_entry_time(saved.line, saved.count),
        employee_name=_entry_name(saved.line, saved.count),
        progress=_progress(items, marks),
    )


def _sheet_areas(
    db: Session, *, store: Store, business_date: date, my_area_id: int | None
) -> list[AreaCountSheetAreaOut]:
    out: list[AreaCountSheetAreaOut] = []
    for area in list_areas(db, store=store, active_only=True):
        scope, items = list_for(db, store=store, area=area, business_date=business_date)
        if not items:
            continue
        opening = _marks(db, area_id=area.id, moment=AreaCountMoment.OPENING, business_date=business_date)
        closing = _marks(db, area_id=area.id, moment=AreaCountMoment.CLOSING, business_date=business_date)
        out.append(
            AreaCountSheetAreaOut(
                area_id=area.id,
                area_name=area.name,
                scope=scope,  # type: ignore[arg-type]
                mine=area.id == my_area_id,
                items=[
                    AreaCountSheetItemOut(
                        **item_out(i).model_dump(),
                        opening=_mark_out(opening.get(i.id)),
                        closing=_mark_out(closing.get(i.id)),
                    )
                    for i in items
                ],
                opening=_progress(items, opening),
                closing=_progress(items, closing),
            )
        )
    return out


#: Quien supervisa o administra no queda frenado por el conteo de un área.
_GATE_EXEMPT_ROLES = ("supervisor", "admin")


def _opening_pending(area: AreaCountSheetAreaOut) -> bool:
    """La apertura del área está pendiente: no está completa y todavía nadie
    empezó el cierre de ese día (de noche ya no tiene sentido frenar a nadie
    por la apertura; el dueño lo ve en rojo en Hoy)."""
    return not area.opening.complete and area.closing.counted == 0


def sheet(db: Session, *, store: Store, actor: Actor) -> DeviceAreaCountSheetOut:
    """La pantalla de conteo del POS: las listas del día de todas las áreas,
    con quién contó cada artículo y cuándo —nunca cuánto—."""
    _require_person(actor)
    assert actor.employee_id is not None
    now = clock.now_utc()
    business_date = tz.business_date_for(now, store.cutoff_hour)
    my_area = member_area(db, store=store, employee_id=actor.employee_id)
    areas = _sheet_areas(db, store=store, business_date=business_date, my_area_id=my_area.id if my_area else None)
    mine = next((a for a in areas if a.mine), None)
    if my_area is None:
        reason: str | None = (
            "No tenés un área de conteo asignada: podés ayudar a contar cualquier área. Para tener la tuya, "
            "pedile al administrador que te asigne una en Inventario › Conteo por área"
        )
    elif mine is None:
        reason = f"El área {my_area.name} todavía no tiene artículos para contar. Avisale al administrador"
    else:
        reason = None
    recounts = (
        [
            DeviceAreaRecountOut(
                id=r.id,
                requested_at=r.requested_at,
                requested_by_employee_name=r.requested_by_employee_name,
                note=r.note,
                items=[item_out(i) for i in _recount_items(db, r)],
            )
            for r in _pending_recounts(db, area_id=my_area.id)
        ]
        if my_area is not None
        else []
    )
    return DeviceAreaCountSheetOut(
        business_date=business_date.isoformat(),
        my_area_id=mine.area_id if mine else None,
        reason=reason,
        suggested_moment=suggested_moment(  # type: ignore[arg-type]
            store=store,
            now=now,
            opening_done=bool(mine and mine.opening.complete),
            closing_done=bool(mine and mine.closing.counted > 0),
        ),
        full_count_today=is_full_count_day(db, store, business_date),
        opening_required=bool(mine and actor.role not in _GATE_EXEMPT_ROLES and _opening_pending(mine)),
        areas=areas,
        recounts=recounts,
    )


def opening_gate(db: Session, *, store: Store, actor: Actor) -> DeviceOpeningGateOut:
    """¿Tiene que contar primero quien está identificado? Y qué áreas no
    terminaron su apertura hoy (para el aviso del KDS, que nunca se frena).
    No exige persona: sin persona, nadie queda frenado."""
    now = clock.now_utc()
    business_date = tz.business_date_for(now, store.cutoff_hour)
    my_area = (
        member_area(db, store=store, employee_id=actor.employee_id) if actor.employee_id is not None else None
    )
    areas = _sheet_areas(db, store=store, business_date=business_date, my_area_id=my_area.id if my_area else None)
    pending = [a for a in areas if _opening_pending(a)]
    mine = next((a for a in pending if a.mine), None)
    required = mine is not None and actor.role not in _GATE_EXEMPT_ROLES
    message = None
    if required and mine is not None:
        message = (
            f"Primero el conteo de apertura de {mine.area_name}: van {mine.opening.counted} de "
            f"{mine.opening.total} artículos."
        )
    return DeviceOpeningGateOut(
        business_date=business_date.isoformat(),
        required=required,
        area_id=mine.area_id if required and mine else None,
        area_name=mine.area_name if required and mine else None,
        message=message,
        pending=[
            AreaOpeningPendingOut(
                area_id=a.area_id,
                area_name=a.area_name,
                counted=a.opening.counted,
                total=a.opening.total,
                full_count=a.scope == "full",
            )
            for a in pending
        ],
    )


def admin_status(db: Session, *, store: Store) -> AdminAreaCountStatusOut:
    """Hoy, por área y artículo: quién contó y cuándo (sin cantidades: esas
    están en el detalle de cada conteo, con su diferencia)."""
    business_date = tz.today_business_date(store.cutoff_hour)
    return AdminAreaCountStatusOut(
        business_date=business_date.isoformat(),
        full_count_today=is_full_count_day(db, store, business_date),
        areas=_sheet_areas(db, store=store, business_date=business_date, my_area_id=None),
    )


# ---------------------------------------------------------------------------
# Recuento sorpresa (administrador).
# ---------------------------------------------------------------------------


def create_recount(db: Session, *, store: Store, actor: Actor, data: AreaRecountRequestIn) -> AreaRecountRequest:
    area = area_or_404(db, store=store, area_id=data.area_id)
    if not area.active:
        raise AppError(code="AREA_INACTIVE", message=f"El área «{area.name}» está desactivada")
    ids = data.ingredient_ids
    if len(set(ids)) != len(ids):
        raise AppError(code="VALIDATION_ERROR", message="Hay un artículo repetido en el recuento")
    if not 1 <= len(ids) <= MAX_RECOUNT_ITEMS:
        raise AppError(code="VALIDATION_ERROR", message=f"Un recuento lleva de 1 a {MAX_RECOUNT_ITEMS} artículos")
    found = _ingredients_by_id(db, ids)
    for ing_id in ids:
        ing = found.get(ing_id)
        if ing is None or ing.store_id != store.id or not ing.active:
            raise AppError(code="VALIDATION_ERROR", message="Uno de los artículos no es un insumo activo de esta sede")
    if actor.employee_id is None or not actor.employee_name:
        raise AppError(code="IDENTIFY_REQUIRED", message="Iniciá sesión de nuevo para pedir el recuento", status=401)
    note = data.note.strip() if data.note and data.note.strip() else None
    now = clock.now_utc()
    row = AreaRecountRequest(
        organization_id=store.organization_id,
        store_id=store.id,
        area_id=area.id,
        ingredient_ids=list(ids),
        note=note,
        status=AreaRecountStatus.PENDING,
        requested_at=now,
        business_date=tz.business_date_for(now, store.cutoff_hour),
        requested_by_employee_id=actor.employee_id,
        requested_by_employee_name=actor.employee_name,
        answered_at=None,
    )
    db.add(row)
    db.flush()
    return row


def recount_out(db: Session, req: AreaRecountRequest) -> AreaRecountRequestOut:
    area = db.get(CountArea, req.area_id)
    answer = db.execute(select(AreaCount.id).where(AreaCount.recount_request_id == req.id)).scalar_one_or_none()
    return AreaRecountRequestOut(
        id=req.id,
        area_id=req.area_id,
        area_name=area.name if area is not None else "",
        items=[item_out(i) for i in _recount_items(db, req)],
        note=req.note,
        status=req.status.value,  # type: ignore[arg-type]
        requested_at=req.requested_at,
        requested_by_employee_name=req.requested_by_employee_name,
        answered_at=req.answered_at,
        count_id=answer,
    )


def list_recounts(db: Session, *, store: Store, status: str | None) -> list[AreaRecountRequest]:
    stmt = select(AreaRecountRequest).where(AreaRecountRequest.store_id == store.id)
    if status is not None:
        stmt = stmt.where(AreaRecountRequest.status == AreaRecountStatus(status))
    return list(db.execute(stmt.order_by(AreaRecountRequest.requested_at.desc(), AreaRecountRequest.id.desc())).scalars())


def pending_recounts_count(db: Session, *, store_id: int) -> int:
    stmt = select(func.count(AreaRecountRequest.id)).where(
        AreaRecountRequest.store_id == store_id, AreaRecountRequest.status == AreaRecountStatus.PENDING
    )
    return int(db.execute(stmt).scalar_one())


# ---------------------------------------------------------------------------
# Resultados: la única matemática de los faltantes.
# ---------------------------------------------------------------------------


def _lines(db: Session, count: AreaCount) -> list[AreaCountLine]:
    stmt = select(AreaCountLine).where(AreaCountLine.count_id == count.id).order_by(AreaCountLine.id)
    return list(db.execute(stmt).scalars().all())


def _effective_lines(db: Session, count: AreaCount) -> dict[int, list[AreaCountLine]]:
    """Por insumo, sus entradas en este conteo de la más vieja a la última:
    la última manda, las anteriores son el historial de recuentos. En orden
    de primera aparición (la lista entera se guardó en su orden)."""
    lines = sorted(_lines(db, count), key=lambda l: (_entry_time(l, count), l.id))
    out: dict[int, list[AreaCountLine]] = {}
    for line in lines:
        out.setdefault(line.ingredient_id, []).append(line)
    return out


def count_or_404(db: Session, *, store: Store, count_id: int) -> AreaCount:
    count = db.get(AreaCount, count_id)
    if count is None or count.store_id != store.id or count.organization_id != store.organization_id:
        raise NotFoundError("El conteo no existe")
    return count


def reference_for(db: Session, count: AreaCount) -> tuple[AreaCount | None, str | None]:
    """Contra qué conteo se compara. Apertura → el último cierre del área
    (faltante de la noche). Cierre → la última apertura del área en el mismo
    día operativo (faltante del turno). Recuento → ninguno: se compara con
    el sistema en ese instante."""
    if count.moment == AreaCountMoment.SPOT:
        return None, None
    if count.moment == AreaCountMoment.OPENING:
        stmt = select(AreaCount).where(
            AreaCount.area_id == count.area_id,
            AreaCount.moment == AreaCountMoment.CLOSING,
            AreaCount.counted_at < count.counted_at,
        )
        missing = "No hay un cierre anterior de esta área: el faltante de la noche sale desde el próximo"
    else:
        stmt = select(AreaCount).where(
            AreaCount.area_id == count.area_id,
            AreaCount.moment == AreaCountMoment.OPENING,
            AreaCount.business_date == count.business_date,
            AreaCount.counted_at < count.counted_at,
        )
        missing = "Nadie contó esta área al abrir: sin apertura no hay faltante del turno"
    ref = db.execute(stmt.order_by(AreaCount.counted_at.desc(), AreaCount.id.desc()).limit(1)).scalars().first()
    return ref, (None if ref is not None else missing)


def _window(count: AreaCount) -> str:
    return {AreaCountMoment.OPENING: "night", AreaCountMoment.CLOSING: "shift"}.get(count.moment, "spot")


def _superseded(db: Session, count: AreaCount) -> bool:
    if count.moment == AreaCountMoment.SPOT:
        return False
    stmt = select(AreaCount.id).where(
        AreaCount.area_id == count.area_id,
        AreaCount.moment == count.moment,
        AreaCount.business_date == count.business_date,
        AreaCount.counted_at > count.counted_at,
    )
    return db.execute(stmt.limit(1)).first() is not None


def _pct_bp(shortage: int, expected: int) -> int | None:
    if expected <= 0:
        return None
    return (abs(shortage) * 10000 + expected // 2) // expected


def _line_result(
    db: Session,
    *,
    store: Store,
    count: AreaCount,
    entries: list[AreaCountLine],
    ingredient: Ingredient,
    reference: AreaCount | None,
    reference_lines: dict[int, AreaCountLine],
    reason: str | None,
    limits: tuple[int | None, int | None],
) -> AreaCountLineOut:
    """Un artículo: manda su última entrada. La ventana de entradas y salidas
    va de la hora en que se contó ESE artículo en el conteo anterior a la
    hora en que se contó ahora (artículo por artículo, cada uno con la suya;
    en un conteo de lista entera las dos son la hora del conteo)."""
    line = entries[-1]
    counted_at = _entry_time(line, count)
    base = dict(
        ingredient_id=ingredient.id,
        ingredient_name=ingredient.name,
        base_unit=ingredient.base_unit.value,
        entered_qty=line.entered_qty,
        entered_unit=line.entered_unit,
        counted_qty=format_qty_base(line.qty_base),
        employee_name=_entry_name(line, count),
        counted_at=counted_at,
        history=[
            AreaCountEntryOut(
                employee_name=_entry_name(e, count),
                counted_at=_entry_time(e, count),
                entered_qty=e.entered_qty,
                entered_unit=e.entered_unit,
                counted_qty=format_qty_base(e.qty_base),
            )
            for e in entries[:-1]
        ],
    )
    inflow: int | None = None
    outflow: int | None = None
    if count.moment == AreaCountMoment.SPOT:
        ref_qty: int | None = hooks.current_stock(
            db, store_id=store.id, ingredient_id=ingredient.id, as_of=counted_at
        )
        null_reason = None
    elif reference is None:
        ref_qty, null_reason = None, reason
    elif ingredient.id not in reference_lines:
        ref_qty, null_reason = None, "No estaba en el conteo anterior de esta área"
    else:
        ref_line = reference_lines[ingredient.id]
        ref_qty, null_reason = ref_line.qty_base, None
        window_from = _entry_time(ref_line, reference)
        inflow = service._movement_sum(
            db, store_id=store.id, ingredient_id=ingredient.id, window_from=window_from,
            window_to=counted_at, positive=True, exclude_causes=_NOT_A_FLOW,
        )
        outflow = -service._movement_sum(
            db, store_id=store.id, ingredient_id=ingredient.id, window_from=window_from,
            window_to=counted_at, positive=False, exclude_causes=_NOT_A_FLOW,
        )

    if ref_qty is None:
        return AreaCountLineOut(
            **base,  # type: ignore[arg-type]
            reference_qty=None, inflow_qty=None, outflow_qty=None, expected_qty=None, shortage_qty=None,
            shortage_value=None, shortage_pct_bp=None, flagged=False, null_reason=null_reason,
        )

    expected = ref_qty + (inflow or 0) - (outflow or 0)
    shortage = expected - line.qty_base
    cost_micros, _source = hooks.resolve_ingredient_cost(db, ingredient)
    value = micros_to_pesos(line_cost_micros(shortage, cost_micros)) if cost_micros is not None else None
    pct = _pct_bp(shortage, expected)
    return AreaCountLineOut(
        **base,  # type: ignore[arg-type]
        reference_qty=format_qty_base(ref_qty),
        inflow_qty=format_qty_base(inflow) if inflow is not None else None,
        outflow_qty=format_qty_base(outflow) if outflow is not None else None,
        expected_qty=format_qty_base(expected),
        shortage_qty=format_qty_base(shortage),
        shortage_value=value,
        shortage_pct_bp=pct,
        flagged=_is_flagged(shortage=shortage, pct_bp=pct, value=value, limit_pct=limits[0], limit_amount=limits[1]),
        null_reason=None,
    )


def count_detail(db: Session, *, store: Store, count: AreaCount) -> AreaCountDetailOut:
    reference, reason = reference_for(db, count)
    reference_lines = (
        {ing_id: entries[-1] for ing_id, entries in _effective_lines(db, reference).items()}
        if reference is not None
        else {}
    )
    by_ingredient = _effective_lines(db, count)
    ingredients = _ingredients_by_id(db, list(by_ingredient))
    limits = thresholds(db, store)
    out_lines = [
        _line_result(
            db, store=store, count=count, entries=entries, ingredient=ingredients[ing_id], reference=reference,
            reference_lines=reference_lines, reason=reason, limits=limits,
        )
        for ing_id, entries in by_ingredient.items()
        if ing_id in ingredients
    ]
    people: list[str] = []
    for l in sorted(out_lines, key=lambda l: l.counted_at or count.counted_at):
        if l.employee_name and l.employee_name not in people:
            people.append(l.employee_name)
    last_at = max((l.counted_at for l in out_lines if l.counted_at is not None), default=count.counted_at)
    valued = [l.shortage_value for l in out_lines if l.shortage_value is not None]
    return AreaCountDetailOut(
        id=count.id,
        area_id=count.area_id,
        area_name=count.area_name,
        moment=count.moment.value,  # type: ignore[arg-type]
        window=_window(count),  # type: ignore[arg-type]
        counted_at=count.counted_at,
        business_date=count.business_date.isoformat(),
        employee_name=count.employee_name,
        reference_count_id=reference.id if reference is not None else None,
        reference_counted_at=reference.counted_at if reference is not None else None,
        reference_employee_name=reference.employee_name if reference is not None else None,
        reason=reason,
        superseded=_superseded(db, count),
        lines_count=len(out_lines),
        flagged_count=sum(1 for l in out_lines if l.flagged),
        shortage_value_total=sum(valued) if valued else None,
        unvalued_lines=sum(1 for l in out_lines if l.shortage_qty is not None and l.shortage_value is None),
        scope=count.scope,  # type: ignore[arg-type]
        people=people,
        last_counted_at=last_at,
        lines=out_lines,
    )


def count_summary(db: Session, *, store: Store, count: AreaCount) -> AreaCountOut:
    detail = count_detail(db, store=store, count=count)
    return AreaCountOut(**detail.model_dump(exclude={"lines"}))


def list_counts(
    db: Session, *, store: Store, date_from: date | None, date_to: date | None, area_id: int | None
) -> list[AreaCount]:
    stmt = select(AreaCount).where(AreaCount.store_id == store.id)
    if date_from is not None:
        stmt = stmt.where(AreaCount.business_date >= date_from)
    if date_to is not None:
        stmt = stmt.where(AreaCount.business_date <= date_to)
    if area_id is not None:
        stmt = stmt.where(AreaCount.area_id == area_id)
    return list(db.execute(stmt.order_by(AreaCount.counted_at.desc(), AreaCount.id.desc())).scalars().all())


# ---------------------------------------------------------------------------
# Hoy (lo publica `hooks.area_counts_today`).
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class AreaDone:
    count_id: int
    counted_at: datetime
    employee_name: str


@dataclass(frozen=True)
class AreaTodayStatus:
    """`opening`/`closing` en `None` = ese conteo NO está completo (algún
    artículo de la lista del día sin contar): Hoy lo pinta en rojo. Completo,
    `employee_name` nombra a todos los que contaron y `counted_at` es la hora
    del último artículo. Los `*_counted`/`*_total` dicen cuánto va."""

    area_id: int
    area_name: str
    opening: AreaDone | None
    closing: AreaDone | None
    opening_counted: int = 0
    opening_total: int = 0
    closing_counted: int = 0
    closing_total: int = 0
    # Hoy es el conteo completo mensual (la lista es todo lo del área).
    full_count: bool = False
    # La apertura es obligatoria y no está (y el cierre no empezó).
    opening_missing: bool = False


@dataclass(frozen=True)
class AreaCountFlag:
    count_id: int
    area_name: str
    window: str  # night | shift | spot
    ingredient_id: int
    ingredient_name: str
    base_unit: str
    shortage_qty: str
    shortage_value: int | None
    flagged: bool
    counted_at: datetime
    employee_name: str


@dataclass(frozen=True)
class AreaCountsToday:
    areas: list[AreaTodayStatus]
    flags: list[AreaCountFlag]
    pending_recounts: int


def _as_complete(count: AreaCount | None, progress: AreaCountProgressOut) -> AreaDone | None:
    """Hecho sólo si TODOS los artículos de la lista del día tienen conteo."""
    if count is None or not progress.complete or progress.completed_at is None:
        return None
    return AreaDone(count_id=count.id, counted_at=progress.completed_at, employee_name=", ".join(progress.people))


def today_summary(db: Session, *, store: Store) -> AreaCountsToday:
    """Qué áreas contaron hoy (apertura y cierre, el último de cada uno) y
    los artículos fuera del umbral, diciendo si fue de noche o en el turno;
    más todo recuento respondido hoy con su diferencia contra el sistema,
    esté o no fuera del umbral (lo pidió el dueño: quiere ver la respuesta)."""
    business_date = tz.today_business_date(store.cutoff_hour)
    areas: list[AreaTodayStatus] = []
    flags: list[AreaCountFlag] = []
    counts_to_read: list[AreaCount] = []
    for sheet_area in _sheet_areas(db, store=store, business_date=business_date, my_area_id=None):
        opening = _latest_count(
            db, area_id=sheet_area.area_id, moment=AreaCountMoment.OPENING, business_date=business_date
        )
        closing = _latest_count(
            db, area_id=sheet_area.area_id, moment=AreaCountMoment.CLOSING, business_date=business_date
        )
        areas.append(
            AreaTodayStatus(
                sheet_area.area_id,
                sheet_area.area_name,
                _as_complete(opening, sheet_area.opening),
                _as_complete(closing, sheet_area.closing),
                opening_counted=sheet_area.opening.counted,
                opening_total=sheet_area.opening.total,
                closing_counted=sheet_area.closing.counted,
                closing_total=sheet_area.closing.total,
                full_count=sheet_area.scope == "full",
                opening_missing=_opening_pending(sheet_area),
            )
        )
        counts_to_read.extend(c for c in (opening, closing) if c is not None)
    spots = db.execute(
        select(AreaCount)
        .where(
            AreaCount.store_id == store.id,
            AreaCount.moment == AreaCountMoment.SPOT,
            AreaCount.business_date == business_date,
        )
        .order_by(AreaCount.counted_at)
    ).scalars().all()
    counts_to_read.extend(spots)
    for count in counts_to_read:
        detail = count_detail(db, store=store, count=count)
        for line in detail.lines:
            if line.shortage_qty is None:
                continue
            if not line.flagged and count.moment != AreaCountMoment.SPOT:
                continue
            flags.append(
                AreaCountFlag(
                    count_id=count.id,
                    area_name=count.area_name,
                    window=detail.window,
                    ingredient_id=line.ingredient_id,
                    ingredient_name=line.ingredient_name,
                    base_unit=line.base_unit,
                    shortage_qty=line.shortage_qty,
                    shortage_value=line.shortage_value,
                    flagged=line.flagged,
                    counted_at=count.counted_at,
                    employee_name=count.employee_name,
                )
            )
    return AreaCountsToday(areas=areas, flags=flags, pending_recounts=pending_recounts_count(db, store_id=store.id))

