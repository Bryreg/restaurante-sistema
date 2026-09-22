"""Operación simulada de demostración. Se corre a mano, DESPUÉS del seed:

    python -m app.seed
    python -m app.demo            # 14 días de operación
    python -m app.demo --days 21

Qué hace: deja la sede sembrada como si llevara semanas funcionando —
personal con nombre, proveedores, ~50 insumos con precios de plaza de
Bogotá, fichas técnicas de toda la carta (recetas tradicionales), compras
con factura y lote, cuentas por pagar pagadas, y N días de operación con
turnos, comandas de todos los canales, cocina, cobros con propina, clientes
que piden factura, anulaciones, descuentos, mermas, producción de
preparaciones, retiros, cierres con diferencia, conteos, gastos, nómina,
consignaciones y conciliación de datáfono.

**Por qué entra por HTTP y no por ORM, a diferencia del seed**: el objetivo es
ver el sistema funcionando, y eso sólo cuenta si cada dato pasa por la misma
validación que pasaría en el restaurante. Cada respuesta que no es 2xx se
anota en el informe final como hallazgo (no se traga ni se reintenta a
ciegas): «el simulador lo intentó por la puerta real y la puerta dijo X».

**El reloj**: los días se simulan en el pasado moviendo `app.core.clock`
(la única fuente de tiempo del sistema). La expiración del JWT la valida
PyJWT contra el reloj de pared, no contra `clock`, así que en ESTE proceso —
sólo acá— `read_token` se reemplaza por uno que valida `exp` contra
`clock.now_utc()`. El servidor de verdad no se toca.

Nada de esto es real: proveedores, NIT, clientes y cédulas son ficticios; los
rangos de numeración son los de desarrollo del seed (resolución FALSA).
"""

from __future__ import annotations

import argparse
import random
import sys
import uuid
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone
from typing import Any

import jwt
from fastapi.testclient import TestClient

from app.core import clock, security
from app.core.config import settings

BOGOTA = timezone(timedelta(hours=-5))
STORE_PIN = "123456"
ADMIN = ("admin@demo.local", "cambiar")
ADMIN_PIN = "9000"
SUPERVISOR_PIN = "5001"

# ---------------------------------------------------------------------------
# Datos del restaurante (ficticios, con precios de plaza de Bogotá 2026).
# ---------------------------------------------------------------------------

STAFF = [
    # nombre, rol, pin, can_charge, área, salario por hora
    ("Luz Marina Gómez", "operator", "7001", True, "caja", 8_200),
    ("Andrés Felipe Rojas", "operator", "7002", False, "salón", 7_600),
    ("Yuliana Pérez Ríos", "operator", "7003", False, "salón", 7_600),
    ("Jhon Jairo Cárdenas", "operator", "7004", False, "cocina", 9_000),
    ("Rosa Elena Méndez", "operator", "7005", False, "cocina", 8_600),
    ("Brayan Estiven Mora", "operator", "7006", False, "domicilios", 7_300),
]

SUPPLIERS = [
    # nombre, nit, plazo días, contacto, teléfono, exige factura
    ("Frigorífico El Llano SAS", "901000111", 15, "Hernán Quintero", "3104567890", True),
    ("Fruver La Cosecha", "901000222", 0, "Marleny Sáenz", "3157778899", False),
    ("Mayorista El Surtidor", "901000333", 30, "Óscar Pardo", "3009991122", True),
    ("Lácteos San Fernando", "901000444", 8, "Diana Lozano", "3112223344", True),
    ("Pescadería Pacífico Azul", "901000555", 8, "Wilson Angulo", "3186665544", True),
    ("Distribuidora Andina de Bebidas", "901000666", 30, "Camilo Vargas", "3201112233", True),
]

# nombre, categoría, unidad base, unidad compra, factor, rendimiento %,
# costo por unidad base (texto, pesos), proveedor, stock mínimo, perecedero,
# crítico, sin receta.
INGREDIENTS: list[tuple[str, str, str, str, int, int, str, str, str, bool, bool, bool]] = [
    # Proteínas
    ("Carne molida de res", "Proteínas", "g", "kg", 1000, 100, "27", "Frigorífico El Llano SAS", "4000", True, True, False),
    ("Tocino barriga de cerdo", "Proteínas", "g", "kg", 1000, 100, "23", "Frigorífico El Llano SAS", "3000", True, True, False),
    ("Chorizo antioqueño", "Proteínas", "unit", "paquete x10", 10, 100, "2600", "Frigorífico El Llano SAS", "20", True, False, False),
    ("Lomo de res", "Proteínas", "g", "kg", 1000, 90, "46", "Frigorífico El Llano SAS", "3000", True, True, False),
    ("Gallina criolla", "Proteínas", "g", "kg", 1000, 75, "16", "Frigorífico El Llano SAS", "4000", True, True, False),
    ("Garra de cerdo", "Proteínas", "g", "kg", 1000, 85, "11", "Frigorífico El Llano SAS", "2000", True, False, False),
    ("Costilla de res", "Proteínas", "g", "kg", 1000, 80, "19", "Frigorífico El Llano SAS", "2000", True, False, False),
    ("Mojarra roja entera", "Pescados", "unit", "unit", 1, 100, "11500", "Pescadería Pacífico Azul", "10", True, True, False),
    ("Camarón precocido", "Pescados", "g", "kg", 1000, 100, "58", "Pescadería Pacífico Azul", "1500", True, True, False),
    ("Huevo AA", "Proteínas", "unit", "cubeta x30", 30, 100, "560", "Mayorista El Surtidor", "60", True, False, False),
    # Fruver
    ("Papa sabanera", "Verduras", "g", "kg", 1000, 85, "2.4", "Fruver La Cosecha", "8000", True, False, False),
    ("Papa pastusa", "Verduras", "g", "kg", 1000, 85, "2.1", "Fruver La Cosecha", "8000", True, False, False),
    ("Plátano verde", "Verduras", "unit", "unit", 1, 100, "1200", "Fruver La Cosecha", "30", True, False, False),
    ("Plátano maduro", "Verduras", "unit", "unit", 1, 100, "1300", "Fruver La Cosecha", "20", True, False, False),
    ("Yuca", "Verduras", "g", "kg", 1000, 80, "2.6", "Fruver La Cosecha", "5000", True, False, False),
    ("Mazorca tierna", "Verduras", "unit", "unit", 1, 100, "1500", "Fruver La Cosecha", "20", True, False, False),
    ("Tomate chonto", "Verduras", "g", "kg", 1000, 95, "4.2", "Fruver La Cosecha", "5000", True, False, False),
    ("Cebolla larga", "Verduras", "g", "kg", 1000, 85, "3.6", "Fruver La Cosecha", "3000", True, False, False),
    ("Cebolla cabezona", "Verduras", "g", "kg", 1000, 90, "3.2", "Fruver La Cosecha", "3000", True, False, False),
    ("Ajo", "Verduras", "g", "kg", 1000, 85, "14", "Fruver La Cosecha", "500", False, False, False),
    ("Cilantro", "Verduras", "g", "kg", 1000, 80, "9", "Fruver La Cosecha", "500", True, False, False),
    ("Guascas", "Verduras", "g", "kg", 1000, 90, "22", "Fruver La Cosecha", "200", True, False, False),
    ("Aguacate hass", "Frutas", "unit", "unit", 1, 100, "2600", "Fruver La Cosecha", "30", True, True, False),
    ("Mango tommy", "Frutas", "g", "kg", 1000, 70, "4.5", "Fruver La Cosecha", "4000", True, False, False),
    ("Arveja desgranada", "Verduras", "g", "kg", 1000, 100, "8.5", "Fruver La Cosecha", "1000", True, False, False),
    ("Zanahoria", "Verduras", "g", "kg", 1000, 90, "2.6", "Fruver La Cosecha", "2000", True, False, False),
    ("Lechuga batavia", "Verduras", "g", "kg", 1000, 75, "5", "Fruver La Cosecha", "1000", True, False, False),
    ("Guineo verde", "Verduras", "unit", "unit", 1, 100, "600", "Fruver La Cosecha", "30", True, False, False),
    # Abarrotes
    ("Frijol cargamanto", "Abarrotes", "g", "kg", 1000, 100, "9.8", "Mayorista El Surtidor", "5000", False, False, False),
    ("Lenteja", "Abarrotes", "g", "kg", 1000, 100, "6.2", "Mayorista El Surtidor", "3000", False, False, False),
    ("Aceite vegetal", "Abarrotes", "ml", "garrafa 3L", 3000, 100, "8.3", "Mayorista El Surtidor", "6000", False, False, False),
    ("Harina de maíz precocida", "Abarrotes", "g", "kg", 1000, 100, "5.6", "Mayorista El Surtidor", "3000", False, False, False),
    ("Azúcar", "Abarrotes", "g", "kg", 1000, 100, "3.9", "Mayorista El Surtidor", "3000", False, False, False),
    ("Alcaparras", "Abarrotes", "g", "frasco 500g", 500, 100, "32", "Mayorista El Surtidor", "300", False, False, False),
    ("Café molido", "Abarrotes", "g", "libra", 500, 100, "36", "Mayorista El Surtidor", "500", False, False, False),
    ("Crema de coco", "Abarrotes", "ml", "lata 400ml", 400, 100, "31", "Mayorista El Surtidor", "2000", False, False, False),
    ("Leche condensada", "Abarrotes", "g", "lata 395g", 395, 100, "19", "Mayorista El Surtidor", "1000", False, False, False),
    ("Comino y color", "Abarrotes", "g", "kg", 1000, 100, "38", "Mayorista El Surtidor", "200", False, False, True),
    # Lácteos
    ("Crema de leche", "Lácteos", "ml", "litro", 1000, 100, "14", "Lácteos San Fernando", "2000", True, False, False),
    ("Queso campesino", "Lácteos", "g", "kg", 1000, 100, "22", "Lácteos San Fernando", "1500", True, False, False),
    ("Mantequilla", "Lácteos", "g", "kg", 1000, 100, "30", "Lácteos San Fernando", "500", True, False, False),
    # Bebidas
    ("Cerveza Águila 330ml", "Bebidas", "unit", "canasta x30", 30, 100, "2900", "Distribuidora Andina de Bebidas", "48", False, True, False),
]

