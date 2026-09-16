"""Invariantes de identidad, aislamiento y datos personales.

Auditor de control interno (rol Legal de `.claude/skills/agentes/`): acá no se
prueba "que se pueda entrar", se prueba **que no se pueda ver ni hacer lo que
no corresponde**. Fuentes: `docs/SPEC-NEGOCIO.md §2.1, §2.2, §8.4, §11`,
`AGENTS.md` (reglas propias) y `.claude/AGENTS.md` (Seguridad).

`§8.4` manda minimización: el dispositivo compartido del salón es el punto más
expuesto del sistema (una tablet en un mostrador), así que todo dato personal
que no necesite para operar simplemente no viaja hasta él.
"""

from __future__ import annotations

from typing import Any

from sqlalchemy import select

from tests.audit.conftest import (
    NO_TIP,
    add_items,
    create_order,
    deep_keys,
    denoms,
    get_order,
    idem_headers,
    pay,
)

API = "/api/v1"

MONEY_SECRETS = ("cost", "margin", "unit_cost", "food_cost")
CREDENTIAL_KEYS = ("pin", "pin_hash", "password", "password_hash", "store_pin_hash")


# ---------------------------------------------------------------------------
# Helpers de inspección
# ---------------------------------------------------------------------------


def _looks_like_jwt(value: Any) -> bool:
    return isinstance(value, str) and value.count(".") == 2 and value.startswith("eyJ")


def _contains_jwt(payload: Any) -> bool:
    if isinstance(payload, dict):
        return any(_contains_jwt(v) for v in payload.values())
    if isinstance(payload, list):
        return any(_contains_jwt(v) for v in payload)
    return _looks_like_jwt(payload)


def _assert_error_shape(resp: Any, *, status: int) -> dict:
    """§11.18 y CONTRATO-INTERNO §6: una sola forma de error, siempre."""
    assert resp.status_code == status, f"{resp.request.url} → {resp.status_code}: {resp.text}"
    body = resp.json()
    assert set(body.keys()) == {"error"}, f"forma de error inesperada: {body}"
    error = body["error"]
    assert isinstance(error.get("code"), str) and error["code"], f"sin code: {body}"
    assert isinstance(error.get("message"), str) and error["message"].strip(), f"sin message: {body}"
    return error


def _schema_refs(node: Any) -> list[str]:
    found: list[str] = []
    if isinstance(node, dict):
        for key, value in node.items():
            if key == "$ref" and isinstance(value, str) and "/components/schemas/" in value:
                found.append(value.rsplit("/", 1)[-1])
            else:
                found += _schema_refs(value)
    elif isinstance(node, list):
        for value in node:
            found += _schema_refs(value)
    return found


def _property_names_reachable_from(spec: dict, path_prefixes: tuple[str, ...]) -> set[str]:
    """Nombres de propiedad de todo esquema alcanzable desde esas rutas."""
    schemas = spec.get("components", {}).get("schemas", {})
    pending = [
        ref
        for path, item in spec["paths"].items()
        if path.startswith(path_prefixes)
        for ref in _schema_refs(item)
    ]
    seen: set[str] = set()
    names: set[str] = set()
    while pending:
        current = pending.pop()
        if current in seen:
            continue
        seen.add(current)
        schema = schemas.get(current, {})
        names |= set(schema.get("properties", {}).keys())
        pending += _schema_refs(schema)
    return names


# ---------------------------------------------------------------------------
# Sesión: cookie httpOnly, nunca un token en el cuerpo
# ---------------------------------------------------------------------------


def test_admin_login_and_device_activation_set_httponly_samesite_cookies(
    client: Any, employees: dict[str, Any], store: Any
) -> None:
    """§11.11 y `.claude/AGENTS.md` (Seguridad): sesión en cookie `httpOnly`;
    nunca un token que el JavaScript de la página pueda leer o guardar."""
    login = client.post(
        f"{API}/auth/admin/login", json={"email": "admin@test.local", "password": "admin1234"}
    )
    assert login.status_code == 200, login.text
    activate = client.post(
        f"{API}/auth/device/activate", json={"store_id": store.id, "store_pin": "123456"}
    )
    assert activate.status_code == 200, activate.text

    for resp, name in ((login, "admin_session"), (activate, "device_session")):
        cookies = [c for c in resp.headers.get_list("set-cookie") if c.startswith(f"{name}=")]
        assert cookies, f"{name} no se emitió como cookie"
        raw = cookies[0].lower()
        assert "httponly" in raw, f"{name} sin HttpOnly: {cookies[0]}"
        assert "samesite=" in raw, f"{name} sin SameSite: {cookies[0]}"
        assert "samesite=none" not in raw, f"{name} con SameSite=None: {cookies[0]}"


def test_the_session_cookie_is_secure_outside_development() -> None:
    """§11.11 («sesión en cookie httpOnly») leída hasta el final: una cookie de
    sesión que viaja por HTTP plano en producción es una cookie robada.

    `app/core/security.py` fija `secure=(settings.ENV == "production")`; este
    test verifica la decisión en el código, no el header, porque el `TestClient`
    corre siempre con `ENV="test"`.

    NOTA DEL AUDITOR (no se prueba acá porque la spec no lo declara, va como
    hallazgo): `settings.JWT_SECRET` tiene el default `"dev-secret-change-me"`
    escrito en el repositorio y nada impide arrancar en producción con él.
    """
    import inspect

    from app.core import security

    source = inspect.getsource(security)
    assert 'secure=(settings.ENV == "production")' in source, (
        "la cookie de sesión tiene que marcarse `secure` en producción"
    )
    assert "httponly=True" in source, "la cookie de sesión tiene que ser HttpOnly"
    assert "samesite=" in source, "la cookie de sesión tiene que declarar SameSite"


def test_no_auth_response_body_ever_carries_a_token(
    client: Any, device_client: Any, employees: dict[str, Any], store: Any, identify: Any
) -> None:
    """§2.1: «ninguna sesión ni token vive en localStorage» — la única forma de
    cumplirlo es que el token nunca llegue al cuerpo de la respuesta."""
    bodies = [
        client.post(
            f"{API}/auth/admin/login", json={"email": "admin@test.local", "password": "admin1234"}
        ).json(),
        client.post(
            f"{API}/auth/device/activate", json={"store_id": store.id, "store_pin": "123456"}
        ).json(),
        identify(device_client, employees["operator"]).json(),
        device_client.get(f"{API}/auth/me").json(),
    ]
    for body in bodies:
        assert not _contains_jwt(body), f"un token viajó en el cuerpo: {body}"
        leaked = {k for k in deep_keys(body) if "token" in k.lower() or "jwt" in k.lower()}
        assert not leaked, f"claves de token en el cuerpo: {sorted(leaked)}"


# ---------------------------------------------------------------------------
# Credenciales y datos personales
# ---------------------------------------------------------------------------


def test_no_endpoint_ever_returns_a_pin_or_a_password_hash(
    admin_client: Any, device_client: Any, employees: dict[str, Any], identify: Any, store: Any
) -> None:
    """§2.1 (PIN hasheado) y `.claude/AGENTS.md`: el PIN y la contraseña nunca
    aparecen en una respuesta, ni en claro ni hasheados."""
    payloads = [
        admin_client.get(f"{API}/admin/employees").json(),
        admin_client.get(f"{API}/auth/me").json(),
        identify(device_client, employees["operator"]).json(),
        device_client.get(f"{API}/auth/me").json(),
    ]
    for payload in payloads:
        keys = {k.lower() for k in deep_keys(payload)}
        leaked = {k for k in keys if any(secret in k for secret in CREDENTIAL_KEYS)}
        assert not leaked, f"credenciales expuestas: {sorted(leaked)}"


def test_employee_document_never_reaches_a_device_session(
    admin_client: Any, device_client: Any, employees: dict[str, Any], identify: Any
) -> None:
    """§7 y §8.4: el documento del empleado es un dato personal «sólo admin».
    Una tablet compartida del salón no tiene por qué verlo."""
    document = "CC-1020304050"
    patched = admin_client.patch(
        f"{API}/admin/employees/{employees['operator'].id}", json={"document": document}
    )
    assert patched.status_code == 200, patched.text
    assert patched.json()["document"] == document, "el administrador sí lo ve"

    identified = identify(device_client, employees["operator"])
    assert identified.status_code == 200, identified.text
    me = device_client.get(f"{API}/auth/me")

    for payload in (identified.json(), me.json()):
        assert "document" not in deep_keys(payload), f"el documento viajó al dispositivo: {payload}"
        assert document not in identified.text
        assert document not in me.text


# ---------------------------------------------------------------------------
# PIN: bloqueo por intentos y expiración de la persona activa
# ---------------------------------------------------------------------------


def test_five_failed_pins_lock_the_person_and_a_correct_pin_stays_locked(
    device_client: Any, employees: dict[str, Any], identify: Any, clock: Any
) -> None:
    """§2.1: «cinco intentos fallidos bloquean la identificación de esa persona
    por 15 minutos y avisan al administrador»."""
    victim = employees["operator3"]

    codes = [identify(device_client, victim, pin="0000").json()["error"]["code"] for _ in range(5)]
    assert codes[-1] == "PIN_LOCKED", f"el quinto intento fallido bloquea: {codes}"

    sexto = identify(device_client, victim)  # PIN correcto
    assert sexto.status_code == 400, sexto.text
    assert sexto.json()["error"]["code"] == "PIN_LOCKED", "un PIN correcto no levanta el bloqueo"

    clock.advance(minutes=16)
    despues = identify(device_client, victim)
    assert despues.status_code == 200, despues.text


def test_pin_lock_notifies_the_administrator(
    device_client: Any, admin_client: Any, employees: dict[str, Any], identify: Any, store: Any
) -> None:
    """§2.1: el bloqueo «avisa al administrador» — si no avisa, un ataque de
    fuerza bruta sobre una tablet pasa inadvertido."""
    for _ in range(5):
        identify(device_client, employees["operator3"], pin="0000")

    notifications = admin_client.get(f"{API}/admin/notifications", params={"store_id": store.id})
    assert notifications.status_code == 200, notifications.text
    assert "pin_locked" in [n["type"] for n in notifications.json()]


