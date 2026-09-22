"""Meses de operación inventada, para ver el sistema con un restaurante vivo adentro.

    python -m app.demo_operacion --meses 6

`app.seed` deja el sistema **listo para operar**: la carta, el personal, la
configuración. Esto deja el sistema **operado**: turnos abiertos y cerrados,
comandas cobradas, plata que entró y salió del cajón, diferencias de arqueo con
su causa. Son dos cosas distintas y por eso son dos archivos distintos.

## Por qué pasa por los servicios y no por `INSERT`

Todo lo que este archivo escribe entra por `app.shifts.service`,
`app.orders.service` y `app.payments.service`, los mismos que usa el POS. Es
más lento que insertar filas y es la única forma de que los datos sean
**coherentes de verdad**: el esperado del cajón lo calcula el backend con su
única fórmula, el impuesto al consumo lo calcula el backend, el consecutivo
fiscal lo reserva el backend. Datos inventados a mano cuadran con lo que el
inventor creía que era la regla; éstos cuadran con la regla.

El costo de esa decisión ya se cobró una vez: el primer intento reventó con
`SHIFT_ALREADY_OPEN` porque la base tenía un turno abierto. Un `INSERT` no se
habría quejado, y la base habría quedado con dos turnos abiertos a la vez —
justo lo que el índice único parcial existe para impedir.

## Qué NO inventa

- **Nada de una persona real.** Los nombres del personal son inventados y el
  NIT, la resolución y los rangos siguen marcados como de desarrollo
  (`DEV-NO-ES-RESOLUCION-DIAN`). Esto no simula un restaurante que exista.
- **Ninguna regla de negocio.** Si un cierre no cuadra, cuadra mal porque el
  backend dice que está mal, no porque acá se haya elegido el número.

## El reloj

`app.core.clock.set_clock` mueve el tiempo. Es el mecanismo que los tests ya
usan; acá se usa para recorrer meses. Al terminar se restaura, siempre.
"""

from __future__ import annotations

import argparse
import random
import sys
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone
from typing import Any

from sqlalchemy import select
from sqlalchemy import text as sa_text
from sqlalchemy.orm import Session

from app.auth.deps import Actor
from app.auth.models import Employee
from app.catalog.models import (
    Category, Combo, ComboGroup, ComboOption, ModifierGroup, ModifierOption, Product,
)
from app.core import clock
from app.core.db import SessionLocal
from app.core.errors import AppError
from app.core.models_registry import import_all_models
from app.core.security import hash_secret
from app.expenses import service as expenses_service
from app.expenses.schemas import (
    ExpenseCategoryLiteral, ExpenseIn, ObligationCategoryLiteral, ObligationIn, ObligationSettleIn,
)
from app.fiscal.models import FiscalDocumentType, FiscalRange
from app.orders import service as orders_service
from app.orders.schemas import (
    AddItemsIn, Channel, ComboSelectionIn, ModifierSelectionIn, OrderCreateIn, OrderItemIn, TakeoutIn,
)
from app.payments import service as payments_service
from app.payments.schemas import PaymentIn, PaymentSplitIn, TipIn
from app.shifts import service as shifts_service
from app.shifts.schemas import (
    CashMovementIn,
    CashPickupIn,
    CloseCountIn,
    DenominationCountIn,
    DenominationIn,
    OpenShiftIn,
    RosterActionIn,
)
from app.stores.models import Store, Table

# ---------------------------------------------------------------------------
# El elenco
# ---------------------------------------------------------------------------

#: PIN por persona. Son de desarrollo, como los de `app.seed`, y este archivo
#: no los esconde: una base de demo con PIN secreto no la puede usar nadie.
PERSONAL: list[dict[str, Any]] = [
    {"nombre": "Marta Lucía Ospina", "rol": "admin", "pin": "9000", "cobra": False},
    {"nombre": "Jhon Fredy Zapata", "rol": "supervisor", "pin": "5001", "cobra": True},
    {"nombre": "Yuliana Restrepo", "rol": "operator", "pin": "6001", "cobra": True},
    {"nombre": "Édison Cardona", "rol": "operator", "pin": "6002", "cobra": True},
    {"nombre": "Katherine Arango", "rol": "operator", "pin": "6003", "cobra": False},
    {"nombre": "Brayan Salazar", "rol": "operator", "pin": "6004", "cobra": False},
    {"nombre": "Luisa Fernanda Muñoz", "rol": "operator", "pin": "6005", "cobra": False},
    {"nombre": "Rosalba Mejía", "rol": "operator", "pin": "6006", "cobra": False},
    {"nombre": "Wilson Tabares", "rol": "operator", "pin": "6007", "cobra": False},
]

# ---------------------------------------------------------------------------
# El pulso del negocio
# ---------------------------------------------------------------------------

#: Tiquetes de un día normal por día de semana (0 = lunes). El almuerzo manda:
#: es un restaurante de centro, con corrientazo y ejecutivo. El domingo es
#: almuerzo familiar y no abre de noche.
TIQUETES_POR_DIA = {0: 46, 1: 52, 2: 54, 3: 58, 4: 78, 5: 86, 6: 72}

#: Cómo se reparte el día entre almuerzo y cena. El domingo no tiene cena.
REPARTO_ALMUERZO = {0: 0.70, 1: 0.68, 2: 0.68, 3: 0.65, 4: 0.55, 5: 0.48, 6: 1.00}

#: Festivos colombianos que caen en el período simulado. Un festivo entre
#: semana en el centro es **menos** almuerzo de oficina, no más: las oficinas
#: están cerradas. Es al revés de lo que uno supondría, y por eso está escrito.
FESTIVOS_2026 = {
    date(2026, 1, 1), date(2026, 1, 12), date(2026, 3, 23), date(2026, 4, 2),
    date(2026, 4, 3), date(2026, 5, 1), date(2026, 5, 18), date(2026, 6, 8),
    date(2026, 6, 15), date(2026, 6, 29), date(2026, 7, 20), date(2026, 8, 7),
    date(2026, 8, 17), date(2026, 10, 12), date(2026, 11, 2), date(2026, 11, 16),
    date(2026, 12, 8), date(2026, 12, 25),
}

