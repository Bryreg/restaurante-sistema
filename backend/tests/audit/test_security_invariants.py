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

from tests.audit.conftest import deep_keys, denoms, idem_headers

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