def test_the_active_person_expires_and_a_cash_write_asks_to_identify_again(
    device_client: Any, open_shift: Any, clock: Any
) -> None:
    """§2.1: la persona activa queda «hasta que pasan N minutos sin uso» —
    «así una tablet abandonada no vende a nombre de quien la dejó»
    (atribución cruzada, auditoría H9 de la referencia)."""
    shift = open_shift()

    clock.advance(minutes=30)

    resp = device_client.post(
        f"{API}/shifts/{shift['id']}/cash-movements",
        json={"kind": "expense", "cause": "petty_expense", "amount": 5_000},
        headers=idem_headers(),
    )
    error = _assert_error_shape(resp, status=401)
    assert error["code"] == "IDENTIFY_REQUIRED"


# ---------------------------------------------------------------------------
# Matriz de autorizaciones: el supervisor no autoriza plata
# ---------------------------------------------------------------------------


def test_supervisor_authorizes_discounts_but_never_cash(
    device_client: Any, employees: dict[str, Any], identify: Any
) -> None:
    """§2.2: el supervisor «autoriza anulaciones, cortesías y descuentos sobre
    el límite; **no** autoriza retiros ni rescates de turno». Un PIN compartido
    de administrador convierte la autorización en teatro."""
    identify(device_client, employees["operator"])

    permitido = device_client.post(
        f"{API}/auth/authorize", json={"pin": "5555", "action": "discount_over_limit"}
    )
    assert permitido.status_code == 200, permitido.text
    assert permitido.json()["authorizer"]["role"] == "supervisor"

    for action in ("pickup", "spot_check"):
        negado = device_client.post(f"{API}/auth/authorize", json={"pin": "5555", "action": action})
        error = _assert_error_shape(negado, status=400)
        assert error["code"] == "AUTHORIZATION_NOT_ALLOWED", f"{action}: {error}"


def test_with_roles_supervisor_disabled_a_supervisor_authorizes_nothing(
    device_client: Any, employees: dict[str, Any], identify: Any, set_feature: Any
) -> None:
    """§1.1: toda función opcional se hace cumplir en el backend; con
    `roles.supervisor` apagada el rol deja de poder autorizar."""
    set_feature("roles.supervisor", False)
    identify(device_client, employees["operator"])

    negado = device_client.post(
        f"{API}/auth/authorize", json={"pin": "5555", "action": "discount_over_limit"}
    )
    error = _assert_error_shape(negado, status=400)
    assert error["code"] == "AUTHORIZATION_NOT_ALLOWED"


def test_a_locked_pin_cannot_authorize_anything(
    device_client: Any, employees: dict[str, Any], identify: Any, clock: Any
) -> None:
    """CONTRATO-INTERNO §2 (`verify_authorizer`): «bloqueado → 400 PIN_LOCKED».
    Un PIN bloqueado por intentos fallidos en la pantalla de identificarse no
    puede seguir autorizando una cortesía desde el mismo dispositivo: si
    autorizara, bloquear el PIN sería cosmético.

    NOTA DEL AUDITOR (hallazgo, no test: la spec no lo declara): el propio
    `POST /auth/authorize` NO lleva contador de intentos. Un PIN de 4 dígitos
    sin tope es un oráculo de 10.000 combinaciones desde la tablet; acá se
    prueba lo que el contrato sí fija, y el hueco va al entregable.
    """
    supervisor = employees["supervisor"]

    # Cinco PIN equivocados en `identify` bloquean a esa persona (§2.1).
    for _ in range(5):
        identify(device_client, supervisor, pin="0000")

    identify(device_client, employees["operator"])
    negado = device_client.post(f"{API}/auth/authorize", json={"pin": "5555", "action": "courtesy"})
    error = _assert_error_shape(negado, status=400)
    assert error["code"] == "PIN_LOCKED", (
        "un PIN bloqueado no autoriza nada hasta que pase el bloqueo; "
        f"respondió {error['code']}"
    )

    # Pasado el bloqueo, el mismo PIN vuelve a autorizar: bloquear no es borrar.
    clock.advance(minutes=16)
    identify(device_client, employees["operator"])  # la persona activa expiró con el reloj
    de_nuevo = device_client.post(f"{API}/auth/authorize", json={"pin": "5555", "action": "courtesy"})
    assert de_nuevo.status_code == 200, de_nuevo.text


def test_an_authorization_is_recorded_against_the_person_who_gave_it(
    device_client: Any, admin_client: Any, employees: dict[str, Any], identify: Any
) -> None:
    """§2.2: «cada autorización queda a nombre de quien la dio: existe un
    reporte de autorizaciones por autorizador»."""
    identify(device_client, employees["operator"])
    assert device_client.post(
        f"{API}/auth/authorize", json={"pin": "5555", "action": "courtesy"}
    ).status_code == 200

    rows = admin_client.get(
        f"{API}/admin/authorizations", params={"authorizer_id": employees["supervisor"].id}
    )
    assert rows.status_code == 200, rows.text
    actions = [r["action"] for r in rows.json()]
    assert "courtesy" in actions
    assert all(r["authorizer_id"] == employees["supervisor"].id for r in rows.json())


# ---------------------------------------------------------------------------
# Aislamiento por organización y por sede: un id ajeno es 404, nunca 403
# ---------------------------------------------------------------------------


def test_admin_of_one_organization_gets_404_reading_another_organizations_data(
    admin_client: Any, other_org: dict[str, Any]
) -> None:
    """§1.1 y §2.2: «un id de otra organización responde 404» — nunca 403 ni
    200 (commit 305e335 de la referencia: «cerrar el mes» de la sede vecina
    estaba a un número de distancia). El 403 delataría que el id existe."""
    store_b_id = other_org["store"].id
    reads = [
        admin_client.get(f"{API}/admin/stores/{store_b_id}/cash-settings"),
        admin_client.get(f"{API}/admin/stores/{store_b_id}/fiscal"),
        admin_client.get(f"{API}/admin/employees/{other_org['employee'].id}/activity"),
        admin_client.get(f"{API}/shifts/{other_org['shift'].id}"),
        admin_client.get(f"{API}/admin/shifts/{other_org['shift'].id}/timeline"),
        admin_client.get(f"{API}/admin/products", params={"store_id": store_b_id}),
        admin_client.get(f"{API}/admin/shifts", params={"store_id": store_b_id}),
    ]
    for resp in reads:
        _assert_error_shape(resp, status=404)


def test_admin_of_one_organization_gets_404_writing_another_organizations_data(
    admin_client: Any, other_org: dict[str, Any]
) -> None:
    """La misma regla en escritura: leer de más es una fuga, escribir de más es
    un desastre."""
    store_b_id = other_org["store"].id
    writes = [
        admin_client.patch(f"{API}/admin/stores/{store_b_id}", json={"name": "Robada"}),
        admin_client.patch(f"{API}/admin/employees/{other_org['employee'].id}", json={"name": "X"}),
        admin_client.post(f"{API}/admin/shifts/{other_org['shift'].id}/review", json={"note": "x"}),
        admin_client.post(
            f"{API}/admin/shifts/{other_org['shift'].id}/close-administrative", json={"reason": "x"}
        ),
        admin_client.put(
            f"{API}/admin/features/cash.handovers", json={"enabled": False, "store_id": store_b_id}
        ),
        admin_client.post(
            f"{API}/admin/categories", params={"store_id": store_b_id}, json={"name": "X"}
        ),
    ]
    for resp in writes:
        _assert_error_shape(resp, status=404)


def test_a_device_of_one_store_gets_404_on_a_shift_of_another_store(
    device_client: Any, identify: Any, employees: dict[str, Any], other_org: dict[str, Any]
) -> None:
    """El aislamiento no es solo entre organizaciones: también entre sedes."""
    identify(device_client, employees["cashier"])
    shift_b = other_org["shift"].id

    _assert_error_shape(device_client.get(f"{API}/shifts/{shift_b}"), status=404)
    _assert_error_shape(
        device_client.post(
            f"{API}/shifts/{shift_b}/cash-movements",
            json={"kind": "expense", "cause": "petty_expense", "amount": 1_000},
            headers=idem_headers(),
        ),
        status=404,
    )


# ---------------------------------------------------------------------------
# El operador no ve costos ni márgenes
# ---------------------------------------------------------------------------


def test_device_catalog_never_carries_cost_or_margin(device_client: Any, catalog_seeded: Any) -> None:
    """§2.2 y §11.10: «el operador no ve costos ni márgenes: los esquemas de
    respuesta para dispositivo no tienen esos campos»."""
    resp = device_client.get(f"{API}/catalog")
    assert resp.status_code == 200, resp.text

    keys = {k.lower() for k in deep_keys(resp.json())}
    leaked = {k for k in keys if any(secret in k for secret in MONEY_SECRETS)}
    assert not leaked, f"el catálogo de dispositivo filtró {sorted(leaked)}"


def test_openapi_of_catalog_and_shifts_declares_no_cost_fields(client: Any) -> None:
    """El mismo control sobre el contrato publicado: si el esquema lo declara,
    tarde o temprano alguien lo llena (checklist 1a: «test que inspecciona el
    OpenAPI y la respuesta»)."""
    spec = client.get("/openapi.json").json()
    names = _property_names_reachable_from(spec, (f"{API}/catalog", f"{API}/shifts"))
    assert names, "no se encontró ningún esquema bajo /catalog ni /shifts"

    leaked = {n for n in names if any(secret in n.lower() for secret in MONEY_SECRETS)}
    assert not leaked, f"el OpenAPI declara campos de costo: {sorted(leaked)}"


# ---------------------------------------------------------------------------
# Forma del error y funciones apagadas
# ---------------------------------------------------------------------------