# Insumos que ya trae el seed y que el simulador sólo liga a su proveedor.
SEED_INGREDIENT_SUPPLIER = {
    "Pechuga de pollo": "Frigorífico El Llano SAS",
    "Pollo en pechuga": "Frigorífico El Llano SAS",
    "Papa criolla": "Fruver La Cosecha",
    "Limón": "Fruver La Cosecha",
    "Arroz blanco": "Mayorista El Surtidor",
    "Arroz": "Mayorista El Surtidor",
    "Panela": "Mayorista El Surtidor",
    "Leche entera": "Lácteos San Fernando",
    "Leche deslactosada": "Lácteos San Fernando",
    "Gaseosa 400ml (botella)": "Distribuidora Andina de Bebidas",
    "Sal de mesa": "Mayorista El Surtidor",
    "Sal": "Mayorista El Surtidor",
}

# Preparaciones: nombre, modo, rinde (qty, unidad), merma de proceso %, vida
# útil (días), líneas (insumo o «@preparación», qty, unidad).
PREPARATIONS: list[tuple[str, str, str, str, int, int, list[tuple[str, str, str]]]] = [
    ("Hogao", "exploded", "1000", "g", 10, 2, [
        ("Tomate chonto", "650", "g"), ("Cebolla larga", "350", "g"), ("Aceite vegetal", "60", "ml"),
        ("Ajo", "15", "g"),
    ]),
    ("Frijoles cocidos", "batch", "3000", "g", 0, 3, [
        ("Frijol cargamanto", "1000", "g"), ("Zanahoria", "150", "g"), ("Plátano verde", "1", "unit"),
        ("@Hogao", "150", "g"),
    ]),
    ("Arroz blanco cocido", "batch", "2500", "g", 0, 1, [
        ("Arroz blanco", "1000", "g"), ("Aceite vegetal", "40", "ml"), ("Cebolla cabezona", "50", "g"),
    ]),
    ("Guacamole", "exploded", "500", "g", 5, 1, [
        ("Aguacate hass", "3", "unit"), ("Tomate chonto", "100", "g"), ("Cebolla cabezona", "50", "g"),
        ("Cilantro", "10", "g"), ("Limón", "1", "unit"),
    ]),
]

# Fichas técnicas por porción. Cantidades de recetas tradicionales
# (mycolombianrecipes.com, colombia.travel/recetas, Cocina Colombiana de
# Carlos Ordóñez Caicedo), llevadas a una porción de restaurante.
RECIPES: dict[str, list[tuple[str, str, str]]] = {
    "Patacón con hogao": [("Plátano verde", "1", "unit"), ("Aceite vegetal", "40", "ml"), ("@Hogao", "60", "g"),
                          ("Queso campesino", "30", "g")],
    "Empanadas de carne (x3)": [("Harina de maíz precocida", "120", "g"), ("Carne molida de res", "60", "g"),
                                ("Papa pastusa", "60", "g"), ("@Hogao", "20", "g"), ("Aceite vegetal", "60", "ml")],
    "Ceviche de camarón": [("Camarón precocido", "150", "g"), ("Limón", "3", "unit"), ("Cebolla cabezona", "40", "g"),
                           ("Tomate chonto", "60", "g"), ("Cilantro", "5", "g"), ("Aguacate hass", "0.5", "unit")],
    "Tostones con guacamole": [("Plátano verde", "1", "unit"), ("Aceite vegetal", "40", "ml"), ("@Guacamole", "100", "g")],
    "Sancocho de gallina": [("Gallina criolla", "350", "g"), ("Papa pastusa", "150", "g"), ("Yuca", "150", "g"),
                            ("Plátano verde", "0.5", "unit"), ("Mazorca tierna", "0.5", "unit"),
                            ("Cebolla larga", "30", "g"), ("Cilantro", "5", "g"), ("@Arroz blanco cocido", "150", "g"),
                            ("Aguacate hass", "0.25", "unit")],
    "Ajiaco santafereño": [("Pechuga de pollo", "180", "g"), ("Papa sabanera", "150", "g"), ("Papa pastusa", "100", "g"),
                           ("Papa criolla", "150", "g"), ("Mazorca tierna", "0.5", "unit"), ("Guascas", "3", "g"),
                           ("Crema de leche", "40", "ml"), ("Alcaparras", "10", "g"),
                           ("@Arroz blanco cocido", "120", "g"), ("Aguacate hass", "0.25", "unit")],
    "Sopa de guineo": [("Guineo verde", "2", "unit"), ("Costilla de res", "120", "g"), ("Cebolla larga", "20", "g"),
                       ("Cilantro", "5", "g"), ("@Arroz blanco cocido", "100", "g")],
    "Bandeja paisa": [("@Frijoles cocidos", "250", "g"), ("@Arroz blanco cocido", "200", "g"),
                      ("Carne molida de res", "120", "g"), ("Tocino barriga de cerdo", "150", "g"),
                      ("Chorizo antioqueño", "1", "unit"), ("Huevo AA", "1", "unit"), ("Aguacate hass", "0.25", "unit"),
                      ("Plátano maduro", "0.5", "unit"), ("Harina de maíz precocida", "60", "g"), ("@Hogao", "40", "g"),
                      ("Aceite vegetal", "60", "ml")],
    "Frijoles con garra": [("@Frijoles cocidos", "300", "g"), ("Garra de cerdo", "200", "g"),
                           ("@Arroz blanco cocido", "150", "g"), ("Plátano maduro", "0.5", "unit"),
                           ("Aguacate hass", "0.25", "unit")],
    "Lentejas con chorizo": [("Lenteja", "120", "g"), ("Chorizo antioqueño", "1", "unit"), ("@Hogao", "40", "g"),
                             ("@Arroz blanco cocido", "150", "g"), ("Plátano maduro", "0.5", "unit")],
    "Pechuga a la plancha": [("Pechuga de pollo", "250", "g"), ("@Arroz blanco cocido", "150", "g"),
                             ("Lechuga batavia", "60", "g"), ("Tomate chonto", "50", "g"), ("Aceite vegetal", "15", "ml")],
    "Arroz con pollo": [("Arroz blanco", "120", "g"), ("@Pollo desmechado", "180", "g"), ("Zanahoria", "40", "g"),
                        ("Arveja desgranada", "40", "g"), ("@Hogao", "40", "g"), ("Aceite vegetal", "20", "ml"),
                        ("Plátano maduro", "0.5", "unit")],
    "Pescado frito (mojarra)": [("Mojarra roja entera", "1", "unit"), ("Plátano verde", "1", "unit"),
                                ("@Arroz blanco cocido", "150", "g"), ("Crema de coco", "30", "ml"),
                                ("Limón", "1", "unit"), ("Aceite vegetal", "150", "ml"), ("Lechuga batavia", "50", "g"),
                                ("Tomate chonto", "40", "g")],
    "Lomo al trapo": [("Lomo de res", "300", "g"), ("Papa criolla", "200", "g"), ("@Guacamole", "60", "g"),
                      ("Aceite vegetal", "20", "ml")],
    "Limonada de coco": [("Limón", "3", "unit"), ("Crema de coco", "60", "ml"), ("Azúcar", "30", "g")],
    "Jugo de mango": [("Mango tommy", "220", "g"), ("Azúcar", "25", "g")],
    "Gaseosa": [("Gaseosa 400ml (botella)", "1", "unit")],
    "Cerveza Águila": [("Cerveza Águila 330ml", "1", "unit")],
    "Flan de café": [("Leche entera", "120", "ml"), ("Huevo AA", "1", "unit"), ("Azúcar", "35", "g"),
                     ("Café molido", "5", "g"), ("Leche condensada", "40", "g")],
    "Postre de natas": [("Leche entera", "250", "ml"), ("Azúcar", "40", "g"), ("Huevo AA", "0.5", "unit")],
}