#: Causas de gasto menor del cajón, con su rango. Son los gastos que de verdad
#: salen del cajón de un restaurante, no categorías de manual.
GASTOS_MENORES = [
    ("Pipeta de gas", 45_000, 85_000),
    ("Hielo", 8_000, 16_000),
    ("Bolsas y servilletas", 12_000, 30_000),
    ("Domicilio de verduras", 10_000, 25_000),
    ("Taxi al mercado", 15_000, 32_000),
    ("Recarga de agua", 9_000, 14_000),
    ("Arreglo de la nevera", 60_000, 140_000),
]

#: Causas de diferencia identificada, con el texto que escribiría una persona.
NOTAS_DE_CAUSA = {
    "change_error": [
        "Se dio mal un cambio de 50.000 en la hora pico",
        "Cambio mal dado en la mesa 4, el cliente ya se había ido",
        "Faltó sencillo y se redondeó a favor del cliente",
    ],
    "expense_without_voucher": [
        "Se pagó la pipeta de gas sin registrar el egreso",
        "Compra de urgencia de hielo, sin recibo",
        "Se pagó el domicilio de las verduras y no se registró",
    ],
    "tips_mixed": [
        "Propinas en efectivo quedaron dentro del cajón",
        "El mesero dejó la propina en la caja y no se retiró",
    ],
    "unrecorded_sale": [
        "Una venta de mostrador se cobró sin comanda",
        "Se cobró un almuerzo sin pasarlo por el sistema",
    ],
    "counting_error": [
        "Error al contar los billetes de 10.000",
        "Se contó dos veces el paquete de 2.000",
        "Descuadre al recontar, no se encontró el origen",
    ],
    "unknown": [
        "No se identificó el origen",
        "Se recontó dos veces y no apareció",
    ],
}

DENOMINACIONES = [100_000, 50_000, 20_000, 10_000, 5_000, 2_000, 1_000, 500, 200, 100, 50]

#: La base fija, contada como la contaría alguien: mucha moneda y billete
#: chico, que es lo que sirve para dar cambio.
BASE_FIJA_DESGLOSE = [
    (20_000, 4), (10_000, 5), (5_000, 6), (2_000, 10),
    (1_000, 12), (500, 10), (200, 10), (100, 8), (50, 4),
]

FOTO = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg=="

BOGOTA_OFFSET = timedelta(hours=-5)


# ---------------------------------------------------------------------------
# Utilidades
# ---------------------------------------------------------------------------


def _utc(dia: date, hora: int, minuto: int = 0) -> datetime:
    """Un instante de hora local de Bogotá, en UTC. Bogotá no tiene horario de
    verano, así que el desfase es fijo y no hace falta `zoneinfo` acá."""
    local = datetime(dia.year, dia.month, dia.day, hora, minuto, tzinfo=timezone.utc)
    return local - BOGOTA_OFFSET


def _desglosar(total: int, rng: random.Random) -> DenominationCountIn:
    """Un desglose plausible de `total` en denominaciones colombianas.

    Greedy de mayor a menor, pero dejando a veces el billete grande sin usar:
    un cajón real no tiene el mínimo número de billetes posible. Lo único que
    el backend exige es que la suma cuadre, y eso se verifica acá antes de
    devolver — si no cuadrara, el error saldría del servicio con
    `DENOMINATIONS_MISMATCH` y sin decir de qué turno.
    """
    resto = total
    items: list[DenominationIn] = []
    for valor in DENOMINACIONES:
        if resto < valor:
            continue
        maximo = resto // valor
        # En los billetes grandes se usa a veces uno menos, y el resto baja en
        # billetes más chicos. En los menores a 1.000 se usa todo.
        cantidad = maximo if valor < 1_000 or maximo <= 1 else maximo - rng.randint(0, 1)
        if cantidad <= 0:
            continue
        items.append(DenominationIn(value=valor, count=cantidad))
        resto -= valor * cantidad
    if resto:  # imposible: 50 divide a todo peso redondeado; queda por si acaso
        raise ValueError(f"no se pudo desglosar {total}: sobra {resto}")
    suma = sum(i.value * i.count for i in items)
    assert suma == total, f"desglose {suma} != total {total}"
    return DenominationCountIn(denominations=items, total=total)


def _base_fija() -> DenominationCountIn:
    items = [DenominationIn(value=v, count=c) for v, c in BASE_FIJA_DESGLOSE]
    return DenominationCountIn(denominations=items, total=sum(v * c for v, c in BASE_FIJA_DESGLOSE))


@dataclass
class Carta:
    """La carta, agrupada por cómo se vende y no por cómo está catalogada."""

    corrientazo: Any = None
    ejecutivo: Any = None
    grupos_corrientazo: list[tuple[int, list[int]]] = field(default_factory=list)
    grupos_ejecutivo: list[tuple[int, list[int]]] = field(default_factory=list)
    #: `product_id -> [(min, max, required, [option_id, ...]), ...]`. La
    #: bandeja y el lomo tienen término de la carne OBLIGATORIO: pedirlos sin
    #: elegirlo es `MODIFIER_SELECTION_INVALID`, como en el POS de verdad.
    modificadores: dict[int, list[tuple[int, int, bool, list[int]]]] = field(default_factory=dict)
    fuertes: list[Product] = field(default_factory=list)
    entradas: list[Product] = field(default_factory=list)
    sopas: list[Product] = field(default_factory=list)
    bebidas: list[Product] = field(default_factory=list)
    postres: list[Product] = field(default_factory=list)