def test_every_sampled_error_has_exactly_one_shape(
    client: Any, device_client: Any, admin_client: Any, open_shift: Any, other_org: dict[str, Any]
) -> None:
    """§11.18 y §12: «una sola forma `{error:{code,message}}`», con `message`
    para humanos y `code` estable para el frontend."""
    shift = open_shift()

    _assert_error_shape(client.get(f"{API}/shifts/current"), status=401)
    _assert_error_shape(client.get(f"{API}/admin/employees"), status=401)
    _assert_error_shape(admin_client.get(f"{API}/shifts/{other_org['shift'].id}"), status=404)
    _assert_error_shape(
        device_client.post(
            f"{API}/shifts/{shift['id']}/cash-swaps",
            json={"out": denoms(10_000), "in": denoms(5_000)},
        ),
        status=400,
    )
    _assert_error_shape(
        device_client.post(f"{API}/auth/device/identify", json={"employee_id": 1, "pin": "12"}),
        status=400,
    )
    _assert_error_shape(
        admin_client.post(f"{API}/admin/shifts/{shift['id']}/reopen", json={"reason": "x"}),
        status=409,
    )


def test_a_disabled_feature_is_refused_by_the_backend_naming_the_feature(
    device_client: Any, admin_client: Any, open_shift: Any, set_feature: Any, store: Any
) -> None:
    """§1.1 y §11.19: «el backend hace cumplir los flags. Un endpoint de una
    función deshabilitada responde 400 FEATURE_DISABLED nombrando la función;
    la interfaz oculta lo deshabilitado, pero nunca es la única barrera»."""
    shift = open_shift()
    set_feature("cash.handovers", False)
    set_feature("pos.combos", False)

    handover = device_client.post(
        f"{API}/shifts/{shift['id']}/handovers",
        json={"kind": "spot_check", "counted_cash": denoms(200_000), "authorizer_pin": "9999"},
        headers=idem_headers(),
    )
    error = _assert_error_shape(handover, status=400)
    assert error["code"] == "FEATURE_DISABLED"
    assert error.get("feature") == "cash.handovers", f"el error nombra la función: {error}"

    combos = admin_client.get(f"{API}/admin/combos", params={"store_id": store.id})
    error = _assert_error_shape(combos, status=400)
    assert error["code"] == "FEATURE_DISABLED"
    assert error.get("feature") == "pos.combos"


# ---------------------------------------------------------------------------
# Lo fiscal que sí entra en 1a (§8.1 y Ley 1935 de 2018)
# ---------------------------------------------------------------------------


def test_fiscal_configuration_always_carries_a_valid_from(admin_client: Any, store: Any) -> None:
    """§8.1: «cada cambio tiene `valid_from`, porque la condición se define por
    año gravable». Sin vigencia, revalorar una venta vieja con el régimen de hoy
    es inevitable."""
    current = admin_client.get(f"{API}/admin/stores/{store.id}/fiscal")
    assert current.status_code == 200, current.text
    assert current.json()["valid_from"], "la configuración vigente declara desde cuándo aplica"

    sin_vigencia = {k: v for k, v in current.json().items() if k not in ("valid_from", "id")}
    rechazo = admin_client.put(f"{API}/admin/stores/{store.id}/fiscal", json=sin_vigencia)
    error = _assert_error_shape(rechazo, status=400)
    assert error["code"] == "FISCAL_VALID_FROM_REQUIRED"

    con_vigencia = {**sin_vigencia, "valid_from": "2027-01-01"}
    assert admin_client.put(f"{API}/admin/stores/{store.id}/fiscal", json=con_vigencia).status_code == 200
    history = admin_client.get(f"{API}/admin/stores/{store.id}/fiscal/history").json()
    assert len(history) >= 2, "la versión anterior no se pisa: queda el historial"


def test_a_suggested_tip_over_ten_percent_is_rejected(admin_client: Any, store: Any) -> None:
    """Ley 1935 de 2018 (`AGENTS.md`, §3.4): «el porcentaje sugerido no puede
    superar el 10 %»."""
    current = admin_client.get(f"{API}/admin/stores/{store.id}/sales-settings").json()

    rechazo = admin_client.put(
        f"{API}/admin/stores/{store.id}/sales-settings", json={**current, "tip_suggested_pct": 12}
    )
    error = _assert_error_shape(rechazo, status=400)
    assert error["code"] == "TIP_PCT_OVER_LIMIT"

    aceptado = admin_client.put(
        f"{API}/admin/stores/{store.id}/sales-settings", json={**current, "tip_suggested_pct": 10}
    )
    assert aceptado.status_code == 200, aceptado.text


# ---------------------------------------------------------------------------
# Auditoría con antes y después
# ---------------------------------------------------------------------------


def test_changing_a_feature_flag_leaves_an_audit_row_with_before_and_after(
    admin_client: Any,
) -> None:
    """§1.1: «cambiar un flag queda en auditoría», y el checklist 1a pide que la
    fila tenga antes y después."""
    # Primer cambio: crea el estado. Segundo: el `before` ya es un valor real.
    assert admin_client.put(f"{API}/admin/features/cash.handovers", json={"enabled": False}).status_code == 200
    assert admin_client.put(f"{API}/admin/features/cash.handovers", json={"enabled": True}).status_code == 200

    rows = admin_client.get(f"{API}/admin/audit", params={"entity": "feature"})
    assert rows.status_code == 200, rows.text
    changes = [r for r in rows.json() if r["entity_id"] == "cash.handovers"]
    assert len(changes) == 2, f"cada cambio de flag deja su fila: {changes}"

    latest = changes[0]
    assert latest["before"] is not None, "la fila registra el valor anterior"
    assert latest["after"] is not None
    assert latest["before"] != latest["after"], "antes y después tienen que diferir"
    assert latest["actor_employee_id"] is not None, "la auditoría dice quién lo hizo"


def test_changing_cash_settings_leaves_an_audit_row_with_before_and_after(
    admin_client: Any, store: Any
) -> None:
    """§11.3: «nada financiero se edita en silencio»: cambiar una tolerancia de
    caja es cambiar el control, y queda con antes y después."""
    current = admin_client.get(f"{API}/admin/stores/{store.id}/cash-settings").json()
    updated = {**current, "tolerance_unknown_cause": current["tolerance_unknown_cause"] + 5_000}
    assert admin_client.put(f"{API}/admin/stores/{store.id}/cash-settings", json=updated).status_code == 200

    rows = admin_client.get(f"{API}/admin/audit", params={"entity": "store_cash_settings"})
    assert rows.status_code == 200, rows.text
    assert rows.json(), "el cambio de configuración de caja deja auditoría"

    row = rows.json()[0]
    assert row["before"] is not None and row["after"] is not None
    assert row["before"] != row["after"]
    assert row["before"]["tolerance_unknown_cause"] != row["after"]["tolerance_unknown_cause"]


# ===========================================================================
# PEDIDO 1b-1 — comanda, cocina, cobro y comprobante
# ===========================================================================


# ---------------------------------------------------------------------------
# Privacidad del personal (A-7 y A-9 de 1a, resueltos en 1b-1; §5.9, §8.4)
# ---------------------------------------------------------------------------


def test_the_employee_audit_trail_never_stores_the_document_or_the_email(
    admin_client: Any, employees: dict[str, Any]
) -> None:
    """**A-7, resuelto por default en 1b-1** (`CONTRATO-INTERNO-1b-1.md §5.9`,
    `docs/ESTADO.md`): el `before`/`after` de la auditoría de `employee` no
    guarda `document` ni `email`.

    §8.4 (minimización, Ley 1581 de 2012): la auditoría es un registro que se
    conserva años, lo lee cualquier administrador y se exporta a CSV. Copiar
    ahí la cédula y el correo de cada empleado cada vez que alguien le cambia
    el PIN multiplica el dato personal por cada edición, sin ninguna finalidad
    que lo ampare. El maestro (`GET /admin/employees`) los sigue mostrando al
    administrador: el dato no se pierde, deja de replicarse.
    """
    empleado = employees["operator"]
    documento = "CC-99887766"
    correo = "mesero@ejemplo.local"

    creado = admin_client.post(
        f"{API}/admin/employees",
        json={
            "name": "Nuevo Con Datos",
            "role": "operator",
            "pin": "7788",
            "store_id": empleado.store_id,
            "document": documento,
            "email": correo,
        },
    )
    assert creado.status_code in (200, 201), creado.text
    nuevo_id = creado.json()["id"]

    editado = admin_client.patch(
        f"{API}/admin/employees/{nuevo_id}", json={"document": "CC-11112222", "email": "otro@ejemplo.local"}
    )
    assert editado.status_code == 200, editado.text

    filas = admin_client.get(f"{API}/admin/audit", params={"entity": "employee"})
    assert filas.status_code == 200, filas.text
    assert filas.json(), "crear y editar un empleado tiene que dejar auditoría"

    for fila in filas.json():
        for lado in ("before", "after"):
            if fila[lado] is None:
                continue
            claves = {k.lower() for k in deep_keys(fila[lado])}
            assert "document" not in claves, f"la auditoría guardó el documento: {fila[lado]}"
            assert "email" not in claves, f"la auditoría guardó el correo: {fila[lado]}"
    assert documento not in filas.text and correo not in filas.text, (
        "ni siquiera como valor suelto en el JSON de la auditoría"
    )

    maestro = admin_client.get(f"{API}/admin/employees")
    assert any(e.get("document") == "CC-11112222" for e in maestro.json()), (
        "el administrador sigue viendo el documento en el maestro: A-7 quita la copia, no el dato"
    )