# Popularidad relativa (qué se pide más) por producto.
POPULARITY = {
    "Bandeja paisa": 14, "Ajiaco santafereño": 11, "Sancocho de gallina": 7, "Pechuga a la plancha": 8,
    "Arroz con pollo": 7, "Frijoles con garra": 4, "Lentejas con chorizo": 3, "Pescado frito (mojarra)": 5,
    "Lomo al trapo": 4, "Sopa de guineo": 2, "Patacón con hogao": 6, "Empanadas de carne (x3)": 8,
    "Ceviche de camarón": 3, "Tostones con guacamole": 3, "Limonada de coco": 12, "Jugo de mango": 7,
    "Gaseosa": 9, "Cerveza Águila": 8, "Flan de café": 3, "Postre de natas": 2,
}

CUSTOMERS = [
    ("13", "79845123", None, "Carlos Andrés Beltrán", "carlos.beltran@correo.test"),
    ("13", "52367841", None, "María Fernanda Ospina", "mafe.ospina@correo.test"),
    ("13", "1020765432", None, "Juan Sebastián Castro", "jscastro@correo.test"),
    ("13", "39781456", None, "Gloria Inés Parra", "gloria.parra@correo.test"),
    ("31", "900765432", "1", "Constructora Los Cerros SAS", "contabilidad@loscerros.test"),
    ("31", "830112233", "5", "Consultores Andinos Ltda", "facturas@consultoresandinos.test"),
    ("13", "1015443322", None, "Laura Camila Rincón", "laura.rincon@correo.test"),
    ("13", "80123987", None, "Diego Alejandro Nieto", "dnieto@correo.test"),
]

DENOMS = [100_000, 50_000, 20_000, 10_000, 5_000, 2_000, 1_000, 500, 200, 100, 50]


def denominations(total: int) -> dict[str, Any]:
    rest, items = total, []
    for value in DENOMS:
        count, rest = divmod(rest, value)
        if count:
            items.append({"value": value, "count": count})
    if rest:
        raise ValueError(f"{total} no se puede armar con billetes y monedas colombianas")
    return {"denominations": items, "total": total}


# ---------------------------------------------------------------------------
# Cliente HTTP con bitácora de hallazgos.
# ---------------------------------------------------------------------------


@dataclass
class Finding:
    step: str
    method: str
    path: str
    status: int
    body: str


@dataclass
class Report:
    findings: list[Finding] = field(default_factory=list)
    counts: Counter[str] = field(default_factory=Counter)


class ApiError(Exception):
    def __init__(self, finding: Finding) -> None:
        super().__init__(f"{finding.method} {finding.path} -> {finding.status}: {finding.body[:400]}")
        self.finding = finding


class Api:
    def __init__(self, client: TestClient, report: Report, name: str) -> None:
        self.c = client
        self.report = report
        self.name = name
        self.step = ""

    def _do(self, method: str, path: str, *, expect: tuple[int, ...] = (200, 201, 204), **kw: Any) -> Any:
        headers = kw.pop("headers", {}) or {}
        if method in ("POST", "PUT", "PATCH", "DELETE"):
            headers.setdefault("Idempotency-Key", str(uuid.uuid4()))
        resp = self.c.request(method, "/api/v1" + path, headers=headers, **kw)
        self.report.counts[f"{method} {path.split('?')[0]}"] += 1
        if resp.status_code not in expect:
            finding = Finding(self.step, method, path, resp.status_code, resp.text)
            self.report.findings.append(finding)
            raise ApiError(finding)
        if resp.status_code == 204 or not resp.content:
            return None
        ctype = resp.headers.get("content-type", "")
        return resp.json() if "json" in ctype else resp.text

    def get(self, path: str, **kw: Any) -> Any:
        return self._do("GET", path, **kw)

    def post(self, path: str, json: Any = None, **kw: Any) -> Any:
        return self._do("POST", path, json=json, **kw)

    def put(self, path: str, json: Any = None, **kw: Any) -> Any:
        return self._do("PUT", path, json=json, **kw)

    def patch(self, path: str, json: Any = None, **kw: Any) -> Any:
        return self._do("PATCH", path, json=json, **kw)


def set_local(day: date, hhmm: str) -> None:
    hh, mm = (int(x) for x in hhmm.split(":"))
    local = datetime(day.year, day.month, day.day, hh, mm, tzinfo=BOGOTA)
    if hh < 6:  # madrugada: pertenece al día operativo anterior, cae al día siguiente
        local += timedelta(days=1)
    instant = local.astimezone(timezone.utc)
    clock.set_clock(lambda: instant)


def advance(minutes: int) -> None:
    current = clock.now_utc() + timedelta(minutes=minutes)
    clock.set_clock(lambda: current)


def _read_token_on_clock(token: str) -> dict[str, Any]:
    payload: dict[str, Any] = jwt.decode(
        token, settings.JWT_SECRET, algorithms=["HS256"], options={"verify_exp": False}
    )
    if int(payload.get("exp", 0)) < int(clock.now_utc().timestamp()):
        raise jwt.ExpiredSignatureError("Signature has expired")
    return payload


# ---------------------------------------------------------------------------
# El simulador.
# ---------------------------------------------------------------------------