def _cargar_carta(db: Session, store_id: int) -> Carta:
    # Los modelos del catálogo no declaran relaciones ORM: son columnas y
    # `category_id` pelado. Se arma el índice a mano en vez de suponer un
    # `p.category` que no existe.
    categorias = {
        c.id: c.name
        for c in db.execute(select(Category).where(Category.store_id == store_id)).scalars().all()
    }
    productos = db.execute(
        select(Product).where(Product.store_id == store_id, Product.active.is_(True))
    ).scalars().all()
    por_categoria: dict[str, list[Product]] = {}
    for p in productos:
        por_categoria.setdefault(categorias.get(p.category_id, "?"), []).append(p)

    grupos_mod = db.execute(
        select(ModifierGroup).where(ModifierGroup.store_id == store_id).order_by(ModifierGroup.sort_order)
    ).scalars().all()
    modificadores: dict[int, list[tuple[int, int, bool, list[int]]]] = {}
    for g in grupos_mod:
        opciones = db.execute(
            select(ModifierOption.id).where(ModifierOption.modifier_group_id == g.id)
        ).scalars().all()
        if opciones:
            modificadores.setdefault(g.product_id, []).append((g.min, g.max, g.required, list(opciones)))

    combos = db.execute(select(Combo).where(Combo.store_id == store_id)).scalars().all()
    carta = Carta(
        fuertes=por_categoria.get("Platos Fuertes", []),
        entradas=por_categoria.get("Entradas", []),
        sopas=por_categoria.get("Sopas", []),
        bebidas=por_categoria.get("Bebidas", []),
        postres=por_categoria.get("Postres", []),
        modificadores=modificadores,
    )
    for c in combos:
        if "orrientazo" in c.name:
            carta.corrientazo = c
            carta.grupos_corrientazo = _grupos_de_combo(db, c.id)
        elif "jecutivo" in c.name:
            carta.ejecutivo = c
            carta.grupos_ejecutivo = _grupos_de_combo(db, c.id)
    if not carta.fuertes or not carta.bebidas:
        raise SystemExit(
            "La carta está vacía. Corré primero `python -m app.seed`: este archivo "
            "opera un restaurante, no lo funda."
        )
    return carta


def _grupos_de_combo(db: Session, combo_id: int) -> list[tuple[int, list[int]]]:
    """`[(group_id, [option_id, ...]), ...]` de un combo, en orden.

    Se consulta una vez por combo y se cachea en `Carta`: son dos combos y
    miles de comandas, y sin cache esto serían dos consultas por línea.
    """
    grupos = db.execute(
        select(ComboGroup).where(ComboGroup.combo_id == combo_id).order_by(ComboGroup.sort_order)
    ).scalars().all()
    salida = []
    for g in grupos:
        # Sólo las que el POS ofrecería: activas hoy y no agotadas.
        opciones = db.execute(
            select(ComboOption.id).where(
                ComboOption.combo_group_id == g.id,
                ComboOption.active_today.is_(True),
                ComboOption.available_today.is_(True),
            )
        ).scalars().all()
        if opciones:
            salida.append((g.id, list(opciones)))
    return salida


def _selecciones_de_combo(grupos: list[tuple[int, list[int]]], rng: random.Random) -> list[ComboSelectionIn]:
    """Una opción al azar por cada grupo del combo."""
    return [ComboSelectionIn(group_id=gid, option_id=rng.choice(opciones)) for gid, opciones in grupos]


def _combo_disponible(combo: Any, local: datetime) -> bool:
    """¿El combo se puede pedir a esta hora y este día?

    El corrientazo va de lunes a sábado, 11:30 a 15:00 — es el menú del día y
    tiene horario, como en cualquier restaurante. Pedirlo fuera de ahí lo
    rechaza `app.orders.service` con `COMBO_NOT_ACTIVE`, y con razón: el
    generador no puede inventar un almuerzo del día a las nueve de la noche.
    """
    horario = combo.schedule or {}
    dias = horario.get("days")
    if dias is not None and local.weekday() not in dias:
        return False
    desde, hasta = horario.get("from"), horario.get("to")
    minuto = local.hour * 60 + local.minute
    if desde and minuto < int(desde[:2]) * 60 + int(desde[3:5]):
        return False
    if hasta and minuto > int(hasta[:2]) * 60 + int(hasta[3:5]):
        return False
    return True


def _modificadores(carta: Carta, product_id: int, rng: random.Random) -> list[ModifierSelectionIn]:
    """Las selecciones de modificador de un producto.

    Los grupos obligatorios se llenan siempre (el `min` que pidan); los
    opcionales, a veces — que es de donde salen la papa criolla y el arroz
    extra, y por eso dos bandejas del mismo día no valen lo mismo.
    """
    salida: list[ModifierSelectionIn] = []
    for minimo, maximo, requerido, opciones in carta.modificadores.get(product_id, []):
        if requerido or minimo > 0:
            cuantas = max(1, minimo)
        elif rng.random() < 0.28:
            cuantas = 1
        else:
            continue
        cuantas = min(cuantas, maximo, len(opciones))
        for oid in rng.sample(opciones, k=cuantas):
            salida.append(ModifierSelectionIn(option_id=oid))
    return salida


# ---------------------------------------------------------------------------
# Preparación: elenco y rango histórico
# ---------------------------------------------------------------------------


def preparar_elenco(db: Session, store: Store) -> list[Employee]:
    """Le pone nombre y PIN propio a cada persona.

    El seed deja «Operador 1..4», que sirve para probar y no para mirar. Se
    reusan las filas que ya existen (no se borra a nadie: hay historia colgando
    de `employee_id`) y se agregan las que falten.
    """
    existentes = db.execute(
        select(Employee).where(Employee.organization_id == store.organization_id).order_by(Employee.id)
    ).scalars().all()

    for i, ficha in enumerate(PERSONAL):
        if i < len(existentes):
            emp = existentes[i]
        else:
            emp = Employee(
                organization_id=store.organization_id,
                store_id=store.id,
                name=ficha["nombre"],
                role=ficha["rol"],
                active=True,
                created_at=clock.now_utc(),
                updated_at=clock.now_utc(),
            )
            db.add(emp)
        emp.name = ficha["nombre"]
        emp.role = ficha["rol"]
        emp.can_charge = bool(ficha["cobra"])
        emp.pin_hash = hash_secret(ficha["pin"])
        emp.active = True
        # El admin conserva su correo y contraseña: es con lo que se entra.
    db.flush()
    db.commit()

    return list(
        db.execute(
            select(Employee).where(Employee.organization_id == store.organization_id).order_by(Employee.id)
        ).scalars().all()
    )