def test_the_device_employee_list_shows_only_id_name_and_role(
    device_client: Any, admin_client: Any, db: Any, employees: dict[str, Any], store: Any
) -> None:
    """**A-9, resuelto en 1b-1**: `GET /device/employees` es la lista de
    «Quién opera» de §9.1 — reemplaza teclear el número de empleado a mano en
    cuatro pantallas.

    Es una lista **sin sesión de persona**, en una tablet compartida del
    salón: cualquiera que pase la ve. Por eso lleva exactamente tres campos
    (`id`, `name`, `role`) y ninguno más. `document` y `email` son datos
    personales (§8.4); `discount_limit_pct` y `can_charge` son el mapa de
    quién puede autorizar qué, que es justo lo que no se le muestra a quien
    quiera abusarlo.
    """
    # Un inactivo y alguien de otra sede no tienen por qué aparecer.
    inactivo = admin_client.post(
        f"{API}/admin/employees",
        json={"name": "Ya No Trabaja", "role": "operator", "pin": "7001", "store_id": store.id},
    )
    assert inactivo.status_code in (200, 201), inactivo.text
    assert admin_client.patch(
        f"{API}/admin/employees/{inactivo.json()['id']}", json={"active": False}
    ).status_code == 200

    from app.auth.models import Employee
    from app.core import clock as clock_module
    from app.core import security as security_module
    from app.stores.models import Store

    now = clock_module.now_utc()
    otra_sede = Store(
        organization_id=store.organization_id,
        name="Sede Vecina",
        nit="900123457",
        dv="8",
        legal_name="Organización Demo SAS",
        address="Calle 2",
        municipality_dane="11001",
        opening_hours=[],
        cutoff_hour=6,
        active_channels=["counter"],
        store_pin_hash=security_module.hash_secret("654321"),
        active=True,
        created_at=now,
        updated_at=now,
    )
    db.add(otra_sede)
    db.flush()
    ajeno = Employee(
        organization_id=store.organization_id,
        store_id=otra_sede.id,
        name="De Otra Sede",
        role="operator",
        pin_hash=security_module.hash_secret("7002"),
        can_charge=False,
        active=True,
        failed_pin_attempts=0,
        created_at=now,
        updated_at=now,
    )
    db.add(ajeno)
    db.commit()

    resp = device_client.get(f"{API}/device/employees")
    assert resp.status_code == 200, resp.text
    listado = resp.json()
    assert listado, "el dispositivo tiene que poder ofrecer a alguien"

    for persona in listado:
        assert set(persona.keys()) == {"id", "name", "role"}, (
            f"la lista del dispositivo trae campos de más: {sorted(persona.keys())}"
        )

    nombres = {p["name"] for p in listado}
    assert "Ya No Trabaja" not in nombres, "un inactivo no puede seguir ofreciéndose para operar"
    assert "De Otra Sede" not in nombres, "ni alguien que trabaja en otra sede"
    assert "Admin" in nombres, "el admin de la organización sí (store_id NULL): tiene PIN de POS"
    assert "Cashier" in nombres and "Supervisor" in nombres

    prohibidos = ("document", "email", "discount_limit_pct", "can_charge", "pin", "hash", "password")
    claves = {k.lower() for k in deep_keys(listado)}
    filtrado = {k for k in claves if any(p in k for p in prohibidos)}
    assert not filtrado, f"la lista del dispositivo filtró {sorted(filtrado)}"


def test_the_device_employee_list_requires_an_activated_device(client: Any) -> None:
    """La misma lista, sin dispositivo activado: `401`. Si respondiera, el
    personal completo de una sede sería público para cualquiera que conozca la
    URL — y los nombres del personal son dato personal (§8.4)."""
    resp = client.get(f"{API}/device/employees")
    assert resp.status_code == 401, resp.text
    assert resp.json()["error"]["code"], "y con la forma de error de siempre"


# ---------------------------------------------------------------------------
# El operador no ve costos: ahora también en venta, cocina y comprobante
# ---------------------------------------------------------------------------


def test_no_sale_response_for_a_device_carries_cost_margin_or_unit_cost(
    device_client: Any, open_shift: Any, sales_products: Any
) -> None:
    """§11.10 y `AGENTS.md`: «el operador no recibe costos ni márgenes en
    ninguna respuesta de la API».

    En 1b-1 la superficie crece: la comanda congela `unit_cost` y
    `recipe_version` en la fila del ítem (gancho de fase 2,
    `CONTRATO-INTERNO-1b-1.md §2.2`), así que ahora existe una columna de
    costo a un `model_dump()` de distancia del mostrador. La columna puede
    existir; **serializarla hacia el dispositivo, no**.
    """
    open_shift()
    order = create_order(device_client, channel="counter").json()
    order = add_items(
        device_client, order, [{"product_id": sales_products["inc8"].id, "qty": 1}]
    ).json()
    envio = device_client.post(
        f"{API}/orders/{order['id']}/send",
        json={"expected_version": order["version"]},
        headers=idem_headers(),
    )
    assert envio.status_code == 200, envio.text
    order = envio.json()

    precuenta = device_client.post(
        f"{API}/orders/{order['id']}/bill/present",
        json={"expected_version": order["version"]},
        headers=idem_headers(),
    )
    assert precuenta.status_code == 200, precuenta.text

    order = get_order(device_client, order["id"])
    cobro = pay(
        device_client,
        order["id"],
        splits=[{"method": "cash", "amount": order["totals"]["total"]}],
        tip=NO_TIP,
    )
    assert cobro.status_code == 201, cobro.text
    doc_id = cobro.json()["document"]["id"]

    respuestas = {
        "GET /orders": device_client.get(f"{API}/orders"),
        "GET /orders/{id}": device_client.get(f"{API}/orders/{order['id']}"),
        "GET /orders/favorites": device_client.get(f"{API}/orders/favorites"),
        "GET /tables/status": device_client.get(f"{API}/tables/status"),
        "GET /kitchen/rounds": device_client.get(f"{API}/kitchen/rounds"),
        "POST /orders/{id}/bill/present": precuenta,
        "POST /orders/{id}/payments": cobro,
        "GET /documents/{id}": device_client.get(f"{API}/documents/{doc_id}"),
        "GET /documents/last": device_client.get(f"{API}/documents/last"),
    }
    for nombre, resp in respuestas.items():
        assert resp.status_code in (200, 201), f"{nombre}: {resp.text}"
        claves = {k.lower() for k in deep_keys(resp.json())}
        filtrado = {k for k in claves if any(secret in k for secret in MONEY_SECRETS)}
        assert not filtrado, f"{nombre} filtró {sorted(filtrado)}"
        assert "recipe_version" not in claves, f"{nombre} filtró la versión de receta"


def test_the_openapi_of_orders_kitchen_payments_and_documents_declares_no_cost_fields(
    client: Any,
) -> None:
    """El mismo control sobre el contrato publicado. Un campo declarado en el
    esquema es un campo que alguien va a llenar: el `unit_cost` del ítem tiene
    que quedarse en la tabla y no aparecer nunca en `OrderItemOut`."""
    spec = client.get("/openapi.json").json()
    names = _property_names_reachable_from(
        spec,
        (
            f"{API}/orders",
            f"{API}/tables",
            f"{API}/kitchen",
            f"{API}/documents",
            f"{API}/admin/orders",
            f"{API}/admin/documents",
        ),
    )
    assert names, "no se encontró ningún esquema bajo /orders, /kitchen ni /documents"

    leaked = {n for n in names if any(secret in n.lower() for secret in MONEY_SECRETS)}
    assert not leaked, f"el OpenAPI de la venta declara campos de costo: {sorted(leaked)}"
    assert "recipe_version" not in {n.lower() for n in names}


# ---------------------------------------------------------------------------
# Aislamiento por organización y por sede en la venta (§1.1, §11.1)
# ---------------------------------------------------------------------------


def _relocate_sale(db: Any, order_id: int, *, organization_id: int, store_id: int) -> None:
    """Muda una venta ya creada (comanda, ítems y documento) a otra
    organización/sede.

    Por qué así y no armando las filas a mano: lo que se audita es el **filtro
    de la consulta**, no la capacidad de construir un `Order` válido con
    treinta columnas. Mudar una venta real deja los datos coherentes y prueba
    exactamente lo que importa — que un id ajeno responda `404` y no `403`
    (un `403` confirmaría que el id existe) ni `200`.
    """
    from app.fiscal.models import FiscalDocument
    from app.orders.models import Order, OrderItem

    order = db.get(Order, order_id)
    assert order is not None
    order.organization_id = organization_id
    order.store_id = store_id
    for item in db.execute(select(OrderItem).where(OrderItem.order_id == order_id)).scalars():
        item.organization_id = organization_id
        item.store_id = store_id
    for doc in db.execute(select(FiscalDocument).where(FiscalDocument.order_id == order_id)).scalars():
        doc.organization_id = organization_id
        doc.store_id = store_id
    db.commit()