class Demo:
    def __init__(self, *, days: int, seed: int) -> None:
        from app.main import app

        self.rng = random.Random(seed)
        self.report = Report()
        self.admin = Api(TestClient(app), self.report, "admin")
        self.pos = Api(TestClient(app), self.report, "pos")
        self.days = days
        today = datetime.now(BOGOTA).date()
        self.first_day = today - timedelta(days=days)
        self.store_id = 0
        self.staff: dict[str, dict[str, Any]] = {}
        self.pins: dict[int, str] = {}
        self.suppliers: dict[str, int] = {}
        self.ingredients: dict[str, dict[str, Any]] = {}
        self.preparations: dict[str, dict[str, Any]] = {}
        self.products: dict[str, dict[str, Any]] = {}
        self.tables: list[dict[str, Any]] = []
        self.platform_id: int | None = None
        self.delivery_fee_id: int | None = None
        self.shift_ids: list[int] = []
        self.day_summaries: list[str] = []
        self.cash_today = self.pickups_today = self.expenses_today = self.delivery_cash = 0
        self.cook_ids: list[int] = []
        self.current_order = 0
        self.issues: list[str] = []  # lo que no es un error HTTP pero se ve mal

    # -- utilidades -------------------------------------------------------

    def attempt(self, step: str, fn: Any, *args: Any, **kw: Any) -> Any:
        """Corre un paso; si la puerta lo rechaza, lo anota y sigue."""
        self.admin.step = self.pos.step = step
        try:
            return fn(*args, **kw)
        except ApiError:
            return None

    def identify(self, employee_id: int) -> None:
        self.pos.post("/auth/device/identify", {"employee_id": employee_id, "pin": self.pins[employee_id]})

    def staff_id(self, name: str) -> int:
        return int(self.staff[name]["id"])

    # -- configuración ----------------------------------------------------

    def login(self) -> None:
        self.admin.post("/auth/admin/login", {"email": ADMIN[0], "password": ADMIN[1]})
        stores = self.admin.get("/admin/stores")
        self.store_id = stores[0]["id"]
        self.pos.post("/auth/device/activate", {"store_id": self.store_id, "store_pin": STORE_PIN})

    def configure(self) -> None:
        a, sid = self.admin, self.store_id
        a.step = "configuración"
        a.post("/admin/organization/profile", {"profile": "full"})
        a.patch(f"/admin/stores/{sid}", {
            "name": "Sede Centro",
            "active_channels": ["counter", "dine_in", "takeout", "delivery", "platform"],
        })
        sales = a.get(f"/admin/stores/{sid}/sales-settings")
        methods = sales["payment_methods"]
        if not any(m["code"] == "nequi" for m in methods):
            methods.append({"code": "nequi", "label": "Nequi", "dian_code": "47", "enabled": True,
                            "requires_reference": True})
        body = {k: sales[k] for k in (
            "tip_suggested_pct", "discount_limit_pct", "discount_daily_limit_pct", "courtesy_shift_limit",
            "void_reasons", "discount_reasons", "courtesy_reasons", "courses", "stations",
            "course_target_minutes", "invoice_threshold_uvt")}
        body["payment_methods"] = methods
        a.put(f"/admin/stores/{sid}/sales-settings", body)

        existing = {e["name"]: e for e in a.get("/admin/employees")}
        for name, role, pin, can_charge, _area, _wage in STAFF:
            if name in existing:
                emp = existing[name]
            else:
                emp = a.post("/admin/employees", {"name": name, "role": role, "pin": pin, "store_id": sid,
                                                  "can_charge": can_charge})
            self.staff[name] = emp
            self.pins[int(emp["id"])] = pin
        for e in a.get("/admin/employees"):
            if e["name"] == "Supervisor Demo":
                self.staff["Supervisor Demo"] = e
                self.pins[int(e["id"])] = SUPERVISOR_PIN

        catalog = a.get(f"/admin/products?store_id={sid}")
        for p in catalog:
            self.products[p["name"]] = p
            if p.get("is_delivery_fee"):
                self.delivery_fee_id = p["id"]
        tables = a.get(f"/admin/tables?store_id={sid}")
        self.tables = [t for t in tables if t.get("active", True)]
        platforms = a.get(f"/admin/platforms?store_id={sid}")
        if platforms:
            self.platform_id = platforms[0]["id"]

    def suppliers_and_ingredients(self) -> None:
        a, sid = self.admin, self.store_id
        a.step = "proveedores"
        existing = {s["name"]: s for s in a.get(f"/admin/suppliers?store_id={sid}")}
        for name, nit, term, contact, phone, invoices in SUPPLIERS:
            if name in existing:
                self.suppliers[name] = existing[name]["id"]
                continue
            row = a.post(f"/admin/suppliers?store_id={sid}", {
                "name": name, "nit": nit, "payment_term_days": term, "contact_name": contact,
                "contact_phone": phone, "invoices_required": invoices, "active": True,
            })
            self.suppliers[name] = row["id"]

        a.step = "insumos"
        current = {i["name"]: i for i in a.get(f"/admin/ingredients?store_id={sid}")}
        for (name, cat, base, punit, factor, yld, cost, supplier, min_stock, perishable, key,
             untracked) in INGREDIENTS:
            if name in current:
                self.ingredients[name] = current[name]
                continue
            row = self.attempt(f"insumo {name}", a.post, f"/admin/ingredients?store_id={sid}", {
                "name": name, "category": cat, "base_unit": base, "purchase_unit": punit,
                "purchase_factor": factor, "yield_pct": yld, "official_cost": cost, "min_stock": min_stock,
                "lead_time_days": 2 if perishable else 5, "perishable": perishable, "key_item": key,
                "consumption_untracked": untracked, "supplier_id": self.suppliers[supplier], "active": True,
            })
            if row:
                self.ingredients[name] = row
        for name, supplier in SEED_INGREDIENT_SUPPLIER.items():
            if name in current:
                row = self.attempt(f"proveedor de {name}", a.patch, f"/admin/ingredients/{current[name]['id']}",
                                   {"supplier_id": self.suppliers[supplier]})
                self.ingredients[name] = row or current[name]

    def _component(self, ref: str, qty: str, unit: str) -> dict[str, Any]:
        if ref.startswith("@"):
            return {"preparation_id": self.preparations[ref[1:]]["id"], "qty": qty, "unit": unit}
        return {"ingredient_id": self.ingredients[ref]["id"], "qty": qty, "unit": unit}

    def recipes(self) -> None:
        a, sid = self.admin, self.store_id
        a.step = "preparaciones"
        existing = {p["name"]: p for p in a.get(f"/admin/preparations?store_id={sid}")}
        self.preparations.update(existing)
        for name, mode, yqty, yunit, loss, shelf, lines in PREPARATIONS:
            body_lines = [self._component(*ln) for ln in lines]
            if name in existing:
                # El seed dejó el hogao hecho de papa criolla: se corrige con la receta real.
                row = self.attempt(f"corregir preparación {name}", a.patch,
                                   f"/admin/preparations/{existing[name]['id']}",
                                   {"lines": body_lines, "standard_yield_qty": yqty, "process_loss_pct": loss})
                if row:
                    self.preparations[name] = row
                continue
            row = self.attempt(f"preparación {name}", a.post, f"/admin/preparations?store_id={sid}", {
                "name": name, "mode": mode, "standard_yield_qty": yqty, "standard_yield_unit": yunit,
                "process_loss_pct": loss, "shelf_life_days": shelf, "lines": body_lines,
            })
            if row:
                self.preparations[name] = row

        a.step = "fichas técnicas"
        for product, lines in RECIPES.items():
            if product not in self.products:
                self.issues.append(f"La carta no tiene «{product}»; su ficha no se cargó.")
                continue
            pid = self.products[product]["id"]
            current = a.get(f"/admin/products/{pid}/recipe")
            version = int((current or {}).get("version") or (current or {}).get("current_version") or 0)
            self.attempt(f"ficha {product}", a.put, f"/admin/products/{pid}/recipe",
                         {"version": version, "lines": [self._component(*ln) for ln in lines]})

    # -- compras ----------------------------------------------------------

    def admin_session(self) -> None:
        """La sesión del dueño dura 12 horas: cada mañana vuelve a entrar."""
        self.admin.post("/auth/admin/login", {"email": ADMIN[0], "password": ADMIN[1]})

    def purchase(self, day: date, supplier: str, items: list[tuple[str, str]], *, invoice: bool = True) -> None:
        """Una recepción: `items` = (insumo, cantidad en UNIDAD DE COMPRA)."""
        a, sid = self.admin, self.store_id
        set_local(day, "08:30")
        self.admin_session()
        lines, total = [], 0
        for name, qty_purchase in items:
            ing = self.ingredients.get(name)
            if ing is None:
                continue
            factor = int(ing["purchase_factor"])
            base_cost = float(ing.get("official_cost") or ing.get("estimated_cost") or 0)
            # El precio de la factura se mueve ±6 % contra el costo oficial.
            unit_price = round(base_cost * factor * self.rng.uniform(0.94, 1.06))
            qty = qty_purchase
            base = int(round(unit_price * float(qty)))
            line: dict[str, Any] = {
                "ingredient_id": ing["id"], "qty_received": qty, "qty_invoiced": qty,
                "purchase_unit_price": str(unit_price), "tax_base": base, "tax_rate": 0, "tax_amount": 0,
            }
            if ing.get("perishable"):
                line["lot_code"] = f"L{day:%m%d}-{ing['id']}"
                line["expires_at"] = (day + timedelta(days=5 if ing.get("category") != "Lácteos" else 12)).isoformat()
            lines.append(line)
            total += base
        if not lines:
            return
        body = {
            "supplier_id": self.suppliers[supplier], "invoice_date": day.isoformat(),
            "invoice_number": f"FE-{self.rng.randint(10000, 99999)}" if invoice else None,
            "no_invoice": not invoice, "invoice_total": total if invoice else None,
            "received_by_pin": ADMIN_PIN, "confirm_price": True, "lines": lines,
        }
        rec = self.attempt(f"compra {supplier} {day}", a.post, f"/receptions?store_id={sid}", body)
        if rec:
            self.report.counts["compras"] += 1

    def pay_payables(self, day: date) -> None:
        a, sid = self.admin, self.store_id
        set_local(day, "15:00")
        self.admin_session()
        a.step = "cuentas por pagar"
        payables = a.get(f"/admin/payables?store_id={sid}")
        rows = payables if isinstance(payables, list) else payables.get("items", payables.get("rows", []))
        for p in rows:
            status = p.get("status")
            if status == "pending_review":
                self.attempt(f"aprobar CxP {p['id']}", a.post, f"/admin/payables/{p['id']}/approve",
                             {"authorizer_pin": ADMIN_PIN, "confirm_discrepancy": True})
        payables = a.get(f"/admin/payables?store_id={sid}")
        rows = payables if isinstance(payables, list) else payables.get("items", payables.get("rows", []))
        for p in rows:
            due = p.get("due_date")
            balance = int(p.get("balance") or 0)
            if balance > 0 and p.get("status") not in ("paid", "void") and (due is None or due <= day.isoformat()):
                self.attempt(f"pagar CxP {p['id']}", a.post, f"/admin/payables/{p['id']}/payments", {
                    "amount": balance, "method": "transfer", "paid_at": day.isoformat(),
                    "reference": f"TRF{self.rng.randint(100000, 999999)}", "from_cash_drawer": False,
                    "authorizer_pin": ADMIN_PIN,
                })

    # -- el día -----------------------------------------------------------

    def pick_products(self, n: int, *, food: bool = True) -> list[str]:
        names = [p for p in POPULARITY if p in self.products]
        weights = [POPULARITY[p] for p in names]
        return self.rng.choices(names, weights=weights, k=n)

    def modifiers_for(self, product: dict[str, Any]) -> list[dict[str, int]]:
        chosen = []
        for group in product.get("modifier_groups") or []:
            options = [o for o in group.get("options", []) if o.get("available", True)]
            if not options:
                continue
            if group.get("required") or self.rng.random() < 0.25:
                chosen.append({"option_id": self.rng.choice(options)["id"]})
        return chosen

    def run_order(self, day: date, channel: str, waiter: int, cashier: int, courier: int) -> int:
        """Una comanda completa. Devuelve el total cobrado (0 si no se cobró)."""
        p = self.pos
        self.identify(waiter if channel == "dine_in" else cashier)
        body: dict[str, Any] = {"channel": channel}
        if channel == "dine_in":
            status = p.get("/tables/status")
            free = [t for z in status["zones"] for t in z["tables"] if t.get("status") == "free"]
            if not free:
                channel = "counter"
                body = {"channel": "counter"}
            else:
                table = self.rng.choice(free)
                body["table_ids"] = [table["id"]]
                body["covers"] = self.rng.choice([1, 2, 2, 3, 4, 4, 5])
        elif channel == "takeout":
            body["takeout"] = {"customer_name": self.rng.choice(["Don Fabio", "Sra. Martha", "Kevin", "Paola"]),
                               "phone": "3001234567"}
        elif channel == "delivery":
            body["delivery"] = {"address": f"Cra {self.rng.randint(1, 30)} # {self.rng.randint(1, 80)}-"
                                           f"{self.rng.randint(1, 99)}", "phone": "3109876543",
                                "courier_employee_id": courier}
        elif channel == "platform":
            body["platform"] = {"platform_id": self.platform_id, "external_id": f"RP-{uuid.uuid4().hex[:8]}"}
        order = p.post("/orders", body)
        self.current_order = int(order["id"])

        covers = int(body.get("covers") or self.rng.choice([1, 1, 2]))
        n_items = max(1, covers + self.rng.choice([0, 1, 1, 2]))
        lines: list[dict[str, Any]] = []
        for name in self.pick_products(n_items):
            prod = self.products[name]
            line: dict[str, Any] = {"product_id": prod["id"], "qty": 1}
            mods = self.modifiers_for(prod)
            if mods:
                line["modifiers"] = mods
            if channel == "dine_in" and self.rng.random() < 0.1:
                line["note"] = self.rng.choice(["sin cebolla", "bien caliente", "sin sal"])
            lines.append(line)
        order = p.post(f"/orders/{order['id']}/items", {"expected_version": order["version"], "items": lines})
        order = p.post(f"/orders/{order['id']}/send", {"expected_version": order["version"]})
        advance(self.rng.randint(8, 20))

        # Cocina despacha lo que tiene estación (quien cocina se identifica en el KDS).
        self.identify(self.rng.choice(self.cook_ids))
        for item in order.get("items", []):
            if item.get("status") == "sent":
                self.attempt("cocina: listo", p.post, f"/kitchen/items/{item['id']}/bump")
        advance(self.rng.randint(15, 45))

        # Incidentes de salón: anulación de un ítem enviado o descuento.
        roll = self.rng.random()
        if channel == "dine_in" and roll < 0.04 and len(order.get("items", [])) > 1:
            self.identify(waiter)
            order = p.get(f"/orders/{order['id']}")
            item = order["items"][-1]
            got = self.attempt("anular ítem enviado", p.post, f"/orders/{order['id']}/items/{item['id']}/void", {
                "expected_version": order["version"], "reason": "long_wait",
                "note": "El cliente se cansó de esperar", "authorizer_pin": SUPERVISOR_PIN})
            if got:
                self.report.counts["ítems anulados"] += 1
        elif channel == "dine_in" and roll < 0.08:
            self.identify(waiter)
            order = p.get(f"/orders/{order['id']}")
            got = self.attempt("descuento", p.post, f"/orders/{order['id']}/discounts", {
                "expected_version": order["version"], "scope": "order", "kind": "percent", "value": 10,
                "reason": "promo", "note": "Cliente frecuente", "authorizer_pin": SUPERVISOR_PIN})
            if got:
                self.report.counts["descuentos"] += 1
        elif channel == "dine_in" and roll < 0.10:
            self.identify(waiter)
            order = p.get(f"/orders/{order['id']}")
            item = order["items"][0]
            got = self.attempt("cortesía", p.post, f"/orders/{order['id']}/items/{item['id']}/courtesy", {
                "expected_version": order["version"], "reason": "complaint",
                "note": "El plato salió frío", "authorizer_pin": ADMIN_PIN})
            if got:
                self.report.counts["cortesías"] += 1

        return self.charge(order, channel, cashier, courier)

    def charge(self, order: dict[str, Any], channel: str, cashier: int, courier: int) -> int:
        """Precuenta y cobro de una comanda. Devuelve el total cobrado (0 si no se cobró)."""
        p = self.pos
        self.identify(cashier)
        order = p.get(f"/orders/{order['id']}")
        if channel == "dine_in":
            p.post(f"/orders/{order['id']}/bill/present", {"expected_version": order["version"]})
            order = p.get(f"/orders/{order['id']}")
        total = int(order["totals"]["total"])
        if total <= 0:
            return 0
        pay: dict[str, Any] = {"pin": self.pins[cashier], "expected_version": order["version"]}
        tip = 0
        if channel == "dine_in":
            accepted = self.rng.random() < 0.75
            suggested = int(order["totals"].get("suggested_tip") or round(total * 0.10 / 100) * 100)
            tip = suggested if accepted else 0
            pay["tip"] = {"asked": True, "accepted": accepted, "modified": False, "amount": tip}
        else:
            pay["tip"] = {"asked": True, "accepted": False, "modified": False, "amount": 0}
        charged = total + tip
        if channel == "platform":
            pay["splits"] = [{"method": "platform", "amount": total}]
            pay["platform_id"] = self.platform_id
        elif channel == "delivery":
            method = self.rng.choice(["cash", "cash", "nequi"])
            split: dict[str, Any] = {"method": method, "amount": charged}
            if method == "cash":
                split["tendered"] = ((charged + 9_999) // 10_000) * 10_000
                pay["delivery"] = {"courier_employee_id": courier}
            else:
                split["reference"] = f"NQ{self.rng.randint(1000000, 9999999)}"
            pay["splits"] = [split]
        else:
            r = self.rng.random()
            if r < 0.45:
                tendered = ((charged + 9_999) // 10_000) * 10_000 if self.rng.random() < 0.6 else charged
                pay["splits"] = [{"method": "cash", "amount": charged, "tendered": tendered}]
            elif r < 0.75:
                pay["splits"] = [{"method": "card", "amount": charged}]
            elif r < 0.88:
                pay["splits"] = [{"method": "nequi", "amount": charged,
                                  "reference": f"NQ{self.rng.randint(1000000, 9999999)}"}]
            elif r < 0.94:
                pay["splits"] = [{"method": "transfer", "amount": charged,
                                  "reference": f"BC{self.rng.randint(1000000, 9999999)}"}]
            else:
                cash_part = (charged // 2 // 1000) * 1000
                pay["splits"] = [{"method": "cash", "amount": cash_part, "tendered": cash_part},
                                 {"method": "card", "amount": charged - cash_part}]
        # Clientes con nombre: frecuentes y empresas que piden factura.
        if channel in ("dine_in", "counter", "takeout") and self.rng.random() < 0.12:
            doc_type, doc, dv, name, email = self.rng.choice(CUSTOMERS)
            pay["customer"] = {"doc_type": doc_type, "doc_number": doc, "dv": dv, "name": name, "email": email,
                               "address": "Bogotá D.C.", "municipality_dane": "11001",
                               "consent": {"text_version": "v1", "channel": "pos"}}
            pay["requests_invoice"] = doc_type == "31" or self.rng.random() < 0.5
        result = self.attempt(f"cobro {channel}", p.post, f"/orders/{order['id']}/payments", pay)
        if result is None:
            return 0
        self.report.counts[f"ventas {channel}"] += 1
        for split in pay["splits"]:
            if split["method"] == "cash":
                if channel == "delivery":
                    self.delivery_cash += int(split["amount"])
                else:
                    self.cash_today += int(split["amount"])
        if pay.get("requests_invoice"):
            self.report.counts["facturas electrónicas"] += 1
        return total

    def void_stuck_order(self) -> None:
        """Una comanda que quedó a medias (la puerta rechazó algo) se anula con motivo, como haría el
        supervisor, para que no bloquee el cierre."""
        if not self.current_order:
            return
        p = self.pos
        order = self.attempt("releer comanda trabada", p.get, f"/orders/{self.current_order}")
        if not order or order.get("status") not in ("open", "to_pay"):
            return
        self.identify(self.staff_id("Supervisor Demo"))
        if self.attempt("anular comanda trabada", p.post, f"/orders/{order['id']}/void", {
                "expected_version": order["version"], "reason": "server_error",
                "note": "Anulada por el simulador: un paso anterior fue rechazado", "authorizer_pin": ADMIN_PIN}):
            self.report.counts["comandas anuladas"] += 1

    def simulate_day(self, day: date, idx: int) -> None:
        p, a = self.pos, self.admin
        weekend = day.weekday() >= 4
        cashier = self.staff_id("Luz Marina Gómez")
        waiters = [self.staff_id("Andrés Felipe Rojas"), self.staff_id("Yuliana Pérez Ríos")]
        cooks = [self.staff_id("Jhon Jairo Cárdenas"), self.staff_id("Rosa Elena Méndez")]
        self.cook_ids = cooks
        courier = self.staff_id("Brayan Estiven Mora")
        supervisor = self.staff_id("Supervisor Demo")

        # Apertura.
        set_local(day, "10:30")
        p.step = f"{day} apertura"
        self.identify(cashier)
        shift = self.attempt(f"{day} abrir turno", p.post, "/shifts/open", {
            "opening_cash": denominations(200_000), "cash_reserve": 0, "cash_responsible_id": cashier})
        if shift is None:
            return
        shift_id = int(shift["id"])
        self.cash_today = self.pickups_today = self.expenses_today = self.delivery_cash = 0
        self.shift_ids.append(shift_id)
        for emp in [cashier, *waiters, *cooks, courier]:
            self.attempt("marcar entrada", p.post, f"/shifts/{shift_id}/roster",
                         {"employee_id": emp, "action": "in", "pin": self.pins[emp]})
            advance(1)

        # Producción de la mañana (preparaciones en lote).
        set_local(day, "10:45")
        for prep_name, qty in (("Arroz blanco cocido", "5000"), ("Frijoles cocidos", "6000" if weekend else "3000"),
                               ("Pollo desmechado", "2000")):
            prep = self.preparations.get(prep_name)
            if prep is None:
                continue
            real = str(int(int(qty) * self.rng.uniform(0.93, 1.02)))
            cook = self.rng.choice(cooks)
            self.identify(cook)
            got = self.attempt(f"producir {prep_name}", p.post, f"/preparations/{prep['id']}/produce", {
                "qty_expected": qty, "qty_real": real, "employee_pin": self.pins[cook]})
            if got:
                self.report.counts["lotes producidos"] += 1

        # Servicio: almuerzo fuerte, tarde floja, comida.
        n_orders = self.rng.randint(32, 44) if weekend else self.rng.randint(22, 32)
        cash_sales = 0
        sold = 0
        for i in range(n_orders):
            minute = int(60 * (11.5 + (i / n_orders) * 9.5)) + self.rng.randint(-10, 10)
            set_local(day, f"{minute // 60:02d}:{minute % 60:02d}")
            channel = self.rng.choices(["dine_in", "counter", "takeout", "delivery", "platform"],
                                       weights=[55, 15, 10, 12, 8])[0]
            if channel == "platform" and not self.platform_id:
                channel = "takeout"
            p.step = f"{day} comanda {i + 1} ({channel})"
            self.current_order = 0
            try:
                sold += self.run_order(day, channel, self.rng.choice(waiters), cashier, courier)
            except ApiError:
                self.void_stuck_order()

            # A media tarde: retiro de caja y gasto menor.
            if i == n_orders // 2:
                p.step = f"{day} media tarde"
                self.identify(cashier)
                # La cajera no ve el esperado (cierre ciego): el simulador lleva su propia cuenta.
                expected = 200_000 + self.cash_today
                if expected > 500_000:
                    pickup = ((expected - 250_000) // 50_000) * 50_000
                    got = self.attempt("retiro de caja", p.post, f"/shifts/{shift_id}/pickups", {
                        "amount": pickup, "denominations": denominations(pickup)["denominations"],
                        "envelope_ref": f"SOBRE-{day:%m%d}", "authorizer_pin": ADMIN_PIN,
                        "photo": f"sobre-{day}.jpg",
                        "note": "Retiro de media tarde"})
                    if got:
                        self.report.counts["retiros"] += 1
                        self.pickups_today += pickup
                if self.rng.random() < 0.6:
                    petty = self.rng.choice([8_000, 12_000, 15_000, 22_000])
                    got = self.attempt("gasto menor", p.post, f"/shifts/{shift_id}/cash-movements", {
                        "kind": "expense", "cause": "petty_expense", "amount": petty,
                        "note": self.rng.choice(["Hielo", "Servilletas", "Gas de cocina (recarga)", "Bolsas"]),
                        "authorizer_pin": SUPERVISOR_PIN})
                    if got:
                        self.report.counts["gastos menores de caja"] += 1
                        self.expenses_today += petty
                # Merma del día.
                waste_ing = self.rng.choice(["Tomate chonto", "Aguacate hass", "Lechuga batavia", "Cilantro"])
                if waste_ing in self.ingredients:
                    unit = self.ingredients[waste_ing]["base_unit"]
                    got = self.attempt("merma", p.post, "/waste", {
                        "ingredient_id": self.ingredients[waste_ing]["id"],
                        "qty": "1" if unit == "unit" else str(self.rng.choice([150, 250, 400])),
                        "type": self.rng.choice(["expired", "kitchen_error", "breakage"]),
                        "note": "Registrado al revisar la nevera", "employee_pin": self.pins[cooks[0]]})
                    if got:
                        self.report.counts["mermas"] += 1

        # Lo que quedó abierto (por ejemplo, las comandas de ejemplo del seed) se cobra antes de cerrar.
        set_local(day, "21:15")
        p.step = f"{day} comandas abiertas al cierre"
        self.identify(cashier)
        for order in p.get("/orders?status=open") + p.get("/orders?status=to_pay"):
            self.current_order = int(order["id"])
            try:
                if any(i.get("status") == "pending" for i in order.get("items", [])):
                    order = p.post(f"/orders/{order['id']}/send", {"expected_version": order["version"]})
                ch = order["channel"]
                sold += self.charge(order, ch, cashier, courier)
                self.issues.append(f"{day}: la comanda #{order['id']} ({ch}) seguía abierta al cierre y se cobró.")
            except ApiError:
                self.void_stuck_order()

        # Liquidación del domiciliario.
        set_local(day, "21:30")
        p.step = f"{day} liquidar domiciliario"
        self.identify(cashier)
        pending = self.attempt("domicilios pendientes", p.get, "/delivery-settlements/pending")
        if pending:
            got = self.attempt("liquidar domiciliario", p.post, "/delivery-settlements",
                               {"courier_employee_id": courier, "note": "Cierre del día"})
            if got:
                self.report.counts["liquidaciones de domiciliario"] += 1
                self.cash_today += self.delivery_cash

        # Salida del personal. La cajera no marca: su jornada termina con el cierre del turno.
        for emp in [*waiters, *cooks, courier]:
            self.attempt("marcar salida", p.post, f"/shifts/{shift_id}/roster",
                         {"employee_id": emp, "action": "out", "pin": self.pins[emp]})

        # Cierre ciego: cuenta, revisa, confirma.
        set_local(day, "22:15")
        p.step = f"{day} cierre"
        self.identify(cashier)
        diff = self.rng.choice([0, 0, 0, 0, -1_000, -2_000, 500, -5_000, 3_000]) if idx % 5 else -18_000
        guess = max(0, 200_000 + self.cash_today - self.pickups_today - self.expenses_today)
        # Primer conteo (lo que la cajera cree), revisión, y reconteo con lo que de verdad hay.
        count = self.attempt(f"{day} conteo de cierre", p.post, f"/shifts/{shift_id}/close/count", {
            "counted_cash": denominations((guess // 50) * 50), "counted_card": 0, "counted_transfer": 0,
            "tips_cash_out": 0, "photo": f"cierre-{day}-1.jpg"})
        if count is None:
            return
        count_id = count.get("id") or count.get("count_id")
        review = self.attempt("revisión de cierre", p.get, f"/shifts/{shift_id}/close/{count_id}/review") or {}
        expected_cash = int(review.get("expected") or 0)
        counted = max(0, ((expected_cash + diff) // 50) * 50)
        card = review.get("card") or {}
        transfer = review.get("transfer") or {}
        count = self.attempt(f"{day} reconteo de cierre", p.post, f"/shifts/{shift_id}/close/count", {
            "counted_cash": denominations(counted),
            "counted_card": int(card.get("sales") or 0) + int(card.get("tips") or 0),
            "counted_transfer": int(transfer.get("sales") or 0) + int(transfer.get("tips") or 0),
            "tips_cash_out": 0, "photo": f"cierre-{day}-2.jpg"})
        if count is None:
            return
        count_id = count.get("id") or count.get("count_id")
        review = self.attempt("revisión de cierre", p.get, f"/shifts/{shift_id}/close/{count_id}/review") or {}
        seen = int(review.get("difference") or 0)
        confirm: dict[str, Any] = {"difference_seen": seen, "closes_day": True}
        if seen:
            confirm["cause"] = "unknown" if abs(seen) >= 10_000 else "change_error"
            confirm["note"] = "Faltante sin explicación, se revisa mañana" if seen < -10_000 else "Error en vueltos"
        closed = self.attempt(f"{day} confirmar cierre", p.post, f"/shifts/{shift_id}/close/{count_id}/confirm",
                              confirm)
        if closed is None and seen:
            # Probar con las causas que el backend publique en el error.
            last = self.report.findings[-1].body if self.report.findings else ""
            self.issues.append(f"{day}: el cierre con diferencia {seen} rechazó la causa: {last[:200]}")
        self.day_summaries.append(
            f"{day:%a %d-%b}: {n_orders} comandas, ventas ${sold:,.0f}, esperado en caja ${expected_cash:,.0f}, "
            f"contado ${counted:,.0f} (dif {seen:+,})".replace(",", "."))
        del a, cash_sales, supervisor

    # -- trastienda semanal ------------------------------------------------

    def weekly_back_office(self, day: date) -> None:
        a, sid = self.admin, self.store_id
        set_local(day, "07:30")
        self.admin_session()
        a.step = f"{day} conteo de críticos"
        count = self.attempt("abrir conteo", a.post, f"/admin/counts?store_id={sid}", {"scope": "key_items"})
        if count:
            detail = a.get(f"/admin/counts/{count['id']}?store_id={sid}")
            stock = {int(r["ingredient_id"]): r for r in a.get(f"/admin/inventory/stock?store_id={sid}")}
            lines = []
            for ln in detail.get("lines", []):
                val = float(stock.get(int(ln["ingredient_id"]), {}).get("qty_base") or 0)
                counted = max(0.0, val * self.rng.uniform(0.9, 1.02))
                lines.append({"ingredient_id": ln["ingredient_id"], "qty_counted": f"{counted:.0f}",
                              "was_counted": True})
            self.attempt("líneas de conteo", a.put, f"/admin/counts/{count['id']}/lines?store_id={sid}",
                         {"lines": lines})
            if self.attempt("aplicar conteo", a.post, f"/admin/counts/{count['id']}/apply?store_id={sid}",
                            {"authorizer_pin": ADMIN_PIN}):
                self.report.counts["conteos aplicados"] += 1

    def restock(self, day: date, *, everyone: bool = False) -> None:
        """Pedido a proveedores según lo que queda: fruver lunes, miércoles y viernes (plaza, sin
        factura); carnes y pescado lunes y jueves; lácteos martes y viernes; abarrotes y bebidas los
        lunes. Se pide lo que falta para llegar a ~5 veces el stock mínimo."""
        wd = day.weekday()
        schedule = {
            "Fruver La Cosecha": wd in (0, 2, 4), "Frigorífico El Llano SAS": wd in (0, 3),
            "Pescadería Pacífico Azul": wd in (0, 3), "Lácteos San Fernando": wd in (1, 4),
            "Mayorista El Surtidor": wd in (0, 3), "Distribuidora Andina de Bebidas": wd in (0, 3),
        }
        due = [name for name, ok in schedule.items() if ok or everyone]
        if not due:
            return
        set_local(day, "08:15")
        self.admin_session()
        stock = {r["name"]: r for r in self.admin.get(f"/admin/inventory/stock?store_id={self.store_id}")}
        used = {ref for lines in RECIPES.values() for ref, _q, _u in lines if not ref.startswith("@")}
        used |= {ref for *_x, lines in PREPARATIONS for ref, _q, _u in lines if not ref.startswith("@")}
        used.add("Pechuga de pollo")  # el pollo desmechado del seed
        supplier_of = {row[0]: row[7] for row in INGREDIENTS} | SEED_INGREDIENT_SUPPLIER
        for supplier in due:
            items: list[tuple[str, str]] = []
            for name in sorted(used):
                if supplier_of.get(name) != supplier or name not in self.ingredients:
                    continue
                ing = self.ingredients[name]
                row = stock.get(name, {})
                have = float(row.get("qty_base") or 0)
                target = float(ing.get("min_stock") or 0) * 5
                if have >= target * 0.6:
                    continue
                factor = int(ing["purchase_factor"])
                need = (target - max(have, 0.0)) / factor
                items.append((name, str(max(1, int(need + 0.999)))))
            if items:
                self.purchase(day, supplier, items, invoice=supplier != "Fruver La Cosecha")

    def money_back_office(self, last_day: date) -> None:
        a, sid = self.admin, self.store_id
        set_local(last_day, "09:00")
        self.admin_session()
        a.step = "gastos y obligaciones"
        month_start = last_day.replace(day=1)
        for cat, desc, amount, when in (
            ("maintenance", "Mantenimiento campana extractora", 280_000, self.first_day + timedelta(days=3)),
            ("utilities", "Gas natural (Vanti)", 690_000, self.first_day + timedelta(days=6)),
            ("marketing", "Volantes y pendón", 150_000, self.first_day + timedelta(days=8)),
            ("supplies", "Uniformes cocina", 240_000, self.first_day + timedelta(days=10)),
        ):
            if self.attempt(f"gasto {desc}", a.post, f"/admin/expenses?store_id={sid}", {
                    "category": cat, "description": desc, "amount": amount, "business_date": when.isoformat(),
                    "source": "bank"}):
                self.report.counts["gastos registrados"] += 1
        for cat, desc, amount, due in (
            ("rent", "Arriendo local", 6_500_000, month_start + timedelta(days=4)),
            ("utilities", "Energía (Enel)", 1_180_000, month_start + timedelta(days=17)),
            ("utilities", "Acueducto", 420_000, month_start + timedelta(days=20)),
            ("taxes", "Retención en la fuente", 380_000, month_start + timedelta(days=24)),
        ):
            ob = self.attempt(f"obligación {desc}", a.post, f"/admin/obligations?store_id={sid}", {
                "category": cat, "description": desc, "amount": amount, "due_date": due.isoformat()})
            if ob and due <= last_day:
                self.attempt(f"pagar {desc}", a.post, f"/admin/obligations/{ob['id']}/settle",
                             {"source": "bank", "note": "Pago PSE"})
        self.attempt("costos fijos", a.patch, f"/admin/expenses/settings?store_id={sid}", {"fixed_costs": 14_500_000})

        a.step = "nómina"
        self.attempt("tabla de recargos", a.post, f"/admin/payroll/surcharge-tables?store_id={sid}", {
            "valid_from": "2025-07-15", "night_start_hour": 19, "night_end_hour": 6, "night_surcharge_bp": 3500,
            "sunday_holiday_surcharge_bp": 8000, "overtime_surcharge_bp": 2500, "weekly_ordinary_hours": 44})
        for name, _role, _pin, _cc, area, wage in STAFF:
            eid = self.staff_id(name)
            self.attempt(f"salario {name}", a.post, f"/admin/payroll/wages?store_id={sid}", {
                "employee_id": eid, "hourly_wage_pesos": wage, "valid_from": self.first_day.isoformat()})
            self.attempt(f"área {name}", a.post, f"/admin/payroll/areas?store_id={sid}",
                         {"employee_id": eid, "area": area})
        for hdate, hname in ((date(2026, 10, 12), "Día de la Raza"), (date(2026, 11, 2), "Todos los Santos"),
                             (date(2026, 8, 17), "Asunción de la Virgen"), (date(2026, 8, 7), "Batalla de Boyacá")):
            self.attempt(f"festivo {hname}", a.post, f"/admin/payroll/holidays?store_id={sid}",
                         {"holiday_date": hdate.isoformat(), "name": hname})
        mid = self.first_day + timedelta(days=min(13, self.days - 1))
        if self.attempt("liquidar quincena", a.post, f"/admin/payroll/runs?store_id={sid}", {
                "date_from": self.first_day.isoformat(), "date_to": mid.isoformat()}):
            self.report.counts["nóminas liquidadas"] += 1

        a.step = "propinas"
        self.attempt("método de reparto", a.patch, f"/admin/tips/settings?store_id={sid}", {"method": "by_hours"})

        a.step = "consignaciones"
        rows = self.attempt("consignaciones pendientes", a.get,
                            f"/admin/deposits/pending?store_id={sid}&from={self.first_day}&to={last_day}") or []
        for row in rows[:-1]:  # el último día queda pendiente, como pasa en la vida real
            amount = int(row.get("outstanding") or 0)
            if amount <= 0:
                continue
            bd = row.get("business_date")
            if self.attempt("consignar", a.post, f"/admin/deposits?store_id={sid}", {
                    "amount": amount, "business_date": bd, "bank_name": "Bancolombia",
                    "bank_reference": f"CNS{self.rng.randint(100000, 999999)}",
                    "receipt_photo": "comprobante-consignacion.jpg",
                    "allocations": [{"shift_id": row["shift_id"], "amount": amount}]}):
                self.report.counts["consignaciones"] += 1

        a.step = "conciliación datáfono"
        recon = a.get(f"/admin/reconciliation/card?store_id={sid}&from={self.first_day}&to={last_day}")
        for row in recon["rows"][:-2]:  # los dos últimos días el banco todavía no abona
            gross = int(row["expected"])
            if gross <= 0 or row["matched"]:
                continue
            bd = date.fromisoformat(row["business_date"])
            settled = bd + timedelta(days=2 if bd.weekday() >= 4 else 1)
            rec = self.attempt("abono de datáfono", a.post, f"/admin/reconciliation/card?store_id={sid}", {
                "sales_business_date": bd.isoformat(), "settled_business_date": settled.isoformat(),
                "gross_amount": gross, "commission_amount": round(gross * 0.0299),
                "retention_amount": round(gross * 0.015), "reference": f"Redeban lote {bd:%m%d}"})
            if rec:
                self.report.counts["abonos de datáfono"] += 1
                self.attempt("conciliar abono", a.post, f"/admin/reconciliation/card/{rec['id']}/settle",
                             {"note": "Cuadra con el extracto"})

        a.step = "conciliación plataforma"
        recon = a.get(f"/admin/reconciliation/platform?store_id={sid}&from={self.first_day}&to={last_day}")
        for row in recon["rows"]:
            gross = int(row["expected"])
            if gross <= 0:
                continue
            rec = self.attempt("liquidación de plataforma", a.post, f"/admin/reconciliation/platform?store_id={sid}", {
                "platform_id": row["platform_id"], "period_from": self.first_day.isoformat(),
                "period_to": last_day.isoformat(), "gross_amount": gross,
                "commission_amount": round(gross * 0.18), "reference": "Corte quincenal Rappi"})
            if rec:
                self.report.counts["liquidaciones de plataforma"] += 1

        a.step = "reparto de propinas"
        shifts = [sh for row in a.get(f"/admin/business-days?store_id={sid}") for sh in row["shifts"]
                  if sh["status"] != "open"]
        first_week = [sh["id"] for sh in shifts if sh["business_date"] < (self.first_day + timedelta(days=7)).isoformat()]
        if first_week:
            proposal = self.attempt("propuesta de reparto", a.get,
                                    f"/admin/tips/distribution/proposal?store_id={sid}&from={self.first_day}"
                                    f"&to={self.first_day + timedelta(days=6)}")
            if proposal and proposal.get("rows"):
                if self.attempt("pagar propinas", a.post, f"/admin/tips/payouts?store_id={sid}", {
                        "shift_ids": proposal["shift_ids"],
                        "distribution": [{"employee_id": r["employee_id"], "amount": r["amount"]}
                                         for r in proposal["rows"] if int(r["amount"]) > 0],
                        "paid_at": (self.first_day + timedelta(days=7)).isoformat(), "method": "cash",
                        "paid_from": "owner_hand"}):
                    self.report.counts["repartos de propina"] += 1

        a.step = "revisión de turnos"
        for sh in shifts[:-1]:
            if not sh.get("reviewed_at"):
                if self.attempt("revisar turno", a.post, f"/admin/shifts/{sh['id']}/review",
                                {"note": "Revisado por el dueño"}):
                    self.report.counts["turnos revisados"] += 1

        a.step = "conteo completo"
        self.full_count(last_day)

        a.step = "nota crédito"
        docs = a.get(f"/admin/documents?store_id={sid}&type=invoice") or []
        if docs:
            doc = docs[-1]
            order = a.get(f"/admin/orders/{doc['order_id']}")
            item = next((i for i in order.get("items", []) if i.get("status") != "voided"), None)
            if item:
                if self.attempt("nota crédito", a.post, f"/admin/documents/{doc['id']}/notes", {
                        "kind": "credit", "reason": "El cliente devolvió un plato que no pidió",
                        "lines": [{"item_id": item["id"], "used": False, "returns_to_stock": False}],
                        "refund": {"method": "transfer", "amount": int(item["gross"]) - int(item["discount"])}}):
                    self.report.counts["notas crédito"] += 1

    def full_count(self, day: date) -> None:
        """Conteo completo de fin de período: lo contado se aparta un poco del teórico."""
        a, sid = self.admin, self.store_id
        count = self.attempt("abrir conteo completo", a.post, f"/admin/counts?store_id={sid}", {"scope": "full"})
        if not count:
            return
        stock = {int(r["ingredient_id"]): r for r in a.get(f"/admin/inventory/stock?store_id={sid}")}
        detail = a.get(f"/admin/counts/{count['id']}?store_id={sid}")
        lines = []
        for ln in detail.get("lines", []):
            theo = max(0.0, float(stock.get(int(ln["ingredient_id"]), {}).get("qty_base") or 0))
            counted = theo * self.rng.uniform(0.88, 1.03)
            fmt = f"{counted:.0f}" if ln.get("base_unit") != "unit" else f"{round(counted)}"
            lines.append({"ingredient_id": ln["ingredient_id"], "qty_counted": fmt, "was_counted": True})
        self.attempt("líneas de conteo completo", a.put, f"/admin/counts/{count['id']}/lines?store_id={sid}",
                     {"lines": lines})
        if self.attempt("aplicar conteo completo", a.post, f"/admin/counts/{count['id']}/apply?store_id={sid}",
                        {"authorizer_pin": ADMIN_PIN}):
            self.report.counts["conteos aplicados"] += 1

    # -- orquestación -----------------------------------------------------

    def run(self) -> None:
        set_local(self.first_day - timedelta(days=1), "09:00")
        self.login()
        self.configure()
        self.suppliers_and_ingredients()
        self.recipes()
        # Stock de arranque: la compra grande del día anterior a abrir.
        self.restock_initial(self.first_day - timedelta(days=1))
        for idx in range(self.days):
            day = self.first_day + timedelta(days=idx)
            if idx and day.weekday() == 0:
                self.weekly_back_office(day)
            self.restock(day)
            self.simulate_day(day, idx)
            if day.weekday() in (1, 4):
                self.pay_payables(day)
            print(f"  día {idx + 1}/{self.days} listo: {self.day_summaries[-1] if self.day_summaries else day}",
                  flush=True)
        self.money_back_office(self.first_day + timedelta(days=self.days))

    def restock_initial(self, day: date) -> None:
        self.restock(day, everyone=True)


def _route(path: str) -> str:
    import re

    return re.sub(r"/\d+", "/{id}", path.split("?")[0])


def main() -> None:
    parser = argparse.ArgumentParser(description="Operación simulada de demostración (después de app.seed).")
    parser.add_argument("--days", type=int, default=14)
    parser.add_argument("--seed", type=int, default=2026)
    args = parser.parse_args()
    if settings.ENV == "production":
        print("app.demo no corre en producción: llena la base con operación ficticia.", file=sys.stderr)
        raise SystemExit(2)

    security.read_token = _read_token_on_clock  # type: ignore[assignment]
    import app.auth.deps as deps

    if hasattr(deps, "read_token"):
        deps.read_token = _read_token_on_clock  # type: ignore[attr-defined]

    demo = Demo(days=args.days, seed=args.seed)
    print(f"Simulando {args.days} días desde {demo.first_day} ...", flush=True)
    try:
        demo.run()
    except Exception as exc:  # el informe se imprime igual: es lo que importa
        demo.issues.append(f"El simulador se detuvo: {exc!r}")
    finally:
        clock.set_clock(None)

    print("\n== Resumen ==")
    for key, value in sorted(demo.report.counts.items()):
        if not key.startswith(("GET ", "POST ", "PUT ", "PATCH ", "DELETE ")):
            print(f"  {key}: {value}")
    calls = sum(v for k, v in demo.report.counts.items() if k.split(" ")[0] in ("GET", "POST", "PUT", "PATCH"))
    print(f"  llamadas HTTP: {calls}")
    print("\n== Días ==")
    for line in demo.day_summaries:
        print("  " + line)
    by_kind: dict[tuple[str, int, str], list[str]] = defaultdict(list)
    for f in demo.report.findings:
        code = ""
        try:
            import json as _json

            code = _json.loads(f.body).get("error", {}).get("code", "")
        except Exception:
            code = f.body[:60]
        by_kind[(f"{f.method} {_route(f.path)}", f.status, code)].append(f.step)
    print(f"\n== Rechazos de la API ({len(demo.report.findings)}) ==")
    for (route, status, code), steps in sorted(by_kind.items(), key=lambda kv: -len(kv[1])):
        sample = next(f for f in demo.report.findings if f"{f.method} {_route(f.path)}" == route
                      and f.status == status)
        print(f"  [{len(steps)}x] {status} {code} {route}  (p.ej. {steps[0]})")
        print(f"        {sample.body[:300]}")
    if demo.issues:
        print("\n== Observaciones ==")
        for issue in demo.issues:
            print("  - " + issue)


if __name__ == "__main__":
    main()