def asegurar_rango_historico(db: Session, store: Store, desde: date) -> None:
    """Un rango de numeración que cubra el período simulado.

    El que siembra `app.seed` empieza el día que se sembró: una venta de hace
    seis meses cae fuera de su vigencia y `reserve_next_number` la rechaza —
    con razón. Un restaurante que lleva seis meses abierto tuvo una resolución
    para esos seis meses, así que se crea.

    Sigue marcado `DEV-NO-ES-RESOLUCION-DIAN`: es numeración de desarrollo y
    tiene que seguir siendo evidente que lo es.
    """
    vigente = db.execute(
        select(FiscalRange).where(
            FiscalRange.store_id == store.id,
            FiscalRange.document_type == FiscalDocumentType.POS_EQUIVALENT,
            FiscalRange.prefix == "DEVPOSH",
        )
    ).scalar_one_or_none()
    if vigente is not None:
        return

    posterior = db.execute(
        select(FiscalRange).where(
            FiscalRange.store_id == store.id,
            FiscalRange.document_type == FiscalDocumentType.POS_EQUIVALENT,
            FiscalRange.prefix != "DEVPOSH",
        ).order_by(FiscalRange.valid_from)
    ).scalars().first()
    # El histórico termina justo antes de que empiece el que ya existía, para
    # que nunca haya dos vigentes al mismo tiempo compitiendo por el mismo
    # documento.
    hasta = (posterior.valid_from - timedelta(days=1)) if posterior else date.today()
    arranca = desde - timedelta(days=7)
    if arranca > hasta:
        # El período simulado cae entero dentro del rango que ya existe: no
        # hace falta historia. Sin este corte se intentaba crear un rango que
        # termina antes de empezar, y lo frenaba el CHECK de la base
        # (`ck_fiscal_ranges_valid_until_gte_from`) — la tabla se defiende
        # sola, que es como tiene que ser, pero el error no decía por qué.
        return

    db.add(
        FiscalRange(
            organization_id=store.organization_id,
            store_id=store.id,
            document_type=FiscalDocumentType.POS_EQUIVALENT,
            prefix="DEVPOSH",
            from_number=1,
            to_number=40_000,
            next_number=1,
            resolution_number="DEV-NO-ES-RESOLUCION-DIAN",
            resolution_date=arranca,
            valid_from=arranca,
            valid_until=hasta,
            created_at=_utc(arranca, 8),
        )
    )
    db.commit()


# ---------------------------------------------------------------------------
# Un turno
# ---------------------------------------------------------------------------


@dataclass
class Contexto:
    db: Session
    store: Store
    carta: Carta
    mesas: list[Table]
    personal: list[Employee]
    rng: random.Random
    reloj: dict[str, datetime]
    #: Racha deliberada: a partir de este día, **la misma persona** cierra tres
    #: turnos seguidos con diferencia distinta de cero, para que salte la
    #: alerta de racha. Tiene que ser la misma persona: `_check_difference_streak`
    #: mira los últimos `streak_alert_shifts` turnos DE ESE responsable, no los
    #: últimos de la sede. Una racha repartida entre tres cajeros no dispara
    #: nada, y la primera versión de esto la repartía.
    dia_de_racha: date | None = None
    racha_de: Employee | None = None
    racha_restante: int = 0

    def avanzar(self, minutos: int) -> None:
        self.reloj["t"] += timedelta(minutes=minutos)

    def fijar(self, instante: datetime) -> None:
        self.reloj["t"] = instante

    def actor(self, emp: Employee) -> Actor:
        return Actor(
            kind="device",
            organization_id=self.store.organization_id,
            store_id=self.store.id,
            employee_id=emp.id,
            employee_name=emp.name,
            role=emp.role,
        )

    def pin(self, emp: Employee) -> str:
        for ficha in PERSONAL:
            if ficha["nombre"] == emp.name:
                return str(ficha["pin"])
        raise KeyError(f"sin PIN para {emp.name}")


def _mezcla_de_medios(avance: float, rng: random.Random) -> str:
    """Efectivo / datáfono / transferencia, con la tendencia real del período.

    `avance` va de 0 (primer día) a 1 (último). El efectivo cae y la
    transferencia sube: es lo que está pasando en Colombia con Nequi y
    Daviplata, y hace que los reportes de medios tengan algo que contar en vez
    de una línea plana.
    """
    efectivo = 0.52 - 0.11 * avance
    tarjeta = 0.30 + 0.03 * avance
    x = rng.random()
    if x < efectivo:
        return "cash"
    if x < efectivo + tarjeta:
        return "card"
    return "transfer"


def _armar_comanda(ctx: Contexto, *, servicio: str, mesero: Employee) -> tuple[Any, list[OrderItemIn]]:
    """Decide canal, mesa y líneas. El almuerzo es corrientazo; la cena, carta."""
    rng = ctx.rng
    carta = ctx.carta

    x = rng.random()
    canal: Channel
    mesa_ids: list[int] | None
    if x < 0.70:
        canal, mesa_ids = "dine_in", [rng.choice(ctx.mesas).id]
    elif x < 0.88:
        canal, mesa_ids = "counter", None
    else:
        canal, mesa_ids = "takeout", None

    comensales = rng.choice([1, 2, 2, 2, 3, 4]) if canal == "dine_in" else None

    payload = OrderCreateIn(
        channel=canal,
        table_ids=mesa_ids,
        covers=comensales,
        takeout=(
            TakeoutIn(customer_name=rng.choice(
                ["Doña Carmen", "Sr. Gutiérrez", "Andrea", "Cliente mostrador",
                 "Camilo", "La señora del 3er piso", "Jorge", "Paola"]
            ))
            if canal == "takeout" else None
        ),
    )

    personas = comensales or 1
    lineas: list[OrderItemIn] = []
    local = clock.now_utc() + BOGOTA_OFFSET

    for _ in range(personas):
        if servicio == "almuerzo":
            y = rng.random()
            if (y < 0.45 and carta.corrientazo is not None
                    and _combo_disponible(carta.corrientazo, local)):
                lineas.append(OrderItemIn(combo_id=carta.corrientazo.id, qty=1,
                                          combo_selections=_selecciones_de_combo(carta.grupos_corrientazo, rng)))
                continue
            if (y < 0.60 and carta.ejecutivo is not None
                    and _combo_disponible(carta.ejecutivo, local)):
                lineas.append(OrderItemIn(combo_id=carta.ejecutivo.id, qty=1,
                                          combo_selections=_selecciones_de_combo(carta.grupos_ejecutivo, rng)))
                continue
        # Carta: un fuerte, y en la cena algo más de entrada y postre.
        fuerte = rng.choice(carta.fuertes)
        lineas.append(OrderItemIn(product_id=fuerte.id, qty=1,
                                  modifiers=_modificadores(carta, fuerte.id, rng)))
        if rng.random() < (0.30 if servicio == "cena" else 0.12) and carta.entradas:
            lineas.append(OrderItemIn(product_id=rng.choice(carta.entradas).id, qty=1))
        if rng.random() < (0.70 if servicio == "almuerzo" else 0.85) and carta.bebidas:
            lineas.append(OrderItemIn(product_id=rng.choice(carta.bebidas).id, qty=1))
        if rng.random() < (0.10 if servicio == "almuerzo" else 0.22) and carta.postres:
            lineas.append(OrderItemIn(product_id=rng.choice(carta.postres).id, qty=1))

    del mesero  # el mesero viaja en el actor, no en el payload
    return payload, lineas