def test_a_device_gets_404_on_an_order_a_kitchen_round_and_a_document_of_another_store(
    device_client: Any, db: Any, open_shift: Any, sales_products: Any, store: Any, org_b: Any, store_b: Any
) -> None:
    """§1.1 y §11.1: «organización → sede; toda consulta se acota por
    organización y sede (un id ajeno es `404`)».

    Es la regla que hace vendible el producto: dos restaurantes distintos en
    la misma base de datos. Se prueba en **lectura y en escritura** y en los
    cuatro caminos nuevos de 1b-1 (comanda, mesas, cocina, documento), porque
    basta que uno filtre sólo por `id` para que un restaurante vea las ventas
    del otro.
    """
    open_shift()
    order = create_order(device_client, channel="counter").json()
    order = add_items(
        device_client, order, [{"product_id": sales_products["inc8"].id, "qty": 1}]
    ).json()
    envio = device_client.post(
        f"{API}/orders/{order['id']}/send",
        json={"expected_version": order["version"]},
        headers=idem_headers(),
    )
    assert envio.status_code == 200, envio.text
    assert device_client.get(f"{API}/kitchen/rounds").json(), "la ronda se ve mientras es propia"

    order = get_order(device_client, order["id"])
    cobro = pay(
        device_client,
        order["id"],
        splits=[{"method": "cash", "amount": order["totals"]["total"]}],
        tip=NO_TIP,
    )
    assert cobro.status_code == 201, cobro.text
    order_id = order["id"]
    item_id = order["items"][0]["id"]
    document_id = cobro.json()["document"]["id"]

    # Guardia contra el falso verde: las tres cosas se ven ANTES de mudarlas.
    # Si la ronda o el documento ya no existieran, los `404` de abajo no
    # probarían el filtro por sede, sólo que el id no está.
    assert device_client.get(f"{API}/orders/{order_id}").status_code == 200
    assert device_client.get(f"{API}/documents/{document_id}").status_code == 200
    assert any(
        row["order_id"] == order_id for row in device_client.get(f"{API}/kitchen/rounds").json()
    ), "la ronda sigue en cocina después de cobrar (los ítems quedaron `sent`)"
    ultimo_propio = device_client.get(f"{API}/documents/last").json()
    assert ultimo_propio is not None and ultimo_propio["id"] == document_id

    for etiqueta, organization_id, store_id in (
        ("otra sede de la misma organización", store.organization_id, store_b.id),
        ("otra organización", org_b.id, store_b.id),
    ):
        _relocate_sale(db, order_id, organization_id=organization_id, store_id=store_id)

        lecturas = {
            "GET /orders/{id}": device_client.get(f"{API}/orders/{order_id}"),
            "GET /documents/{id}": device_client.get(f"{API}/documents/{document_id}"),
        }
        for nombre, resp in lecturas.items():
            assert resp.status_code == 404, f"{etiqueta} — {nombre}: {resp.status_code} {resp.text}"
            assert resp.json()["error"]["code"] == "NOT_FOUND", resp.text

        escrituras = {
            "POST /orders/{id}/items": device_client.post(
                f"{API}/orders/{order_id}/items",
                json={"expected_version": 1, "items": [{"product_id": sales_products["inc8"].id, "qty": 1}]},
                headers=idem_headers(),
            ),
            "POST /orders/{id}/items/{item_id}/void": device_client.post(
                f"{API}/orders/{order_id}/items/{item_id}/void",
                json={"expected_version": 1, "reason": "duplicate", "authorizer_pin": "9999"},
            ),
            "POST /documents/{id}/reprint": device_client.post(
                f"{API}/documents/{document_id}/reprint"
            ),
        }
        for nombre, resp in escrituras.items():
            assert resp.status_code == 404, f"{etiqueta} — {nombre}: {resp.status_code} {resp.text}"

        listados = {
            "GET /orders": device_client.get(f"{API}/orders"),
            "GET /kitchen/rounds": device_client.get(f"{API}/kitchen/rounds"),
        }
        for nombre, resp in listados.items():
            assert resp.status_code == 200, resp.text
            assert order_id not in [row.get("id", row.get("order_id")) for row in resp.json()], (
                f"{etiqueta} — {nombre} sigue listando una venta que ya no es de esta sede"
            )

        ultimo = device_client.get(f"{API}/documents/last")
        assert ultimo.status_code == 200, ultimo.text
        assert ultimo.json() is None, (
            f"{etiqueta} — `GET /documents/last` devolvió un documento de otra sede"
        )


def test_the_table_map_of_a_device_only_shows_its_own_store(
    device_client: Any, db: Any, open_shift: Any, audit_tables: Any, store: Any, store_b: Any
) -> None:
    """La misma regla en el mapa de mesas, que es una pantalla de sólo lectura
    y por eso se audita poco: una mesa de otra sede no puede aparecer, y
    abrir una comanda sobre ella tiene que ser `404`, no `409`."""
    from app.stores.models import Table, Zone

    open_shift()
    zona_ajena = Zone(store_id=store_b.id, name="Vecina", sort_order=1, active=True)
    db.add(zona_ajena)
    db.flush()
    mesa_ajena = Table(zone_id=zona_ajena.id, store_id=store_b.id, number="Z9", seats=2, active=True)
    db.add(mesa_ajena)
    db.commit()
    db.refresh(mesa_ajena)

    mapa = device_client.get(f"{API}/tables/status")
    assert mapa.status_code == 200, mapa.text
    numeros = {t["number"] for zona in mapa.json()["zones"] for t in zona["tables"]}
    assert "Z9" not in numeros, "el mapa de mesas mostró una mesa de otra sede"
    assert {"A1", "A2"} <= numeros, "y sí muestra las propias"

    intento = create_order(device_client, channel="dine_in", table_ids=[mesa_ajena.id])
    assert intento.status_code == 404, intento.text


# ---------------------------------------------------------------------------
# Autorizaciones: quién puede autorizar qué (§2.2, §11.6)
# ---------------------------------------------------------------------------


def test_a_supervisor_authorizes_voids_and_after_bill_changes_but_never_a_pickup(
    device_client: Any, open_shift: Any, sales_products: Any, employees: dict[str, Any]
) -> None:
    """§2.2 y `AGENTS.md`: el supervisor «autoriza anulaciones, cortesías y
    descuentos, **no retiros ni rescates**».

    1b-1 le agrega dos acciones (`void_order`, `after_bill_change`,
    `CONTRATO-INTERNO-1b-1.md §2.3`) y ahí está el riesgo: una lista de
    acciones que crece es una lista que se puede desbordar. El supervisor
    tiene que poder anular la comanda de una mesa que se fue sin pagar sin
    despertar al dueño, y **no** tiene que poder sacar plata del cajón —
    exactamente la separación que evita que un PIN de supervisor sea un PIN de
    administrador con otro nombre.
    """
    shift = open_shift()
    order = create_order(device_client, channel="counter").json()
    order = add_items(
        device_client, order, [{"product_id": sales_products["inc8"].id, "qty": 1}]
    ).json()
    envio = device_client.post(
        f"{API}/orders/{order['id']}/send",
        json={"expected_version": order["version"]},
        headers=idem_headers(),
    )
    assert envio.status_code == 200, envio.text
    order = envio.json()

    precuenta = device_client.post(
        f"{API}/orders/{order['id']}/bill/present",
        json={"expected_version": order["version"]},
        headers=idem_headers(),
    )
    assert precuenta.status_code == 200, precuenta.text
    order = get_order(device_client, order["id"])

    # (a) `after_bill_change`: agregar después de presentar la cuenta.
    con_supervisor = add_items(
        device_client,
        order,
        [{"product_id": sales_products["iva19"].id, "qty": 1}],
        authorizer_pin="5555",
    )
    assert con_supervisor.status_code == 200, con_supervisor.text
    order = con_supervisor.json()
    agregado = order["items"][-1]
    assert agregado["name"] == "Cerveza"

    # (b) `void_order`: anular una comanda con ítems enviados y cuenta presentada.
    anulada = device_client.post(
        f"{API}/orders/{order['id']}/void",
        json={"expected_version": order["version"], "reason": "walkout", "authorizer_pin": "5555"},
    )
    assert anulada.status_code == 200, anulada.text
    assert anulada.json()["status"] == "voided"

    # (c) …y el mismo PIN no saca un peso del cajón.
    retiro = device_client.post(
        f"{API}/shifts/{shift['id']}/pickups",
        json={"amount": 50_000, "authorizer_pin": "5555", "photo": "data:image/png;base64,AAAA"},
        headers=idem_headers(),
    )
    assert retiro.status_code == 400, retiro.text
    assert retiro.json()["error"]["code"] == "AUTHORIZATION_NOT_ALLOWED", retiro.text


def test_voiding_a_sent_item_without_a_pin_names_the_corrective_action(
    device_client: Any, open_shift: Any, sales_products: Any
) -> None:
    """§3.3 y el checklist del pedido 1b: anular un ítem `sent`/`ready`/
    `served` «requires an authorizer → `400 AUTHORIZATION_REQUIRED`».

    Y §11.18: el `message` tiene que **nombrar la acción correctiva**. Un
    «no autorizado» a secas manda al mesero a buscar al administrador cuando
    el supervisor que está a dos metros alcanza; peor, lo empuja a resolverlo
    por fuera del sistema.
    """
    open_shift()
    order = create_order(device_client, channel="counter").json()
    order = add_items(
        device_client, order, [{"product_id": sales_products["inc8"].id, "qty": 1}]
    ).json()
    item_id = order["items"][0]["id"]

    libre = device_client.post(
        f"{API}/orders/{order['id']}/items/{item_id}/void",
        json={"expected_version": order["version"], "reason": "customer_changed_mind"},
    )
    assert libre.status_code == 200, "un ítem `pending` se anula sin autorización (§3.3)"

    order = add_items(
        device_client, get_order(device_client, order["id"]), [{"product_id": sales_products["inc8"].id, "qty": 1}]
    ).json()
    enviado = device_client.post(
        f"{API}/orders/{order['id']}/send",
        json={"expected_version": order["version"]},
        headers=idem_headers(),
    )
    assert enviado.status_code == 200, enviado.text
    order = enviado.json()
    item_id = [i["id"] for i in order["items"] if i["status"] == "sent"][0]

    sin_pin = device_client.post(
        f"{API}/orders/{order['id']}/items/{item_id}/void",
        json={"expected_version": order["version"], "reason": "kitchen_error"},
    )
    assert sin_pin.status_code == 400, sin_pin.text
    error = sin_pin.json()["error"]
    assert error["code"] == "AUTHORIZATION_REQUIRED"
    assert "PIN" in error["message"].upper(), (
        f"el mensaje tiene que decir qué hacer, no sólo que no se puede: {error['message']!r}"
    )


def test_charging_requires_the_persons_own_pin_and_the_permission_to_charge(
    device_client: Any, open_shift: Any, sales_products: Any, identify: Any, employees: dict[str, Any]
) -> None:
    """§2.1: «cobrar re-pide el PIN propio»; §2.2: sólo cobra quien tiene
    `can_charge`.

    Las dos mitades cierran el mismo agujero: una tablet compartida queda
    identificada con la persona anterior durante minutos. Sin el PIN, cualquiera
    que pase cobra a nombre de quien se fue; sin `can_charge`, el mesero que no
    responde por el cajón cobra en efectivo sin que nadie responda por esa
    plata.
    """
    open_shift()
    order = create_order(device_client, channel="counter").json()
    order = add_items(
        device_client, order, [{"product_id": sales_products["inc8"].id, "qty": 1}]
    ).json()
    splits = [{"method": "cash", "amount": order["totals"]["total"]}]

    con_pin_ajeno = pay(device_client, order["id"], splits=splits, tip=NO_TIP, pin="2222")
    assert con_pin_ajeno.status_code == 400, con_pin_ajeno.text
    assert con_pin_ajeno.json()["error"]["code"] == "PIN_INVALID", (
        "el PIN que se pide al cobrar es el de la persona identificada, no el de cualquiera"
    )

    identify(device_client, employees["operator"])  # can_charge=False
    sin_permiso = pay(device_client, order["id"], splits=splits, tip=NO_TIP, pin="2222")
    assert sin_permiso.status_code == 400, sin_permiso.text
    error = sin_permiso.json()["error"]
    assert error["code"] == "CANNOT_CHARGE", sin_permiso.text
    assert error["message"], "con la acción correctiva: a quién pedirle que cobre"

    identify(device_client, employees["cashier"])
    con_permiso = pay(device_client, order["id"], splits=splits, tip=NO_TIP, pin="1111")
    assert con_permiso.status_code == 201, con_permiso.text


