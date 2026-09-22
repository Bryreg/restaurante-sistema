"""Reservas de mesa: el sexto estado del plano.

Lo que estos tests cuidan no es «que se pueda crear una reserva» sino las
tres reglas que hacen que sirva: que dos reservas no se encimen sobre la
misma mesa, que apartar no sea lo mismo que ocupar, y que nada se borre.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any

from fastapi.testclient import TestClient


def _crear(client: TestClient, *, table_id: int, at: datetime, nombre: str = "Familia Rincón", personas: int = 2, headers: dict[str, str] | None = None) -> Any:
    from orders.conftest import idem_headers

    return client.post(
        "/api/v1/reservations",
        json={"table_id": table_id, "at": at.isoformat(), "party_name": nombre, "party_size": personas},
        headers=headers or idem_headers(),
    )


def test_apagada_no_deja_reservar(device_client: TestClient, identify: Any, employees: Any, open_shift: Any, set_feature: Any, tables: Any, clock: Any) -> None:
    set_feature("pos.tables", True)
    set_feature("pos.reservations", False)
    clock.set(datetime(2026, 3, 10, 18, 0, tzinfo=timezone.utc))
    open_shift()
    identify(device_client, employees["operator"])

    resp = _crear(device_client, table_id=tables[0].id, at=datetime(2026, 3, 11, 1, 0, tzinfo=timezone.utc))
    assert resp.status_code == 400, resp.text
    assert resp.json()["error"]["code"] == "FEATURE_DISABLED"


def test_crear_y_listar(device_client: TestClient, identify: Any, employees: Any, open_shift: Any, set_feature: Any, tables: Any, clock: Any) -> None:
    set_feature("pos.tables", True)
    set_feature("pos.reservations", True)
    clock.set(datetime(2026, 3, 10, 18, 0, tzinfo=timezone.utc))  # 13:00 Bogotá
    open_shift()
    identify(device_client, employees["operator"])

    at = datetime(2026, 3, 11, 2, 0, tzinfo=timezone.utc)  # 21:00 Bogotá del 10
    resp = _crear(device_client, table_id=tables[0].id, at=at)
    assert resp.status_code == 201, resp.text
    creada = resp.json()
    assert creada["party_name"] == "Familia Rincón"
    assert creada["status"] == "booked"
    # El día operativo es el del CORTE, no el del calendario: las 21:00 del 10
    # en Bogotá son el 2026-03-11T02:00Z, y siguen perteneciendo al día 10.
    assert creada["business_date"] == "2026-03-10"
    assert creada["table"]["number"] == tables[0].number

    listado = device_client.get("/api/v1/reservations", params={"date": "2026-03-10"})
    assert listado.status_code == 200, listado.text
    assert [r["id"] for r in listado.json()] == [creada["id"]]


def test_no_deja_dos_reservas_encimadas_en_la_misma_mesa(device_client: TestClient, identify: Any, employees: Any, open_shift: Any, set_feature: Any, tables: Any, clock: Any) -> None:
    """Es la regla que hace que la función sirva: dos mesas prometidas y una
    sola mesa es el error que la reserva viene a evitar."""
    set_feature("pos.tables", True)
    set_feature("pos.reservations", True)
    clock.set(datetime(2026, 3, 10, 18, 0, tzinfo=timezone.utc))
    open_shift()
    identify(device_client, employees["operator"])

    at = datetime(2026, 3, 11, 1, 0, tzinfo=timezone.utc)
    assert _crear(device_client, table_id=tables[0].id, at=at).status_code == 201

    # Veinte minutos después: la misma franja de servicio.
    choque = _crear(device_client, table_id=tables[0].id, at=at + timedelta(minutes=20), nombre="Otros")
    assert choque.status_code == 409, choque.text
    assert choque.json()["error"]["code"] == "TABLE_ALREADY_RESERVED"
    # El mensaje nombra a quién le pertenece la mesa: sin eso, quien contesta
    # el teléfono no sabe qué decirle al cliente.
    assert "Familia Rincón" in choque.json()["error"]["message"]

    # Tres horas después SÍ: es otro servicio.
    otra = _crear(device_client, table_id=tables[0].id, at=at + timedelta(hours=3), nombre="Otros")
    assert otra.status_code == 201, otra.text


def test_no_deja_reservar_mas_personas_que_puestos(device_client: TestClient, identify: Any, employees: Any, open_shift: Any, set_feature: Any, tables: Any, clock: Any) -> None:
    set_feature("pos.tables", True)
    set_feature("pos.reservations", True)
    clock.set(datetime(2026, 3, 10, 18, 0, tzinfo=timezone.utc))
    open_shift()
    identify(device_client, employees["operator"])

    resp = _crear(
        device_client,
        table_id=tables[0].id,
        at=datetime(2026, 3, 11, 1, 0, tzinfo=timezone.utc),
        personas=tables[0].seats + 1,
    )
    assert resp.status_code == 400, resp.text
    assert resp.json()["error"]["code"] == "PARTY_EXCEEDS_SEATS"


def test_la_mesa_apartada_sigue_libre_y_aparece_en_el_plano(device_client: TestClient, identify: Any, employees: Any, open_shift: Any, set_feature: Any, tables: Any, clock: Any) -> None:
    """**Apartada no es ocupada.** La mesa se puede seguir abriendo —el
    cliente puede llegar antes, o no llegar— y el plano lo dice sin mentir:
    `status` sigue en `free` y la reserva viaja al lado."""
    set_feature("pos.tables", True)
    set_feature("pos.reservations", True)
    clock.set(datetime(2026, 3, 10, 23, 0, tzinfo=timezone.utc))  # 18:00 Bogotá
    open_shift()
    identify(device_client, employees["operator"])

    # Dentro de la ventana de anticipación (90 min).
    at = datetime(2026, 3, 10, 23, 45, tzinfo=timezone.utc)
    creada = _crear(device_client, table_id=tables[0].id, at=at).json()

    plano = device_client.get("/api/v1/tables/status")
    assert plano.status_code == 200, plano.text
    mesas = [m for z in plano.json()["zones"] for m in z["tables"]]
    mesa = next(m for m in mesas if m["id"] == tables[0].id)
    assert mesa["status"] == "free"
    assert mesa["reservation"]["party_name"] == "Familia Rincón"
    assert mesa["reservation"]["id"] == creada["id"]

    # Y una mesa sin reserva no inventa ninguna: `None`, no un objeto vacío.
    otra = next(m for m in mesas if m["id"] == tables[1].id)
    assert otra["reservation"] is None


def test_una_reserva_lejana_no_aparta_la_mesa_todavia(device_client: TestClient, identify: Any, employees: Any, open_shift: Any, set_feature: Any, tables: Any, clock: Any) -> None:
    """Apartar la mesa tres horas antes sería regalar el almuerzo."""
    set_feature("pos.tables", True)
    set_feature("pos.reservations", True)
    clock.set(datetime(2026, 3, 10, 17, 0, tzinfo=timezone.utc))  # 12:00 Bogotá
    open_shift()
    identify(device_client, employees["operator"])

    _crear(device_client, table_id=tables[0].id, at=datetime(2026, 3, 11, 2, 0, tzinfo=timezone.utc))  # 21:00

    plano = device_client.get("/api/v1/tables/status")
    mesas = [m for z in plano.json()["zones"] for m in z["tables"]]
    mesa = next(m for m in mesas if m["id"] == tables[0].id)
    assert mesa["status"] == "free"
    assert mesa["reservation"] is None, "una reserva de las 9 p. m. no aparta la mesa al mediodía"


def test_abrir_la_mesa_sienta_la_reserva(device_client: TestClient, identify: Any, employees: Any, open_shift: Any, set_feature: Any, tables: Any, clock: Any, new_order: Any) -> None:
    set_feature("pos.tables", True)
    set_feature("pos.reservations", True)
    clock.set(datetime(2026, 3, 10, 23, 0, tzinfo=timezone.utc))
    open_shift()
    identify(device_client, employees["operator"])

    creada = _crear(device_client, table_id=tables[0].id, at=datetime(2026, 3, 10, 23, 30, tzinfo=timezone.utc)).json()
    # `channel="dine_in"` explícito: `new_order` abre de mostrador por
    # defecto, y una comanda de mostrador no toca ninguna mesa.
    orden = new_order(channel="dine_in", table_ids=[tables[0].id], covers=2).json()

    listado = device_client.get("/api/v1/reservations", params={"date": creada["business_date"]}).json()
    sentada = next(r for r in listado if r["id"] == creada["id"])
    assert sentada["status"] == "seated"
    assert sentada["seated_at"] is not None
    # El hilo entre lo que se apartó y lo que esa mesa terminó consumiendo.
    assert sentada["seated_order_id"] == orden["id"]


def test_cancelar_no_borra_y_exige_motivo(device_client: TestClient, identify: Any, employees: Any, open_shift: Any, set_feature: Any, tables: Any, clock: Any) -> None:
    set_feature("pos.tables", True)
    set_feature("pos.reservations", True)
    clock.set(datetime(2026, 3, 10, 18, 0, tzinfo=timezone.utc))
    open_shift()
    identify(device_client, employees["operator"])

    creada = _crear(device_client, table_id=tables[0].id, at=datetime(2026, 3, 11, 1, 0, tzinfo=timezone.utc)).json()

    sin_motivo = device_client.post(f"/api/v1/reservations/{creada['id']}/close", json={"status": "cancelled"})
    assert sin_motivo.status_code == 400, sin_motivo.text
    assert sin_motivo.json()["error"]["code"] == "REASON_REQUIRED"

    ok = device_client.post(
        f"/api/v1/reservations/{creada['id']}/close",
        json={"status": "cancelled", "reason": "Llamaron a cancelar"},
    )
    assert ok.status_code == 200, ok.text
    assert ok.json()["status"] == "cancelled"
    assert ok.json()["closed_reason"] == "Llamaron a cancelar"

    # **La fila queda.** Quién canceló y por qué es lo que alguien mira a fin
    # de mes; un borrado lo haría imposible.
    listado = device_client.get("/api/v1/reservations", params={"date": creada["business_date"]}).json()
    assert [r["id"] for r in listado] == [creada["id"]]

    # Y la mesa cancelada deja de apartar nada.
    plano = device_client.get("/api/v1/tables/status")
    mesas = [m for z in plano.json()["zones"] for m in z["tables"]]
    assert next(m for m in mesas if m["id"] == tables[0].id)["reservation"] is None

    # Cerrar dos veces no se deja: el segundo pisaría el motivo del primero.
    otra_vez = device_client.post(
        f"/api/v1/reservations/{creada['id']}/close", json={"status": "no_show"}
    )
    assert otra_vez.status_code == 409, otra_vez.text
    assert otra_vez.json()["error"]["code"] == "RESERVATION_NOT_OPEN"