def _cobrar(ctx: Contexto, orden: Any, cajero: Employee, avance: float, *, propina_en_efectivo: bool) -> tuple[str, int]:
    """Cobra la comanda. Devuelve el medio y cuánta propina entró."""
    rng = ctx.rng
    totales = orders_service.compute_order_totals(ctx.db, orden)
    metodo = _mezcla_de_medios(avance, rng)

    # Propina: se pregunta siempre y va pegada al medio de pago, como en el
    # datáfono. En EFECTIVO normalmente no se registra ninguna: la propina de
    # una mesa que paga en efectivo se queda en la mesa y nunca pasa por el
    # cajón. Registrarla en todos los turnos fabricaba un sobrante en todos
    # los cierres — `expected` no incluye la propina en efectivo
    # (`compute_breakdown`) pero el cajón sí la tendría — y un sobrante que
    # aparece siempre enseña a ignorar los sobrantes, que es justo lo que el
    # arqueo a ciegas existe para evitar.
    sugerida = round(totales.total * 0.10 / 100) * 100
    if metodo == "cash":
        acepta = propina_en_efectivo and rng.random() < 0.45
    else:
        acepta = rng.random() < 0.62
    modificada = acepta and rng.random() < 0.18
    monto_propina = 0
    if acepta:
        monto_propina = sugerida if not modificada else max(1_000, round(sugerida * rng.choice([0.5, 1.5, 2.0]) / 100) * 100)

    tendered = None
    if metodo == "cash":
        total_a_pagar = totales.total + monto_propina
        # Con cuánto paga: redondea hacia arriba a un billete cómodo.
        for billete in (10_000, 20_000, 50_000, 100_000):
            if billete >= total_a_pagar:
                tendered = billete
                break
        else:
            tendered = ((total_a_pagar // 50_000) + 1) * 50_000

    ctx.db.flush()
    payments_service.pay_order(
        ctx.db,
        actor=ctx.actor(cajero),
        store=ctx.store,
        shift=None,
        order=orden,
        payload=PaymentIn(
            expected_version=orden.version,
            pin=ctx.pin(cajero),
            tip=TipIn(asked=True, accepted=acepta, modified=modificada, amount=monto_propina),
            splits=[
                PaymentSplitIn(
                    method=metodo,
                    amount=totales.total + monto_propina,
                    tendered=tendered,
                    reference=f"NQ{ctx.rng.randint(100000, 999999)}" if metodo == "transfer" else None,
                )
            ],
        ),
        now=clock.now_utc(),
    )
    return metodo, monto_propina


def _elegir_diferencia(ctx: Contexto, propinas_efectivo: int, cajero: Employee) -> tuple[int, str | None, str | None]:
    """La diferencia del arqueo, su causa y su nota.

    **Una sola decisión, tomada al abrir el turno.** Si la propina en efectivo
    entró al cajón, el contado la incluye y el sistema la ve como sobrante:
    `expected` no la incluye (`compute_breakdown`) y el cajón sí la tiene. Eso
    no es un defecto del modelo — es exactamente lo que la causa `tips_mixed`
    existe para nombrar. Si no entró, no hay ni sobrante ni propina que
    retirar.

    La primera versión de este archivo hacía las dos cosas a la vez: declaraba
    propina retirada y a la vez elegía una diferencia de otra causa, y quedaban
    cierres donde el turno decía haber sacado 77.000 de propina con una
    diferencia de 10.000. Cuadraba en la base y no cuadraba en la vida.

    El resto se reparte así: la mayoría de los turnos cuadran exacto, unos
    pocos tienen un descuadre chico de causa desconocida, algunos pasan la
    tolerancia y exigen causa identificada, y muy de vez en cuando uno cruza
    el umbral crítico. Los faltantes son más frecuentes que los sobrantes,
    que es lo que pasa en un cajón de verdad.
    """
    rng = ctx.rng

    if propinas_efectivo > 0:
        # Al sobrante de la propina se le suma un descuadre chico propio: el
        # turno donde se mezclan las propinas rara vez es el turno prolijo.
        ruido = rng.randrange(-4_000, 4_000, 500)
        return propinas_efectivo + ruido, "tips_mixed", rng.choice(NOTAS_DE_CAUSA["tips_mixed"])

    if ctx.racha_restante > 0 and ctx.racha_de is not None and cajero.id == ctx.racha_de.id:
        ctx.racha_restante -= 1
        monto = -rng.randrange(2_000, 14_000, 500)
        causa = rng.choice(["counting_error", "change_error", "unknown"])
        return monto, causa, rng.choice(NOTAS_DE_CAUSA[causa])

    # El reparto está calibrado para que, sobre ~320 turnos, dé un puñado de
    # diferencias que exigen causa identificada y DOS O TRES críticas en seis
    # meses. La primera calibración daba 4,9 % de críticas, o sea ~18 alertas
    # críticas en el período: eso no es un restaurante con descuadres, es un
    # robo sostenido, y además rompe lo que la spec pide evitar — «una
    # diferencia que aparece todos los días enseña a ignorar las diferencias».
    x = rng.random()
    if x < 0.68:
        return 0, None, None
    if x < 0.92:
        monto = -rng.randrange(500, 18_000, 500) if rng.random() < 0.7 else rng.randrange(500, 14_000, 500)
        # Repartidas, no todas «error al contar»: un cajón descuadra por
        # muchas razones y un reporte donde siempre es la misma no enseña nada.
        causa = rng.choices(
            ["change_error", "counting_error", "unknown"], weights=[0.40, 0.33, 0.27]
        )[0]
        return monto, causa, rng.choice(NOTAS_DE_CAUSA[causa])
    if x < 0.99:
        monto = -rng.randrange(21_000, 70_000, 1_000) if rng.random() < 0.75 else rng.randrange(21_000, 55_000, 1_000)
        causa = rng.choice(["change_error", "expense_without_voucher", "unrecorded_sale", "counting_error"])
        return monto, causa, rng.choice(NOTAS_DE_CAUSA[causa])
    monto = -rng.randrange(100_000, 185_000, 5_000)
    causa = rng.choice(["unrecorded_sale", "expense_without_voucher"])
    return monto, causa, rng.choice(NOTAS_DE_CAUSA[causa])


def simular_turno(
    ctx: Contexto,
    *,
    dia: date,
    servicio: str,
    tiquetes: int,
    cierra_dia: bool,
    avance: float,
) -> dict[str, Any]:
    """Un turno de caja completo: apertura, servicio, movimientos y cierre."""
    db, rng = ctx.db, ctx.rng
    admin = next(e for e in ctx.personal if e.role == "admin")
    # Orden deliberado: primero los operadores de caja (Yuliana el almuerzo,
    # Édison la cena) y al final el supervisor, que cubre cuando falta alguno.
    # Sin este orden el supervisor terminaba siendo el cajero de planta, que
    # es justo lo que no hace un supervisor.
    cajeros = (
        [e for e in ctx.personal if e.can_charge and e.role == "operator"]
        + [e for e in ctx.personal if e.can_charge and e.role == "supervisor"]
    )
    meseros = [e for e in ctx.personal if not e.can_charge and e.role == "operator"]

    # Yuliana cubre el almuerzo, Édison la cena; el supervisor entra cuando
    # falta alguno. Un restaurante tiene turnos, no sorteos.
    if servicio == "almuerzo":
        cajero = cajeros[0] if rng.random() < 0.85 else rng.choice(cajeros)
        apertura, primera_venta, ultima_venta, cierre = 10, 11, 15, 16
    else:
        cajero = cajeros[1] if len(cajeros) > 1 and rng.random() < 0.85 else cajeros[0]
        apertura, primera_venta, ultima_venta, cierre = 16, 17, 22, 22

    if cierra_dia and servicio == "almuerzo":
        ultima_venta, cierre = 16, 17  # domingo: almuerzo largo y se cierra el día

    ctx.fijar(_utc(dia, apertura, rng.randint(30, 55)))
    turno = shifts_service.open_shift(
        db,
        actor=ctx.actor(cajero),
        store=ctx.store,
        payload=OpenShiftIn(opening_cash=_base_fija(), cash_responsible_id=cajero.id),
    )
    db.commit()

    # Quién trabaja este turno: el cajero más dos o tres de salón/cocina.
    equipo = rng.sample(meseros, k=min(len(meseros), rng.choice([2, 3, 3])))
    for emp in equipo:
        try:
            shifts_service.roster_action(
                db, actor=ctx.actor(cajero), shift=turno,
                # Cada quien marca con SU PIN: entrar al roster es
                # identificarse, no que el cajero los liste.
                payload=RosterActionIn(employee_id=emp.id, action="in", pin=ctx.pin(emp)),
            )
        except AppError:
            pass
    db.commit()

    # ---- el servicio -------------------------------------------------------
    inicio = _utc(dia, primera_venta, 0)
    fin = _utc(dia, ultima_venta, 0)
    minutos_totales = max(1, int((fin - inicio).total_seconds() // 60))
    # ¿Las propinas en efectivo de este turno terminan en el cajón? Es la
    # excepción, no la regla, y se decide UNA vez para todo el turno.
    propina_al_cajon = rng.random() < 0.07
    propinas_efectivo = 0
    cobradas = 0

    for n in range(tiquetes):
        # Las comandas no se reparten parejo: hay pico. Una beta cargada al
        # principio del servicio imita la hora del almuerzo.
        posicion = rng.betavariate(2.0, 2.6) if servicio == "almuerzo" else rng.betavariate(2.2, 2.0)
        ctx.fijar(inicio + timedelta(minutes=int(posicion * minutos_totales)))

        mesero = rng.choice(equipo) if equipo else cajero
        payload, lineas = _armar_comanda(ctx, servicio=servicio, mesero=mesero)
        try:
            orden = orders_service.create_order(db, actor=ctx.actor(mesero), store=ctx.store, payload=payload)
            db.flush()
            orden = orders_service.add_items(
                db, order=orden, actor=ctx.actor(mesero),
                payload=AddItemsIn(expected_version=orden.version, items=lineas),
            )
            db.flush()
            ctx.avanzar(rng.randint(8, 35))  # comen
            metodo_usado, propina_cobrada = _cobrar(
                ctx, orden, cajero, avance, propina_en_efectivo=propina_al_cajon
            )
            db.commit()
        except AppError as exc:
            db.rollback()
            print(f"    · comanda {n} descartada ({exc.code}: {exc.message})", file=sys.stderr)
            continue

        cobradas += 1
        if metodo_usado == "cash":
            propinas_efectivo += propina_cobrada

        # Gasto menor del cajón, de vez en cuando.
        if rng.random() < 0.035:
            concepto, minimo, maximo = rng.choice(GASTOS_MENORES)
            monto = rng.randrange(minimo, maximo, 1_000)
            quien = cajero if monto <= 50_000 else admin
            try:
                shifts_service.create_cash_movement(
                    db, actor=ctx.actor(quien), shift=turno, store=ctx.store,
                    # `note` y `receipt_photo`, no `reason` y `photo`.
                    # Pydantic ignora los nombres que no existen SIN AVISAR, y
                    # la primera versión de esto dejó todos los movimientos sin
                    # motivo y sin soporte — que es exactamente el dato inútil
                    # que este producto existe para evitar. Lo encontró mypy,
                    # no la corrida: la corrida pasó feliz.
                    payload=CashMovementIn(
                        kind="expense", cause="petty_expense", amount=monto,
                        note=concepto, receipt_photo=FOTO,
                        authorizer_pin=ctx.pin(admin) if monto > 50_000 else None,
                    ),
                )
                db.commit()
            except AppError:
                db.rollback()

        # Retiro a caja fuerte cuando el cajón se pone pesado.
        if cobradas % 25 == 0:
            desglose = shifts_service.compute_breakdown(db, turno)
            if desglose["expected"] > 520_000:
                monto = (desglose["expected"] - 250_000) // 10_000 * 10_000
                if monto > 0:
                    try:
                        shifts_service.create_pickup(
                            db, actor=ctx.actor(admin), shift=turno, store=ctx.store,
                            payload=CashPickupIn(
                                amount=monto, photo=FOTO,
                                envelope_ref=f"S{dia:%m%d}-{rng.randint(1, 9)}",
                                denominations=_desglosar(monto, rng).denominations,
                                authorizer_pin=ctx.pin(admin),
                                note="Retiro a caja fuerte",
                            ),
                        )
                        db.commit()
                    except AppError:
                        db.rollback()

    # ---- el cierre ---------------------------------------------------------
    ctx.fijar(_utc(dia, cierre, rng.randint(10, 50)))

    if ctx.dia_de_racha is not None and dia == ctx.dia_de_racha and ctx.racha_de is None:
        ctx.racha_de, ctx.racha_restante = cajero, 3
    diferencia, causa, nota = _elegir_diferencia(ctx, propinas_efectivo, cajero)

    desglose = shifts_service.compute_breakdown(db, turno)
    ventas = shifts_service.hooks.get_sales_totals(db, turno.id)
    contado = max(0, desglose["expected"] + diferencia)

    # El datáfono y las transferencias se cuentan casi siempre bien: el lote
    # lo imprime la máquina. De vez en cuando alguien teclea mal.
    contado_tarjeta = ventas.card + ventas.tips_card
    contado_transf = ventas.transfer + ventas.tips_transfer
    if contado_tarjeta and rng.random() < 0.04:
        contado_tarjeta += rng.choice([-10_000, -1_000, 1_000, 10_000])

    count = shifts_service.create_close_count(
        db, actor=ctx.actor(cajero), shift=turno, store=ctx.store,
        payload=CloseCountIn(
            counted_cash=_desglosar(contado, rng),
            counted_card=contado_tarjeta if ventas.card else None,
            counted_transfer=contado_transf if ventas.transfer else None,
            tips_cash_out=propinas_efectivo,
            photo=FOTO,
        ),
    )
    db.commit()

    revision = shifts_service.review_close(db, shift=turno, store=ctx.store, count=count)
    resultado = shifts_service.confirm_close(
        db, actor=ctx.actor(cajero), shift=turno, store=ctx.store, count=count,
        difference_seen=revision["difference"], cause=causa, note=nota,
        closes_day=cierra_dia, transfer_open_orders=True,
    )
    db.commit()

    return {
        "turno": turno.id,
        "tiquetes": cobradas,
        "esperado": revision["expected"],
        "diferencia": revision["difference"],
        "causa": causa,
    }


# ---------------------------------------------------------------------------
# El mes del administrador
# ---------------------------------------------------------------------------

#: Lo fijo de cada mes: qué se debe, cuánto y qué día vence. El arriendo y los
#: servicios son OBLIGACIONES (plata que todavía no salió pero vence); lo demás
#: son GASTOS (plata que ya salió). Son dos cosas distintas y el sistema las
#: separa en dos pestañas, así que acá se siembran por separado.
OBLIGACIONES_DEL_MES: list[tuple[ObligationCategoryLiteral, str, int, int, int]] = [
    ("rent", "Arriendo del local", 4_200_000, 4_200_000, 5),
    ("utilities", "Energía (EPM)", 1_450_000, 2_100_000, 15),
    ("utilities", "Acueducto y aseo", 320_000, 480_000, 17),
    ("utilities", "Gas natural", 180_000, 290_000, 18),
    ("other", "Honorarios del contador", 650_000, 650_000, 10),
    ("other", "Internet y telefonía", 179_900, 179_900, 12),
]

#: Gastos sueltos del mes, que no vencen: se pagan y ya.
GASTOS_DEL_MES: list[tuple[ExpenseCategoryLiteral, str, int, int, float]] = [
    ("supplies", "Compra de desechables y aseo", 280_000, 520_000, 0.9),
    ("supplies", "Uniformes y delantales", 180_000, 340_000, 0.2),
    ("maintenance", "Mantenimiento de la campana extractora", 250_000, 420_000, 0.35),
    ("maintenance", "Fumigación", 190_000, 260_000, 0.34),
    ("marketing", "Pauta en redes", 150_000, 400_000, 0.55),
    ("marketing", "Impresión de cartas y volantes", 120_000, 260_000, 0.25),
    ("transport", "Transporte de mercado de plaza", 90_000, 180_000, 0.8),
]


def simular_mes_administrativo(ctx: Contexto, *, mes: date, hasta: date, ultimo_mes: bool) -> None:
    """Lo que el administrador registra una vez al mes, no en la caja.

    El arriendo y los servicios entran como **obligaciones** y se saldan cerca
    del vencimiento; el último mes se deja con algunas sin saldar, porque un
    administrador que abre el sistema y no tiene nada pendiente no tiene por
    qué abrirlo. Es lo que le da contenido a «Requiere tu atención».

    Nada se fecha después de `hasta`: un gasto registrado pasado mañana es
    plata del futuro, y aparecía —el primer intento dejó un transporte el 23
    en una corrida que terminaba el 20—.
    """
    db, rng = ctx.db, ctx.rng
    admin = next(e for e in ctx.personal if e.role == "admin")
    actor = ctx.actor(admin)

    for categoria, descripcion, minimo, maximo, dia_de_vencimiento in OBLIGACIONES_DEL_MES:
        monto = minimo if minimo == maximo else rng.randrange(minimo, maximo, 10_000)
        vence = mes.replace(day=min(dia_de_vencimiento, 28))
        if vence > hasta + timedelta(days=30):
            continue
        ctx.fijar(_utc(min(mes, hasta), 9, rng.randint(0, 59)))
        try:
            obligacion = expenses_service.create_obligation(
                db, actor=actor, store=ctx.store,
                payload=ObligationIn(category=categoria, description=descripcion,
                                     amount=monto, due_date=vence),
            )
            db.commit()
        except AppError:
            db.rollback()
            continue

        # El último mes queda a medio pagar: es el mes en curso.
        if ultimo_mes and rng.random() < 0.55:
            continue
        # Casi siempre se paga a tiempo; a veces un par de días tarde.
        pagado = min(vence + timedelta(days=rng.choice([-2, -1, 0, 0, 1, 3])), hasta)
        ctx.fijar(_utc(pagado, 11, rng.randint(0, 59)))
        try:
            expenses_service.settle_obligation(
                db, actor=actor, obligation=obligacion,
                payload=ObligationSettleIn(source="bank", note=f"Transferencia {pagado:%d/%m}"),
            )
            db.commit()
        except AppError:
            db.rollback()

    for rubro, descripcion, minimo, maximo, probabilidad in GASTOS_DEL_MES:
        if rng.random() > probabilidad:
            continue
        cuando = min(mes.replace(day=rng.randint(2, 26)), hasta)
        ctx.fijar(_utc(cuando, 10, rng.randint(0, 59)))
        try:
            expenses_service.create_expense(
                db, actor=actor, store=ctx.store,
                payload=ExpenseIn(category=rubro, description=descripcion,
                                  amount=rng.randrange(minimo, maximo, 10_000),
                                  business_date=cuando, source="bank"),
            )
            db.commit()
        except AppError:
            db.rollback()


# ---------------------------------------------------------------------------
# El recorrido
# ---------------------------------------------------------------------------


def _tiquetes_del_dia(dia: date, avance: float, rng: random.Random) -> int:
    base = TIQUETES_POR_DIA[dia.weekday()]
    # El negocio crece: seis meses después vende ~18 % más que el primer día.
    factor = 1.0 + 0.18 * avance
    if dia in FESTIVOS_2026:
        factor *= 0.62 if dia.weekday() < 5 else 0.9
    if dia.month == 12 and dia.day >= 8:
        factor *= 1.30  # novenas y cenas de empresa
    if dia.month == 1 and dia.day <= 20:
        factor *= 0.78  # la cuesta de enero
    if rng.random() < 0.12:
        factor *= 0.88  # aguacero
    return max(8, int(base * factor * rng.uniform(0.88, 1.12)))


def generar(db: Session, *, meses: float, semilla: int) -> None:
    rng = random.Random(semilla)
    store = db.execute(select(Store).order_by(Store.id)).scalars().first()
    if store is None:
        raise SystemExit("No hay sede. Corré primero `python -m app.seed`.")

    hoy = datetime.now(timezone.utc).astimezone(timezone(BOGOTA_OFFSET)).date()
    desde = hoy - timedelta(days=int(meses * 30.4))
    hasta = hoy - timedelta(days=1)  # el día de hoy se deja sin operar

    # Un commit por comanda con `synchronous=FULL` es un fsync por comanda, y
    # son más de doce mil comandas: así tardaba ~100 minutos, casi todo
    # esperando al disco. Bajarlo es seguro acá y sólo acá — esto genera una
    # base de desarrollo desechable, no opera una caja de verdad; si el
    # proceso muere a la mitad, la respuesta es volver a sembrar y correrlo de
    # nuevo, que es lo que uno hace igual.
    if db.bind is not None and db.bind.dialect.name == "sqlite":
        db.execute(sa_text("PRAGMA synchronous = OFF"))
        db.execute(sa_text("PRAGMA journal_mode = WAL"))
        db.commit()

    reloj: dict[str, datetime] = {"t": _utc(desde, 8)}
    clock.set_clock(lambda: reloj["t"])
    try:
        personal = preparar_elenco(db, store)
        asegurar_rango_historico(db, store, desde)
        carta = _cargar_carta(db, store.id)
        mesas = list(
            db.execute(
                select(Table).where(Table.store_id == store.id, Table.active.is_(True))
            ).scalars().all()
        )

        ctx = Contexto(
            db=db, store=store, carta=carta, mesas=mesas, personal=personal,
            rng=rng, reloj=reloj,
            # Una semana cualquiera del tercer mes: tres cierres seguidos con
            # diferencia, para que la alerta de racha tenga de qué hablar.
            dia_de_racha=desde + timedelta(days=int((hasta - desde).days * 0.55)),
        )

        total_dias = (hasta - desde).days + 1
        turnos = tiquetes = 0
        dia = desde
        while dia <= hasta:
            avance = ((dia - desde).days) / max(1, total_dias - 1)
            del_dia = _tiquetes_del_dia(dia, avance, rng)
            reparto = REPARTO_ALMUERZO[dia.weekday()]
            almuerzo = max(4, int(del_dia * reparto))
            cena = del_dia - almuerzo

            hay_cena = cena >= 6
            r = simular_turno(ctx, dia=dia, servicio="almuerzo", tiquetes=almuerzo,
                              cierra_dia=not hay_cena, avance=avance)
            turnos += 1
            tiquetes += r["tiquetes"]
            if hay_cena:
                r = simular_turno(ctx, dia=dia, servicio="cena", tiquetes=cena,
                                  cierra_dia=True, avance=avance)
                turnos += 1
                tiquetes += r["tiquetes"]

            if dia.day == 1 or dia == desde:
                simular_mes_administrativo(
                    ctx, mes=dia.replace(day=1), hasta=hasta,
                    ultimo_mes=(dia.year, dia.month) == (hasta.year, hasta.month),
                )

            if dia.day == 1 or dia == hasta:
                print(f"  {dia:%Y-%m-%d}  turnos={turnos:4d}  tiquetes={tiquetes:6d}", flush=True)
            dia += timedelta(days=1)

        print(f"\nListo: {turnos} turnos y {tiquetes} tiquetes entre {desde} y {hasta}.")
    finally:
        clock.set_clock(None)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--meses", type=float, default=6, help="meses de operación hacia atrás (default: 6)")
    parser.add_argument("--semilla", type=int, default=20260921,
                        help="semilla del azar: la misma semilla da el mismo restaurante")
    args = parser.parse_args()

    import_all_models()
    db = SessionLocal()
    try:
        generar(db, meses=args.meses, semilla=args.semilla)
    finally:
        db.close()


if __name__ == "__main__":
    main()