# ---------------------------------------------------------------------------
# Versión optimista: la comanda vive en el servidor (§3.3, §11.9)
# ---------------------------------------------------------------------------


def test_every_mutation_with_a_stale_version_returns_409_with_the_current_order(
    device_client: Any, open_shift: Any, sales_products: Any, audit_tables: Any
) -> None:
    """§3.3: «la comanda tiene versión optimista; dos tablets editando la
    misma comanda reciben `409` si su versión es vieja». Contrato §2.4: el
    `409 STALE_VERSION` viaja **con la comanda actual** en `extra.order`.

    Los dos pedazos importan por separado. El `409` evita que la segunda
    tablet pise lo que hizo la primera; la comanda adjunta evita el «recargá y
    volvé a intentar» que en hora pico termina en dos comandas paralelas de la
    misma mesa. Se prueba en **todas** las mutaciones con `expected_version`,
    porque alcanza con que una lo olvide para que esa sea la que se use.
    """
    open_shift()
    order = create_order(device_client, channel="counter").json()
    order = add_items(
        device_client, order, [{"product_id": sales_products["inc8"].id, "qty": 2}]
    ).json()
    vieja = order["version"] - 1
    item_id = order["items"][0]["id"]

    mutaciones = {
        "items": (
            "post",
            f"{API}/orders/{order['id']}/items",
            {"expected_version": vieja, "items": [{"product_id": sales_products["inc8"].id, "qty": 1}]},
        ),
        "items/{id} (patch)": (
            "patch",
            f"{API}/orders/{order['id']}/items/{item_id}",
            {"expected_version": vieja, "qty": 3},
        ),
        "send": ("post", f"{API}/orders/{order['id']}/send", {"expected_version": vieja}),
        "items/{id}/void": (
            "post",
            f"{API}/orders/{order['id']}/items/{item_id}/void",
            {"expected_version": vieja, "reason": "duplicate"},
        ),
        "items/{id}/courtesy": (
            "post",
            f"{API}/orders/{order['id']}/items/{item_id}/courtesy",
            {"expected_version": vieja, "reason": "complaint", "authorizer_pin": "5555"},
        ),
        "discounts": (
            "post",
            f"{API}/orders/{order['id']}/discounts",
            {"expected_version": vieja, "scope": "order", "kind": "percent", "value": 5, "reason": "promo"},
        ),
        "move": (
            "post",
            f"{API}/orders/{order['id']}/move",
            {"expected_version": vieja, "table_ids": [audit_tables[0].id]},
        ),
        "merge": (
            "post",
            f"{API}/orders/{order['id']}/merge",
            {"expected_version": vieja, "from_order_id": order["id"]},
        ),
        "void": (
            "post",
            f"{API}/orders/{order['id']}/void",
            {"expected_version": vieja, "reason": "duplicate"},
        ),
        "bill/present": (
            "post",
            f"{API}/orders/{order['id']}/bill/present",
            {"expected_version": vieja},
        ),
        "bill/split": (
            "post",
            f"{API}/orders/{order['id']}/bill/split",
            {"expected_version": vieja, "mode": "equal", "parts": 2},
        ),
        "payments": (
            "post",
            f"{API}/orders/{order['id']}/payments",
            {
                "expected_version": vieja,
                "pin": "1111",
                "tip": NO_TIP,
                "splits": [{"method": "cash", "amount": order["totals"]["total"]}],
            },
        ),
    }

    for nombre, (verbo, url, body) in mutaciones.items():
        resp = getattr(device_client, verbo)(url, json=body, headers=idem_headers())
        assert resp.status_code == 409, f"{nombre}: {resp.status_code} {resp.text}"
        error = resp.json()["error"]
        assert error["code"] == "STALE_VERSION", f"{nombre}: {error}"
        assert error["message"], f"{nombre}: el 409 tiene que decir qué pasó"
        adjunta = error.get("order")
        assert adjunta is not None, (
            f"{nombre}: el 409 no trae la comanda actual y obliga a la tablet a adivinar"
        )
        assert adjunta["id"] == order["id"]
        assert adjunta["version"] == order["version"], (
            f"{nombre}: la comanda adjunta tiene que ser la versión vigente"
        )
        assert adjunta["items"], f"{nombre}: la comanda adjunta llega vacía"


# ---------------------------------------------------------------------------
# Forma única del error en los códigos nuevos (§11.18, contrato §4)
# ---------------------------------------------------------------------------


def test_every_new_business_error_of_the_sale_has_exactly_one_shape(
    device_client: Any, open_shift: Any, sales_products: Any, set_feature: Any
) -> None:
    """§11.18 y §12: «una sola forma `{error:{code,message}}`», `message` con
    la acción correctiva, reglas de negocio en `400` y **nunca un `500`**.

    Muestra de los códigos nuevos del contrato §4. Vale la pena mirarlos
    juntos: el frontend enciende un diálogo distinto según el `code`
    (`AUTHORIZATION_REQUIRED` abre el PIN de supervisor, `STALE_VERSION`
    recarga la comanda), así que un error que llegue con otra forma —o con un
    `detail` de FastAPI en vez de `error`— no rompe un test, rompe una
    pantalla en hora pico.
    """
    turno = open_shift()
    order = create_order(device_client, channel="counter").json()

    casos: list[tuple[str, Any]] = [
        (
            "ORDER_EMPTY",
            device_client.post(
                f"{API}/orders/{order['id']}/bill/present",
                json={"expected_version": order["version"]},
                headers=idem_headers(),
            ),
        ),
        (
            "NOTHING_TO_SEND",
            device_client.post(
                f"{API}/orders/{order['id']}/send",
                json={"expected_version": order["version"]},
                headers=idem_headers(),
            ),
        ),
        (
            "TABLE_REQUIRED",
            create_order(device_client, channel="dine_in"),
        ),
        (
            "STAFF_MEAL_CONSUMER_REQUIRED",
            create_order(device_client, channel="staff_meal"),
        ),
    ]

    order = add_items(
        device_client, get_order(device_client, order["id"]), [{"product_id": sales_products["inc8"].id, "qty": 1}]
    ).json()
    total = order["totals"]["total"]
    casos += [
        (
            "SPLITS_DO_NOT_MATCH",
            pay(device_client, order["id"], splits=[{"method": "cash", "amount": total - 1}], tip=NO_TIP),
        ),
        (
            "PAYMENT_METHOD_INVALID",
            pay(device_client, order["id"], splits=[{"method": "bitcoin", "amount": total}], tip=NO_TIP),
        ),
        (
            "PAYMENT_REFERENCE_REQUIRED",
            pay(device_client, order["id"], splits=[{"method": "transfer", "amount": total}], tip=NO_TIP),
        ),
        (
            "CHANGE_ONLY_ON_CASH",
            pay(
                device_client,
                order["id"],
                splits=[{"method": "card", "amount": total, "tendered": total + 1_000}],
                tip=NO_TIP,
            ),
        ),
        (
            "TENDERED_TOO_LOW",
            pay(
                device_client,
                order["id"],
                splits=[{"method": "cash", "amount": total, "tendered": total - 1_000}],
                tip=NO_TIP,
            ),
        ),
        (
            "TIP_NOT_ASKED",
            pay(device_client, order["id"], splits=[{"method": "cash", "amount": total}]),
        ),
        (
            "DISCOUNT_EXCEEDS_LINE",
            device_client.post(
                f"{API}/orders/{order['id']}/discounts",
                json={
                    "expected_version": order["version"],
                    "scope": "item",
                    "item_id": order["items"][0]["id"],
                    "kind": "amount",
                    "value": total * 10,
                    "reason": "promo",
                },
            ),
        ),
    ]

    set_feature("pos.pre_bill", False)
    casos.append(
        (
            "FEATURE_DISABLED",
            device_client.post(
                f"{API}/orders/{order['id']}/bill/present",
                json={"expected_version": order["version"]},
                headers=idem_headers(),
            ),
        )
    )

    for esperado, resp in casos:
        assert resp.status_code == 400, f"{esperado}: salió {resp.status_code} {resp.text}"
        cuerpo = resp.json()
        assert set(cuerpo.keys()) == {"error"}, f"{esperado}: forma distinta — {cuerpo}"
        error = cuerpo["error"]
        assert "code" in error and "message" in error, f"{esperado}: faltan code/message — {error}"
        assert error["code"] == esperado, f"esperaba {esperado}, llegó {error['code']}"
        assert isinstance(error["message"], str) and len(error["message"]) > 10, (
            f"{esperado}: el mensaje tiene que hablarle a una persona — {error['message']!r}"
        )

    # Y el gate del cierre de turno, que es del mismo contrato (§2.4 «Caja»).
    cierre = device_client.post(
        f"{API}/shifts/{turno['id']}/close/count",
        json={"counted_cash": denoms(200_000), "tips_cash_out": 0, "photo": "data:image/png;base64,AAAA"},
        headers=idem_headers(),
    )
    assert cierre.status_code in (200, 201), cierre.text
    confirmado = device_client.post(
        f"{API}/shifts/{turno['id']}/close/{cierre.json()['count_id']}/confirm",
        json={"difference_seen": 0, "closes_day": True},
    )
    assert confirmado.status_code == 400, confirmado.text
    error = confirmado.json()["error"]
    assert error["code"] == "OPEN_ORDERS_EXIST", confirmado.text
    assert error.get("open_orders") == 1, f"y dice cuántas quedaron abiertas: {error}"


def test_the_takeout_customer_data_travels_only_where_it_is_needed(
    device_client: Any, admin_client: Any, open_shift: Any, sales_products: Any, store: Any
) -> None:
    """§8.4 (minimización) sobre los datos personales **nuevos** de 1b-1: el
    nombre y el teléfono de quien pide para llevar.

    Tienen una finalidad concreta y acotada —llamar cuando el pedido está
    listo— y por eso viven en la comanda, que el salón necesita mirar. No
    tienen ninguna finalidad en el comprobante fiscal (el adquirente es
    «consumidor final», §8.3) ni en el listado de comandas del administrador,
    que se exporta a CSV. Un teléfono que aparece en un CSV exportable es un
    teléfono que termina en una lista de difusión sin autorización (§8.4).
    """
    open_shift()
    telefono = "3001234567"
    creada = create_order(
        device_client,
        channel="takeout",
        takeout={"customer_name": "Ana Pérez", "phone": telefono},
    )
    assert creada.status_code == 201, creada.text
    order = creada.json()
    assert order["takeout"]["phone"] == telefono, (
        "el salón sí lo ve: es para lo único que se pidió"
    )

    order = add_items(
        device_client, order, [{"product_id": sales_products["inc8"].id, "qty": 1}]
    ).json()
    cobro = pay(
        device_client,
        order["id"],
        splits=[{"method": "cash", "amount": order["totals"]["total"]}],
        tip=NO_TIP,
    )
    assert cobro.status_code == 201, cobro.text

    documento = device_client.get(f"{API}/documents/{cobro.json()['document']['id']}")
    assert documento.status_code == 200, documento.text
    assert telefono not in documento.text, "el teléfono no tiene nada que hacer en el comprobante"
    assert documento.json()["customer"]["name"] == "Consumidor final", (
        "el adquirente por defecto es «consumidor final» (§8.3): 1b-1 no captura clientes"
    )

    listado = admin_client.get(f"{API}/admin/orders", params={"store_id": store.id})
    assert listado.status_code == 200, listado.text
    assert telefono not in listado.text, (
        "ni en el listado del administrador, que acepta `format=csv`"
    )
    claves = {k.lower() for k in deep_keys(listado.json())}
    assert "phone" not in claves and "takeout_phone" not in claves


# ---------------------------------------------------------------------------
# Pedido 1b-2: el contrato nuevo (rangos, estados DIAN, notas, clientes,
# devoluciones, reportes) bajo las mismas reglas duras
# ---------------------------------------------------------------------------


def test_the_openapi_of_the_new_1b2_routes_declares_no_cost_fields(client: Any) -> None:
    """`AGENTS.md` y §11.10: «El operador no ve costos ni márgenes; el backend
    no se los manda» — extendido a **todas** las rutas nuevas de 1b-2.

    El test de 1b-1 cubría `/orders`, `/kitchen`, `/documents` y
    `/admin/orders`. 1b-2 agrega ocho rutas de admin, una de dispositivo
    (`/device/payment-methods`) y cuatro reportes que leen `OrderItem` — el
    modelo que en fase 2 va a llenar `unit_cost` y `recipe_version`. Escribir
    el invariante ahora, cuando todavía no hay nada que filtrar, es lo que
    hace que el día que se llenen no se escapen.
    """
    spec = client.get("/openapi.json").json()
    names = _property_names_reachable_from(
        spec,
        (
            f"{API}/admin/fiscal",
            f"{API}/admin/notes",
            f"{API}/admin/documents",
            f"{API}/admin/customers",
            f"{API}/admin/pending-refunds",
            f"{API}/admin/today",
            f"{API}/admin/sales",
            f"{API}/admin/accountant-report",
            f"{API}/admin/unavailable-log",
            f"{API}/admin/tips",
            f"{API}/device/payment-methods",
            f"{API}/shifts",
        ),
    )
    assert names, "no se encontró ningún esquema bajo las rutas nuevas de 1b-2"

    leaked = {n for n in names if any(secret in n.lower() for secret in MONEY_SECRETS)}
    assert not leaked, f"el OpenAPI de 1b-2 declara campos de costo: {sorted(leaked)}"
    assert "recipe_version" not in {n.lower() for n in names}


def test_a_device_session_never_reaches_the_new_admin_routes(
    device_client: Any, identify: Any, employees: dict[str, Any], store: Any
) -> None:
    """§2.2: el operador «no autoriza retiros ni rescates» y tampoco
    administra el documento fiscal. Un dispositivo no puede cargar un rango
    de numeración, reintentar una transmisión, emitir una nota, saldar una
    devolución ni leer los reportes del dueño.

    Es una barrera de rol, no de pantalla: la tablet del salón la usa
    cualquiera del turno y su sesión dura 180 días.
    """
    identify(device_client, employees["cashier"])
    rango = {"from": "2020-01-01", "to": "2099-12-31"}
    lecturas = [
        (f"{API}/admin/fiscal/ranges", {"store_id": store.id}),
        (f"{API}/admin/fiscal/documents", {"store_id": store.id}),
        (f"{API}/admin/fiscal/export", {"store_id": store.id, **rango}),
        (f"{API}/admin/notes", {"store_id": store.id}),
        (f"{API}/admin/pending-refunds", {"store_id": store.id}),
        (f"{API}/admin/today", {"store_id": store.id}),
        (f"{API}/admin/sales", {"store_id": store.id, **rango, "group_by": "business_date"}),
        (f"{API}/admin/accountant-report", {"store_id": store.id, "year": 2026, "month": 1}),
        (f"{API}/admin/unavailable-log", {"store_id": store.id, **rango}),
    ]
    for ruta, params in lecturas:
        resp = device_client.get(ruta, params=params)
        assert resp.status_code in (401, 403), (
            f"un dispositivo leyó `{ruta}` con {resp.status_code}: {resp.text[:200]}"
        )
        _assert_error_shape(resp, status=resp.status_code)

    escrituras = [
        (
            f"{API}/admin/fiscal/ranges",
            {
                "store_id": store.id,
                "document_type": "pos_equivalent",
                "prefix": "X",
                "from_number": 1,
                "to_number": 9,
                "resolution_number": "1",
                "resolution_date": "2026-01-01",
                "valid_from": "2026-01-01",
                "valid_until": "2027-01-01",
            },
        ),
        (f"{API}/admin/fiscal/documents/1/retry", None),
        (f"{API}/admin/documents/1/notes", {"kind": "adjustment", "reason": "x", "lines": []}),
        (f"{API}/admin/pending-refunds/1/settle", {"from": "owner"}),
        (f"{API}/admin/tips/payouts", {"shift_ids": [1], "distribution": [], "paid_at": "2026-01-01", "method": "cash"}),
    ]
    for ruta, cuerpo in escrituras:
        resp = device_client.post(ruta, json=cuerpo, headers=idem_headers())
        assert resp.status_code in (401, 403), (
            f"un dispositivo escribió en `{ruta}` con {resp.status_code}: {resp.text[:200]}"
        )


def test_every_new_business_error_of_1b2_has_exactly_one_shape(
    device_client: Any, admin_client: Any, db: Any, store: Any, open_shift: Any, sales_products: Any
) -> None:
    """§11.18 y §12: «Errores con una sola forma `{error: {code, message}}`:
    reglas de negocio en `400` con código y texto que **nombra la acción
    correctiva**; nunca `500` por una regla de negocio».

    Se recorren los códigos nuevos del pedido de punta a punta por HTTP. El
    `500` es el que importa: un `500` no tiene código estable, el frontend no
    puede ramificar sobre él y el operador ve una pantalla rota — que en hora
    pico significa cobrar por fuera del sistema.
    """
    from app.fiscal.models import FiscalRange

    open_shift()

    # 1) Rango inválido (el «hasta» antes que el «desde»).
    invalido = admin_client.post(
        f"{API}/admin/fiscal/ranges",
        json={
            "store_id": store.id,
            "document_type": "pos_equivalent",
            "prefix": "BAD",
            "from_number": 100,
            "to_number": 10,
            "resolution_number": "1",
            "resolution_date": "2026-01-01",
            "valid_from": "2026-01-01",
            "valid_until": "2027-01-01",
        },
    )
    error = _assert_error_shape(invalido, status=400)
    assert error["code"] == "FISCAL_RANGE_INVALID", invalido.text

    # 2) Nota con tipo cruzado y 3) segunda nota sobre el mismo documento.
    order = create_order(device_client, channel="counter").json()
    order = add_items(device_client, order, [{"product_id": sales_products["inc8"].id, "qty": 1}]).json()
    cobro = pay(
        device_client,
        order["id"],
        splits=[{"method": "cash", "amount": order["totals"]["total"]}],
        tip=NO_TIP,
    )
    assert cobro.status_code == 201, cobro.text
    doc_id = cobro.json()["document"]["id"]
    lineas = [
        {"item_id": line["item_id"], "used": True}
        for line in admin_client.get(f"{API}/documents/{doc_id}").json()["lines"]
    ]

    cruzada = admin_client.post(
        f"{API}/admin/documents/{doc_id}/notes",
        json={"kind": "credit", "reason": "x", "lines": lineas},
        headers=idem_headers(),
    )
    assert _assert_error_shape(cruzada, status=400)["code"] == "NOTE_KIND_MISMATCH"

    # Ninguna línea marcada `used`: la nota no corrige nada y es `400`, no un
    # documento vacío con consecutivo consumido.
    vacia = admin_client.post(
        f"{API}/admin/documents/{doc_id}/notes",
        json={"kind": "adjustment", "reason": "x", "lines": [{**lineas[0], "used": False}]},
        headers=idem_headers(),
    )
    assert _assert_error_shape(vacia, status=400)["code"] == "NOTE_EMPTY"

    # Y `lines: []` cae en la validación de esquema, normalizada a la MISMA
    # forma de error (§12: «validación de esquema normalizada a la misma forma»).
    sin_lineas = admin_client.post(
        f"{API}/admin/documents/{doc_id}/notes",
        json={"kind": "adjustment", "reason": "x", "lines": []},
        headers=idem_headers(),
    )
    _assert_error_shape(sin_lineas, status=400)

    buena = admin_client.post(
        f"{API}/admin/documents/{doc_id}/notes",
        json={"kind": "adjustment", "reason": "Auditoría", "lines": lineas},
        headers=idem_headers(),
    )
    assert buena.status_code == 201, buena.text
    repetida = admin_client.post(
        f"{API}/admin/documents/{doc_id}/notes",
        json={"kind": "adjustment", "reason": "Auditoría", "lines": lineas},
        headers=idem_headers(),
    )
    assert _assert_error_shape(repetida, status=400)["code"] == "DOCUMENT_ALREADY_REVERSED"

    # 4) Reintentar la transmisión de un documento ya reversado.
    reintento = admin_client.post(
        f"{API}/admin/fiscal/documents/{doc_id}/retry", headers=idem_headers()
    )
    assert _assert_error_shape(reintento, status=400)["code"] == "DOCUMENT_ALREADY_REVERSED"

    # 5) Saldar una devolución con `from: shift` sin turno.
    sin_turno = admin_client.post(
        f"{API}/admin/pending-refunds/1/settle", json={"from": "shift"}, headers=idem_headers()
    )
    assert sin_turno.status_code in (400, 404), sin_turno.text
    _assert_error_shape(sin_turno, status=sin_turno.status_code)

    # 6) Cobrar sin rango VIGENTE: `400`, nunca `500`. (Se vencen los rangos
    # en vez de borrarlos: los documentos ya emitidos apuntan a ellos con FK
    # real, y borrar evidencia es justamente lo que §8.3 prohíbe.)
    from datetime import date as _date

    for fila in db.execute(select(FiscalRange)).scalars():
        fila.valid_until = _date(2020, 12, 31)
    db.commit()
    otra = create_order(device_client, channel="counter").json()
    otra = add_items(device_client, otra, [{"product_id": sales_products["inc8"].id, "qty": 1}]).json()
    sin_rango = pay(
        device_client,
        otra["id"],
        splits=[{"method": "cash", "amount": otra["totals"]["total"]}],
        tip=NO_TIP,
    )
    error = _assert_error_shape(sin_rango, status=400)
    assert error["code"] == "NO_FISCAL_RANGE"
    assert "admin" in error["message"].lower(), (
        f"el mensaje tiene que decir dónde se corrige: {error['message']!r}"
    )


# ---------------------------------------------------------------------------
# Pedido 2a: el costo entra al sistema y el operador sigue sin verlo
#
# Hasta 1b `order_items.unit_cost` era siempre `NULL` y el invariante de "el
# operador no ve costos" se cumplía solo. Desde 2a hay costo real en el ítem,
# costo por insumo, costo por lote y margen en los reportes: es el momento
# exacto en que este control deja de ser gratis y empieza a valer algo.
# ---------------------------------------------------------------------------


def test_the_openapi_of_the_new_2a_routes_declares_no_cost_fields(client: Any) -> None:
    """`AGENTS.md` y §11.10, extendido a la superficie nueva de 2a.

    Las rutas de **dispositivo** que esta fase agrega (`GET /preparations`,
    `POST /preparations/{id}/produce`, `POST /waste`, `GET /device/
    ingredients`) las usa el operador del salón y de cocina: ninguna puede
    declarar —ni siquiera declarar, aunque hoy no lo llene— un campo de costo
    o de margen. Un campo declarado en el esquema es un campo que alguien va a
    llenar.

    `/admin/**` queda fuera a propósito: el administrador **sí** ve el costo,
    es el sentido entero de la fase.
    """
    spec = client.get("/openapi.json").json()
    rutas_de_dispositivo = (
        f"{API}/preparations",
        f"{API}/waste",
        f"{API}/device/ingredients",
    )
    publicadas = {ruta for ruta in spec["paths"] if ruta.startswith(rutas_de_dispositivo)}
    assert publicadas >= {
        f"{API}/preparations",
        f"{API}/preparations/{{preparation_id}}/produce",
        f"{API}/waste",
        f"{API}/device/ingredients",
    }, f"faltan rutas de dispositivo de 2a en el OpenAPI: {sorted(publicadas)}"

    names = _property_names_reachable_from(spec, rutas_de_dispositivo)
    assert names, "no se encontró ningún esquema bajo las rutas de dispositivo de 2a"

    leaked = {n for n in names if any(secret in n.lower() for secret in MONEY_SECRETS)}
    assert not leaked, f"el OpenAPI de dispositivo de 2a declara campos de costo: {sorted(leaked)}"
    assert "recipe_version" not in {n.lower() for n in names}


def test_no_device_response_of_2a_carries_cost_margin_or_recipe_version(
    db: Any,
    store: Any,
    admin_client: Any,
    device_client: Any,
    identify: Any,
    employees: dict[str, Any],
    open_shift: Any,
    sales_products: Any,
) -> None:
    """El mismo control sobre la **respuesta real**, con datos cargados: un
    esquema limpio no sirve si el endpoint devuelve un `dict` suelto.

    Se recorren las cuatro superficies de dispositivo de 2a más la comanda
    después de enviar —que es donde `unit_cost` ya NO es `NULL`— buscando
    `cost`, `margin`, `unit_cost`, `food_cost` y `recipe_version` a cualquier
    profundidad.
    """
    from tests.audit.conftest import make_ingredient, make_preparation, put_recipe, send

    insumo = make_ingredient(admin_client, store, name="Insumo secreto", official_cost="99.5", min_stock="1000")
    prep = make_preparation(
        admin_client,
        store,
        name="Prep secreta",
        mode="batch",
        standard_yield_qty="1000",
        standard_yield_unit="g",
        lines=[{"ingredient_id": insumo["id"], "qty": "400", "unit": "g"}],
    )
    product = sales_products["inc8"]
    put_recipe(admin_client, product.id, [{"ingredient_id": insumo["id"], "qty": "100", "unit": "g"}])

    open_shift()
    identify(device_client, employees["operator"])

    orden = create_order(device_client, channel="counter").json()
    orden = add_items(device_client, orden, [{"product_id": product.id, "qty": 2}]).json()
    assert send(device_client, orden).status_code == 200

    superficies: list[tuple[str, Any]] = [
        ("GET /preparations", device_client.get(f"{API}/preparations")),
        (
            "POST /preparations/{id}/produce",
            device_client.post(
                f"{API}/preparations/{prep['id']}/produce",
                json={"qty_expected": "1000", "qty_real": "1000", "employee_pin": "2222"},
                headers=idem_headers(),
            ),
        ),
        (
            "POST /waste",
            device_client.post(
                f"{API}/waste",
                json={
                    "ingredient_id": insumo["id"],
                    "qty": "10",
                    "type": "breakage",
                    "employee_pin": "2222",
                },
                headers=idem_headers(),
            ),
        ),
        ("GET /device/ingredients", device_client.get(f"{API}/device/ingredients")),
        ("GET /orders/{id} tras enviar", device_client.get(f"{API}/orders/{orden['id']}")),
        ("GET /kitchen/rounds", device_client.get(f"{API}/kitchen/rounds")),
    ]

    for nombre, resp in superficies:
        assert resp.status_code in (200, 201), f"{nombre}: {resp.status_code} {resp.text[:200]}"
        claves = {k.lower() for k in deep_keys(resp.json())}
        filtrado = {k for k in claves if any(secret in k for secret in MONEY_SECRETS)}
        assert not filtrado, f"{nombre} filtró {sorted(filtrado)}"
        assert "recipe_version" not in claves, f"{nombre} filtró la versión de receta"
        assert "99.5" not in resp.text, f"{nombre} filtró el costo del insumo en algún texto"


def test_a_device_session_never_reaches_the_admin_routes_of_cost_and_inventory(
    device_client: Any, identify: Any, employees: dict[str, Any], store: Any
) -> None:
    """§2.2: el operador no administra la carta ni el inventario. La tablet del
    salón la usa cualquiera del turno y su sesión dura 180 días: la barrera es
    de rol, no de pantalla.

    Las rutas de admin de 2a son las que muestran costo, margen y food cost —
    exactamente lo que §11.10 prohíbe que llegue al dispositivo.
    """
    identify(device_client, employees["cashier"])
    lecturas = [
        (f"{API}/admin/ingredients", {"store_id": store.id}),
        (f"{API}/admin/inventory/stock", {"store_id": store.id}),
        (f"{API}/admin/preparations", {"store_id": store.id}),
        (f"{API}/admin/waste", {"store_id": store.id}),
        (f"{API}/admin/recipes/coverage", {"store_id": store.id}),
        (f"{API}/admin/recipes/suspicious-units", {"store_id": store.id}),
        (f"{API}/admin/products/1/recipe", None),
    ]
    for ruta, params in lecturas:
        resp = device_client.get(ruta, params=params)
        assert resp.status_code in (401, 403), (
            f"un dispositivo leyó `{ruta}` con {resp.status_code}: {resp.text[:200]}"
        )
        _assert_error_shape(resp, status=resp.status_code)

    escrituras = [
        (
            f"{API}/admin/ingredients",
            {"store_id": store.id},
            {
                "name": "X",
                "base_unit": "g",
                "purchase_unit": "kg",
                "purchase_factor": 1000,
                "min_stock": "1",
            },
        ),
        (
            f"{API}/admin/inventory/adjustments",
            {"store_id": store.id},
            {"ingredient_id": 1, "qty_delta": "10", "reason": "x", "authorizer_pin": "9999"},
        ),
        (
            f"{API}/admin/preparations",
            {"store_id": store.id},
            {"name": "X", "mode": "exploded", "standard_yield_qty": "1", "standard_yield_unit": "g", "lines": []},
        ),
    ]
    for ruta, params, cuerpo in escrituras:
        resp = device_client.post(ruta, params=params, json=cuerpo, headers=idem_headers())
        assert resp.status_code in (401, 403), (
            f"un dispositivo escribió en `{ruta}` con {resp.status_code}: {resp.text[:200]}"
        )
