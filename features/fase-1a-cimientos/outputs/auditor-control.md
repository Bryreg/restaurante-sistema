# auditor-control — invariantes ejecutables, hallazgos y datos sensibles (pedido 1a)

Rol: auditor de control interno del pedido 1a. Combina el **Contador**
(`.claude/skills/agentes/agente-contador.md`: trazabilidad, matemática de caja, nada
financiero se borra) y el **Legal** (`agente-legal.md`: PII, menor privilegio, sesión
segura), adaptados a una fase sin ventas ni impuestos: acá hay **caja** e **identidad**.

No construí funcionalidad ni arreglé código ajeno. Convertí las reglas duras en tests
ejecutables dentro de mi territorio y en hallazgos con archivo y línea.

**Territorio escrito**: `backend/tests/audit/**` y `frontend/src/audit/**` (más este
entregable). Nada más fue tocado.

> **Iteración 2 — resumen de una línea.** Los cuatro bloqueantes (B-1 a B-4) están
> **corregidos y verificados por test**, incluido B-4, que en la ronda 1 sólo estaba
> verificado por lectura porque el `500` de B-2 tapaba el invariante. Se sumaron
> cinco invariantes nuevos (dos de caja/sesión, tres de migraciones) y el test del
> cierre en un paso quedó endurecido a código exacto. **Cero bloqueantes abiertos.**
> Las nueve advertencias y la observación de control siguen abiertas, tal cual, para
> decisión del dueño de la spec.

## Estado de la verificación

| Qué | Comando | Resultado |
|---|---|---|
| Invariantes backend | `cd backend && TMPDIR=/tmp/pt-auditor-control python -m pytest tests/audit -q` | **58 pasan, 0 fallan** |
| Typecheck de mis tests | `cd backend && python -m mypy tests/audit` | limpio (5 archivos) |
| Invariantes frontend | `cd frontend && npx vitest run src/audit` | **8 pasan** |
| Typecheck frontend | `cd frontend && npx tsc --noEmit -p tsconfig.app.json` | limpio |

No corrí la suite completa del backend ni del frontend, ni `npm run build`
(`.claude/AGENTS.md § Verificación`). `alembic upgrade head` **sí** corre ahora, pero
dentro de mi propio test y contra un archivo SQLite nuevo bajo `TMPDIR`, nunca contra
`dev.db` ni contra nada compartido.

Archivos:

- `backend/tests/audit/conftest.py` — helpers propios (`denoms`, `deep_keys`,
  `deep_contains_text`, `open_shift`, `other_org`, `catalog_seeded`, `expected_of`,
  `race_app`). No redefine ninguna fixture compartida (CONTRATO-INTERNO §3).
- `backend/tests/audit/test_cash_invariants.py` — 32 invariantes de plata.
- `backend/tests/audit/test_security_invariants.py` — 23 invariantes de identidad,
  aislamiento y privacidad.
- `backend/tests/audit/test_migration_invariants.py` — 3 invariantes de la cadena de
  Alembic contra los modelos (**nuevo en la iteración 2**).
- `frontend/src/audit/security.test.ts` — 8 invariantes por inspección de código
  fuente (`environment: node`).

---

## 1. Tabla de invariantes escritas

Estado: **pasa** · **FALLA (regla violada)** · *pendiente (código ausente)*.
En esta ronda **no queda ninguno en falla ni pendiente**.

### 1.1 Plata — `backend/tests/audit/test_cash_invariants.py`

| Test | Regla que encarna | Estado |
|---|---|---|
| `test_declared_reserve_never_enters_expected_nor_the_equation` | §3.2 / §11.15: la reserva se declara aparte y **no entra** al esperado ni a la ecuación de `review` (Palmetto 15-ago: reserva contada dentro de la base = sobrante de $500.000 mandado a consignar) | pasa |
| `test_zero_net_swap_does_not_change_expected` | §3.2 / §11.15: el cambio de denominaciones es canje, no egreso; no toca el esperado | pasa |
| `test_non_zero_swap_is_rejected_with_swap_not_zero` | Contrato 1a: neto ≠ 0 → `400 SWAP_NOT_ZERO` | pasa |
| `test_expected_follows_the_single_equation_and_pickup_freezes_its_snapshot` | §3.2: base 200.000 + ingreso 30.000 − egreso 10.000 − retiro 50.000 → esperado **170.000 exacto**; el retiro guarda `expected_at_pickup = 220.000` | pasa |
| `test_reversing_a_pickup_restores_expected_and_keeps_the_pickup_row` | §3.2 / §11.3: reversar devuelve el esperado a 220.000 y **el retiro sigue existiendo** con marca de reversa; nada se borra | pasa |
| `test_close_count_never_reveals_expected_difference_or_equation` | §3.2 paso 1: el conteo se teclea **a ciegas**; inspección recursiva del JSON (`deep_keys`) — ni `expected`, ni `difference`, ni `equation` | pasa |
| `test_review_reveals_the_equation_and_it_closes_exactly` | §3.2 paso 2: `base + cash_sales + incomes − expenses − pickups == expected` y `counted − expected == difference` | pasa |
| `test_confirm_with_stale_difference_seen_returns_difference_changed_with_the_new_review` | §3.2 / auditoría M15 de la referencia: movimiento entre `review` y `confirm` → `400 DIFFERENCE_CHANGED` con la review nueva en el cuerpo | pasa |
| `test_small_difference_closes_with_unknown_cause` | §3.2 tolerancias: 15.000 cierra con `unknown` | pasa |
| `test_medium_difference_requires_an_identified_cause` | §3.2: 50.000 con `unknown` → `400 IDENTIFIED_CAUSE_REQUIRED`; con `change_error` cierra | pasa |
| `test_critical_difference_still_closes_and_raises_a_notification` | §3.2: 150.000 **cierra igual** (nunca bloquea) y deja `cash_difference_critical` | pasa |
| `test_the_one_step_close_is_refused_while_blind_close_is_on` **(endurecido)** | §1.2 + §11.19: con `cash.blind_close` encendida el cierre en un paso es una puerta de al lado que saltea el conteo a ciegas y el control de `DIFFERENCE_CHANGED`. Ahora exige **código exacto** `BLIND_CLOSE_REQUIRED`, `error.feature == "cash.blind_close"`, `message` no vacío, y que el turno siga `open` con `counted_cash`/`difference` sin escribir | **pasa** (era B-1) |
| `test_with_blind_close_off_the_one_step_close_is_the_way_and_the_three_steps_are_refused` | §1.2: apagada, el cierre en un paso es el camino y los tres pasos dan `400 FEATURE_DISABLED` con `feature` | pasa |
| `test_photo_required_on_close_is_enforced_by_the_backend` | §3.2: foto exigida **en el backend**; con `photo_required_on_close=false` cierra sin foto | pasa |
| `test_to_deposit_is_counted_minus_fixed_base_minus_cash_tips` | §6.1: `to_deposit = counted − opening_cash_fixed − tips_cash_out` | pasa |
| `test_one_open_shift_per_store_is_defended_by_a_partial_unique_index` | §11.9: la última defensa es la base — índice único **parcial** `uq_shifts_one_open_per_store` con `where status='open'` | pasa |
| `test_two_concurrent_opens_leave_exactly_one_winner` | §3.2 / §11.9 / checklist 1a: dos `POST /shifts/open` en hilos → exactamente un ganador y un rechazo limpio (`400 SHIFT_ALREADY_OPEN` en SQLite, `409 SHIFT_OPEN_RACE` en Postgres), nunca un 500 | pasa (ver nota de alcance en §4) |
| `test_replaying_an_idempotency_key_does_not_duplicate_the_movement` | §11.9: replay de la misma `Idempotency-Key` devuelve la respuesta original y no duplica el movimiento | pasa |
| `test_cash_movement_without_idempotency_key_is_rejected` | Contrato §2: sin encabezado → `400 IDEMPOTENCY_KEY_REQUIRED` con la acción correctiva | pasa |
| `test_opening_with_a_different_base_needs_a_typed_cause` | §3.2: total ≠ base fija sin causa → `400 OPENING_DIFFERENCE_NEEDS_CAUSE` y el `message` nombra la acción | pasa |
| `test_administrative_close_only_applies_to_an_abandoned_shift` | §3.7: sobre un turno no abandonado → `400 SHIFT_NOT_STALE`; con el reloj más allá de la hora de corte del día siguiente cierra con diferencia 0 y `closed_without_count` | pasa |
| `test_adjust_opening_rewrites_everything_derived_with_the_same_formula` | §3.7: ajustar apertura reescribe base, reserva y **todo lo derivado** con la misma función | pasa |
| `test_a_shift_with_activity_cannot_be_deleted` | §11.3: un turno con movimientos no se borra (`SHIFT_HAS_ACTIVITY`) | pasa |
| `test_cancelling_an_empty_shift_is_a_logical_delete` | §3.7: cancelar un turno vacío es **baja lógica**, la fila sigue existiendo | pasa |
| `test_no_shift_payload_ever_speaks_of_employee_debt` | §11.16 / CST art. 149: ningún JSON de turno trae `debt`, `deuda`, `owes` ni `payroll_deduction` | pasa |
| `test_expected_cash_is_hidden_from_an_operator_who_is_not_the_cash_responsible` | Contrato 1a: `expected_cash` sólo para admin o responsable de caja | pasa |
| `test_the_expected_does_not_leak_to_a_non_responsible_operator_through_pickups` | Lo mismo, de cerca: esconder `expected_cash` no sirve si el número viaja en `pickups[].expected_at_pickup` | **pasa** (era B-3) |
| `test_the_expected_does_not_leak_to_a_non_responsible_operator_through_handovers` | Y tampoco por `handovers[].breakdown`, que congela la ecuación entera | **pasa** (era B-4; **ahora verificado por test**, ya no por lectura) |
| `test_expected_cash_is_visible_to_the_cash_responsible` | Contrato 1a: el responsable **sí** ve su esperado en `GET /shifts/current` | **pasa** (era B-2b) |
| `test_expected_cash_is_visible_to_the_admin` | Contrato 1a: el administrador ve el esperado del turno | pasa |
| `test_reading_the_current_shift_does_not_extend_the_person_session` **(nuevo)** | §2.1: la persona activa expira «cuando pasan N minutos **sin uso**». `GET /shifts/current` es la consulta que el POS repite por *polling*: si renovara la ventana, una tablet abandonada con la pantalla del turno abierta **nunca** expiraría y todo lo tecleado después seguiría yendo a nombre de quien se fue (atribución cruzada, auditoría H9). Verificado con el reloj controlado leyendo la fila `device_sessions`, más la contraprueba de que una **escritura** sí la renueva | pasa |
| `test_a_handover_moves_the_responsibility_and_the_expected_moves_with_it` **(nuevo)** | §3.2: el relevo cambia el responsable de caja con conteo de por medio — `201` con `kind == "handover"`, `from_responsible`/`new_responsible` correctos, el turno queda a nombre del nuevo, **el nuevo pasa a ver `expected_cash` y el anterior deja de verlo** (ni por `expected_cash` ni por `handovers[].breakdown`) | pasa |

### 1.2 Identidad, aislamiento y privacidad — `test_security_invariants.py`

| Test | Regla que encarna | Estado |
|---|---|---|
| `test_admin_login_and_device_activation_set_httponly_samesite_cookies` | §11.11: `Set-Cookie` de login y activate con `HttpOnly` y `SameSite` (nunca `SameSite=None`) | pasa |
| `test_the_session_cookie_is_secure_outside_development` | §11.11 hasta el final: `secure` en producción, `httponly`, `samesite` declarados en `app/core/security.py` | pasa |
| `test_no_auth_response_body_ever_carries_a_token` | §2.1: ningún cuerpo de `/auth/*` trae un JWT ni una clave `token`/`jwt` (si no viaja, no se puede guardar en `localStorage`) | pasa |
| `test_no_endpoint_ever_returns_a_pin_or_a_password_hash` | §2.1 / Legal: `/admin/employees`, `/auth/me` y `/auth/device/identify` sin `pin`, `pin_hash` ni `password_hash` (recursivo) | pasa |
| `test_employee_document_never_reaches_a_device_session` | §7 y §8.4: el documento es dato personal **sólo de admin**; no viaja a sesiones de dispositivo | pasa |
| `test_five_failed_pins_lock_the_person_and_a_correct_pin_stays_locked` | §2.1: cinco fallos → `400 PIN_LOCKED`; el sexto, correcto, **sigue bloqueado** hasta que el reloj avanza 15 min | pasa |
| `test_pin_lock_notifies_the_administrator` | §2.1: bloquear «avisa al administrador» (`pin_locked`) | pasa |
| `test_the_active_person_expires_and_a_cash_write_asks_to_identify_again` | §2.1: la persona activa expira a los N minutos; una escritura de caja → `401 IDENTIFY_REQUIRED` | pasa |
| `test_supervisor_authorizes_discounts_but_never_cash` | §2.2: supervisor autoriza `discount_over_limit`; `pickup` y `spot_check` → `AUTHORIZATION_NOT_ALLOWED` | pasa |
| `test_with_roles_supervisor_disabled_a_supervisor_authorizes_nothing` | §1.1 + §2.2: con `roles.supervisor` apagado el supervisor no autoriza nada | pasa |
| `test_a_locked_pin_cannot_authorize_anything` | CONTRATO-INTERNO §2: un PIN bloqueado no autoriza (`PIN_LOCKED`); pasado el bloqueo vuelve a servir | pasa |
| `test_an_authorization_is_recorded_against_the_person_who_gave_it` | §2.2: reporte de autorizaciones **por autorizador** (con PIN compartido la autorización es teatro) | pasa |
| `test_admin_of_one_organization_gets_404_reading_another_organizations_data` | §1.1 / §11.19: sede, empleado, turno, producto y funciones de la org B → **404**, nunca 403 (un 403 confirma que el id existe) ni 200 | pasa |
| `test_admin_of_one_organization_gets_404_writing_another_organizations_data` | Lo mismo en escritura | pasa |
| `test_a_device_of_one_store_gets_404_on_a_shift_of_another_store` | Aislamiento también **por sede**, no sólo por organización | pasa |
| `test_device_catalog_never_carries_cost_or_margin` | §2.2 / §11.10: `GET /catalog` con dispositivo sin `cost`, `margin`, `unit_cost` ni `food_cost` (recursivo) | pasa |
| `test_openapi_of_catalog_and_shifts_declares_no_cost_fields` | Lo mismo sobre el OpenAPI: el contrato tampoco los declara | pasa |
| `test_every_sampled_error_has_exactly_one_shape` | §11.18 / §12: muestra de 400/401/404/409 con exactamente `{error:{code,message}}` y `message` no vacío | pasa |
| `test_a_disabled_feature_is_refused_by_the_backend_naming_the_feature` | §1.1 / §11.19: `cash.handovers` y `pos.combos` apagadas → `400 FEATURE_DISABLED` con `feature` en el cuerpo | pasa |
| `test_fiscal_configuration_always_carries_a_valid_from` | §8.1: la configuración fiscal es **versionada por `valid_from`**; sin él, `FISCAL_VALID_FROM_REQUIRED` | pasa |
| `test_a_suggested_tip_over_ten_percent_is_rejected` | Ley 1935/2018 + §6.2: `tip_suggested_pct > 10` no se puede configurar | pasa |
| `test_changing_a_feature_flag_leaves_an_audit_row_with_before_and_after` | §1.1: cambiar un flag queda en auditoría, con `before` y `after` **distintos** | pasa |
| `test_changing_cash_settings_leaves_an_audit_row_with_before_and_after` | Convenciones 1a: auditoría con antes y después en toda escritura de configuración | pasa |

### 1.3 Migraciones — `test_migration_invariants.py` (nuevo en la iteración 2)

Cierra el punto «SIN VERIFICAR 2» de la ronda 1. El resto de la suite usa
`create_all` (CONTRATO-INTERNO §4), que crea las tablas **desde los modelos**: por
construcción **nunca** puede ver el desfase entre una columna agregada al modelo y la
migración que nadie escribió, que es «el bug más caro del go-live» de §12. Estos tres
tests arman un archivo SQLite **nuevo** bajo `TMPDIR`, corren
`alembic.command.upgrade(Config(...), "head")` con `DATABASE_URL` apuntando a él y
comparan con `sqlalchemy.inspect` contra `Base.metadata` de
`app.core.models_registry`.

| Test | Regla que encarna | Estado |
|---|---|---|
| `test_the_migration_chain_builds_exactly_the_tables_of_the_models` | §12 + convenciones 1a («Alembic desde el primer commit»): `upgrade head` sobre base vacía deja **el mismo conjunto de tablas** que los modelos. Una tabla en el modelo sin migración revienta en el primer deploy; una en el DDL sin modelo es basura que el próximo `--autogenerate` propone borrar. Falla listando la diferencia exacta | pasa (**31 tablas**, coincidencia exacta) |
| `test_every_migrated_table_has_exactly_the_columns_of_its_model` | Lo mismo tabla por tabla, **columna por columna**: es el desfase que pasa los tests con `create_all` y en producción dice «no such column». Falla listando `tabla: faltan en el DDL [...]; sobran en el DDL [...]` | pasa (p. ej. `shifts`: 36 columnas) |
| `test_downgrading_to_base_leaves_no_table_of_the_application` | `alembic downgrade base` deja la base limpia: un `downgrade` que no deshace el `upgrade` es un rollback que no existe (el día que una migración salga mal, la salida sería restaurar un backup). Además es lo único que prueba que cada `down_revision` de `0001 → 0002 → 0003` está bien encadenada | pasa (cero tablas de la app) |

Alcance honesto: compara **nombres** de tablas y de columnas, no tipos, ni `nullable`,
ni índices, ni constraints, y corre sobre SQLite. Un `Integer` donde el modelo dice
`Numeric`, o un índice único que falta, **no** lo caza. Ampliarlo a tipos exige correr
contra Postgres (el CI ya declara el servicio) y decidir qué diferencias de dialecto
son aceptables; queda anotado para 1b.

### 1.4 Frontend — `frontend/src/audit/security.test.ts`

Recorre `frontend/src` con `fs` (`environment: node`), quita comentarios y busca
patrones prohibidos. Ignora `src/audit/**`, `**/__tests__/**` y `*.test.ts(x)`
(nombran los patrones a propósito).

| Test | Regla | Estado |
|---|---|---|
| no escribe en `localStorage`/`sessionStorage` salvo para el tema | §11.11 / `.claude/AGENTS.md § Seguridad`; excepción única: la clave contiene «theme» | pasa (hoy no hay **ningún** `setItem` en `src/`) |
| no guarda token ni sesión en almacenamiento del navegador | La misma regla, con la clave mirada de cerca (`token|session|jwt|pin|auth`) | pasa |
| no usa `new Date("YYYY-MM-DD")` | Convenciones 1a + §12: deriva el día de la zona del navegador («el día que cambia a las 7 pm») | pasa |
| no construye una fecha con `new Date(algo.business_date)` | La misma trampa por variable | pasa |
| no usa `toISOString().slice(0, 10)` | Convenciones 1a: prohibido explícitamente | pasa |
| ninguna pantalla de turno calcula esperado / diferencia / a consignar | §6.1 y §11.13: una sola matemática, en el backend | pasa |
| ninguna pantalla de turno reescribe la ecuación del cierre | §3.2: la fórmula se escribe una vez | pasa |
| el territorio de turnos existe y se está auditando de verdad | Guardia contra el falso verde: si `src/features/shifts` no existiera, los dos tests de arriba pasarían sin mirar nada | pasa |

**Heurístico de «el frontend no deriva plata» y sus falsos positivos** (documentado
también en el archivo):

- `ASSIGNMENT` = `\b(expected(_?cash)?|difference|to_?deposit|toDeposit)\s*[:=](?!=)\s*[^;,\n]*[A-Za-z0-9_)\]]\s*[-+*/]\s*[A-Za-z0-9_(]`.
  Exige un operador aritmético **entre dos operandos**, así que no acusa a
  `difference: -5_000` (literal negativo) ni a `difference_seen: review.difference`
  (el `\b` corta antes del `_`).
- `EQUATION` = la ecuación escrita a mano (`counted − expected`, `base + …sales…`).
- Falsos positivos posibles: un `expected = algo - 1` en código que no es de plata
  (hoy no existe en `features/shifts`), o un `const difference = a - b` con fines de
  UI. Si aparece uno, la respuesta correcta es **mover el cálculo al backend**, no
  aflojar el test.
- Falso negativo conocido: sólo mira `src/features/shifts/**`. Un cálculo de plata
  escrito en `src/components/**` o en `src/api/shifts.ts` no se detecta. Vale la pena
  ampliarlo en 1b, cuando el cobro entre al frontend.

---

## 2. Hallazgos

Severidad: **bloqueante** si rompe una regla dura de §11 o una regla global;
**advertencia** si no.

### 2.1 Bloqueantes — los cuatro, cerrados

| # | Qué era | Dónde se corrigió | Verificación |
|---|---|---|---|
| **B-1** | `POST /shifts/{id}/close` (cierre en un paso) no miraba `cash.blind_close`: con la función **encendida** cerraba el turno en una sola llamada, devolvía `expected` y `difference`, y salteaba el conteo a ciegas (§3.2 paso 1) y el control de `DIFFERENCE_CHANGED` (auditoría M15). Violaba §11.19 y vaciaba §3.2 | `backend/app/shifts/router.py:526-536` — el gate se resuelve **antes** de `_idempotent`, así que el rechazo no queda grabado como respuesta idempotente resuelta (detalle correcto y no obvio) | `test_the_one_step_close_is_refused_while_blind_close_is_on`, endurecido: `400` exacto, `code == "BLIND_CLOSE_REQUIRED"`, `error.feature == "cash.blind_close"`, `message` no vacío, turno todavía `open` y sin `counted_cash`/`difference` escritos |
| **B-2** | `POST /shifts/{id}/handovers` respondía **500** siempre (`AttributeError: 'str' object has no attribute 'value'`): el relevo del responsable y el arqueo sorpresa completos no funcionaban | `backend/app/shifts/router.py:112-120` — helper `_kind_str()` que normaliza el enum de SQLAlchemy o el `str` plano de una fila releída, usado en `:172` y `:338` | `test_a_handover_moves_the_responsibility_and_the_expected_moves_with_it` (nuevo, `201` + `kind == "handover"`) y el invariante de fuga por `handovers` |
| **B-2b** | `expected_cash` de `GET /shifts/current` era `null` para todo el mundo, incluido el responsable de caja: `current_device()` construía siempre `Actor(employee_id=None, role=None)`. Un campo del contrato que nunca se puebla es un campo removido | `backend/app/auth/deps.py:79-122` — `_bound_employee()` lee la persona ligada **sin** renovar su ventana de inactividad, y `current_device` la propaga cuando existe (sin exigirla) | `test_expected_cash_is_visible_to_the_cash_responsible` y `test_reading_the_current_shift_does_not_extend_the_person_session` |
| **B-3** | `pickups[].expected_at_pickup` viajaba fuera del gate: esconder `expected_cash` y mandar al lado el esperado congelado del último retiro no escondía nada | `backend/app/shifts/router.py:163-168` — `model_copy(update={"expected_at_pickup": None})` cuando no corresponde | `test_the_expected_does_not_leak_to_a_non_responsible_operator_through_pickups` |
| **B-4** | `handovers[].breakdown` —el desglose congelado `{base, cash_sales, incomes, expenses, pickups, expected, counted, difference}`— viajaba completo a cualquier operador identificado: exactamente lo que el gate intenta esconder | `backend/app/shifts/router.py:178` — `breakdown=h.breakdown if show_expected else None` | `test_the_expected_does_not_leak_to_a_non_responsible_operator_through_handovers`. **En la ronda 1 esto estaba verificado sólo por lectura** porque el `500` de B-2 mataba el test antes de llegar a la aserción; con B-2 corregido, el test corre entero y pasa: **B-4 queda verificado por test** |

Nota de calidad sobre la corrección: los cuatro gates de visibilidad ahora salen de
**una sola función**, `_can_see_expected()` (`backend/app/shifts/router.py:122-132`),
usada en `_shift_summary` (`:136`) y en `get_current` (`:238`). Es la forma correcta:
tres condiciones copiadas en tres lugares es exactamente cómo se abre la cuarta
filtración en 1b.

### 2.2 Advertencias abiertas (sin cambios respecto de la ronda 1)

Ninguna se convirtió en bloqueante en esta ronda, por instrucción del Maestro: son
decisiones del dueño de la spec, no defectos contra una regla dura declarada. Todas
fueron **re-verificadas contra el código actual** y siguen tal cual.

#### A-1 · `POST /auth/authorize` no tiene tope de intentos — **advertencia** — `backend-core`

`backend/app/auth/service.py:114` — `raise AppError(code="AUTHORIZATION_INVALID", ...)`
sin contador de intentos ni espera. Un PIN equivocado devuelve `AUTHORIZATION_INVALID`
**indefinidamente**: un PIN de 4 dígitos sin tope es un oráculo de 10.000
combinaciones **desde el POS**, y el PIN que se adivina es el que autoriza retiros de
efectivo, arqueos y rescates.

`docs/SPEC-NEGOCIO.md §2.1` fija el tope de cinco intentos para **identificarse**, no
para autorizar, así que no lo convertí en test (guardrail: no asumir normativa que la
spec no declara). Lo que sí está y funciona es que un PIN ya bloqueado no autoriza
(`app/auth/service.py:110-119`, cubierto por `test_a_locked_pin_cannot_authorize_anything`).

Sugerencia: contador por `(device_session, action)` o por sede, con la misma ventana
de 15 minutos, y notificación al administrador.

#### A-2 · `JWT_SECRET` tiene un default publicado en el repositorio — **advertencia** — `backend-core`

`backend/app/core/config.py:16` — `JWT_SECRET: str = "dev-secret-change-me"`, sin
validador que lo rechace cuando `ENV == "production"`. Quien conoce ese valor (está en
el repo) firma una cookie `admin_session` válida. Las cookies ya son
`httpOnly`/`SameSite`/`secure` en producción (verificado), pero eso protege el robo del
token, no su falsificación. PyJWT además avisa en cada corrida:
`InsecureKeyLengthWarning: The HMAC key is 20 bytes long, below the minimum
recommended 32 bytes for SHA256` (aparece 103 veces en mi propia corrida).

Sugerencia: un validador en `Settings` que falle si `ENV == "production"` y
`JWT_SECRET` es el default o mide menos de 32 bytes.

#### A-3 · `app/shifts/models.py` no usa `UTCDateTime` — **advertencia** — `backend-caja`

`backend/app/shifts/models.py` — **15** columnas con `sa.DateTime(timezone=True)` a
secas y **cero** usos de `UTCDateTime` (líneas 120, 121, 151, 168, 189, 194, 198, 240,
241, 279, 307, 344, 346, 392, 421). Los otros seis dominios (`core`, `auth`, `stores`,
`audit`, `notifications`, `catalog`) usan `app.core.db.UTCDateTime`.

Es la trampa SQLite de §12: en SQLite el tipo crudo devuelve datetimes **naive** al
leer, y compararlos contra `clock.now_utc()` (aware) tira `TypeError`. Hoy no explota
porque ningún camino de turnos compara esos campos con un aware, pero el primer
reporte que haga `shift.closed_at > algo` en 1b se cae **en dev y en tests (SQLite), no
en el Postgres del CI**: la peor combinación posible. Es la advertencia que más conviene
atender antes de 1b.

#### A-4 · `GET /admin/shifts` muestra `expected_cash` almacenado, que es `null` mientras el turno está abierto — **advertencia** — `backend-caja`

`backend/app/shifts/router.py:211` — `expected_cash=shift.expected_cash` (columna
almacenada, poblada recién en el cierre), mientras `_shift_summary` para un turno
abierto lo **calcula** con `service.compute_breakdown` (`router.py:147`).

Consecuencia: la lista de Dinero → operacional muestra el esperado en blanco para los
turnos abiertos, que es justo cuando el administrador lo necesita
(`frontend/src/features/shifts/admin/OperationalTab.tsx` ya lo pinta). No es una
desincronización de plata —`null` no es 0 y la UI lo dibuja como «—»—, pero es la
misma raíz que §6.1 marca: «derivar en vez de almacenar: … esperado».

Matiz importante: conservar `expected_cash`, `counted_cash`, `difference` y
`to_deposit` **congelados al cerrar** es correcto (son evidencia del cierre, igual que
el `breakdown` del relevo), y `adjust_opening` los recalcula con `compute_breakdown`,
la misma función, sin una segunda fórmula (verificado por
`test_adjust_opening_rewrites_everything_derived_with_the_same_formula`). Lo que hay
que corregir es sólo la lectura del turno **abierto**.

#### A-5 · La fixture compartida `db` entrega una sola `Session` a todos los requests — **advertencia** — `backend-core`

`backend/tests/conftest.py:76-100` — `_override_get_db` hace `session.begin_nested()`
sobre la **misma** `Session` del test. Una `Session` de SQLAlchemy no es thread-safe:
cualquier test de concurrencia con hilos —el que pide el checklist de 1a y §11.9— muere
con `ResourceClosedError` / `InvalidRequestError` **antes** de llegar al índice único
parcial. CONTRATO-INTERNO §3 anticipa el caso («`StaticPool` NO: los tests de
concurrencia usan hilos») pero el `get_db` compartido lo cancela.

No lo arreglé (territorio ajeno). Lo resolví dentro del mío con la fixture `race_app`
(`backend/tests/audit/conftest.py:199`), que arma una base propia bajo `TMPDIR` y un
`get_db` de **una sesión por request**, con la misma política de commit que
`app.core.db.get_db`. Sugerencia para `backend-core`: ofrecer esa variante como fixture
compartida, para que `backend-caja` y 1b puedan escribir tests de carrera sin
duplicarla.

#### A-6 · `POST /shifts/{id}/cash-swaps` y `.../pickups/{pid}/reverse` no aceptan `Idempotency-Key` — **advertencia** — `backend-caja`

`backend/app/shifts/router.py:385-396` y `426-441` — siguen siendo los dos únicos
endpoints de escritura de caja sin `_idempotent(...)` (re-verificado en esta ronda).

El contrato de 1a lista la clave para `shifts/open`, `close`, `cash-movements`,
`pickups` y `handovers`, así que **están dentro del contrato**. Pero `AGENTS.md` y
§11.9 dicen «toda escritura que mueve plata o estado acepta `Idempotency-Key`»: un
doble toque en «Cambio» crea dos filas `cash_swap` (neto cero las dos, así que la plata
no se mueve, pero el historial miente sobre cuántas veces se hizo cambio), y un doble
toque en «Reversar retiro» depende de que `PICKUP_ALREADY_REVERSED` gane la carrera.
Riesgo bajo, costo de arreglo bajo.

#### A-7 · La auditoría de empleados guarda el documento de identidad — **advertencia** (Legal) — `backend-core`

`backend/app/auth/router.py:399`, `:415` y `:449` — `_employee_out(employee).model_dump()`,
y `EmployeeOut` (`app/auth/schemas.py:120-129`) incluye `document` y `email`.

Está bien que **no** guarde `pin` ni `pin_hash` (verificado). Pero cada alta o edición
de empleado deja el número de documento dentro del JSON de `audit_logs`, que
`GET /admin/audit` lee y **exporta con `format=csv`**. Consecuencias de §8.4 (Ley
1581/2012):

- **Minimización**: el antes/después de un cambio de `can_charge` no necesita el documento.
- **Supresión**: un pedido de supresión que anonimice el maestro de empleados no
  alcanza las copias del documento dentro de la auditoría, y esas copias no son
  evidencia fiscal (a diferencia del snapshot de un documento electrónico, que §8.4 sí
  manda conservar).
- **Registro de accesos y exportaciones**: §8.4 lo pide; hoy `GET /admin/audit` no deja
  rastro de quién exportó el CSV.

Sugerencia: enmascarar `document` en el snapshot de auditoría (guardar sólo si cambió,
y como `"cambió"` o últimos dígitos) o excluirlo. **Verificar con abogado** antes de
decidir cuál: la spec ya marca §8.4 como territorio a confirmar.

#### A-8 · `run_idempotent` hace `rollback()` de la transacción entera ante una carrera — **advertencia** — `backend-core`

`backend/app/core/idempotency.py:120` — en el `except IntegrityError` de la reserva. Lo
mismo en `backend/app/shifts/service.py:367` (`open_shift`, al chocar contra el índice
único). Un `rollback()` completo tira también lo que la request ya había escrito en esa
transacción (por ejemplo, la propia fila de `idempotency_keys` de la perdedora en
`open_shift`, que después deja de existir y un replay vuelve a ejecutar). Un `SAVEPOINT`
alrededor del `flush()` que puede chocar sería más preciso. Riesgo real bajo porque
ambos caminos terminan en un error de negocio, pero es contrario al comentario de
`app/core/db.get_db` («lo que se alcanzó a escribir antes de levantarla tiene que
sobrevivir»).

#### A-9 · No hay ruta de dispositivo para listar el personal de la sede — **advertencia** — `backend-core` (+ `frontend-core`, ya declarado)

Ningún endpoint de dispositivo devuelve la lista de empleados activos: sólo existe
`GET /admin/employees` (`app/auth/router.py:331`, `Depends(current_admin)`) — verificado
enumerando las doce rutas del router de auth en esta ronda.
`frontend/src/features/auth/DeviceIdentifyPage.tsx` lo declara como gap propio y pide el
**número de empleado a mano** en vez de la grilla de nombres de §9.1.

Desde la óptica Legal el desenlace actual es el **más conservador** (no expone el padrón
de empleados a una tablet compartida), y por eso no lo marco bloqueante. Si en 1b se
agrega la ruta, tiene que devolver `EmployeeBriefOut` (id, nombre, rol) y nunca
`document`, `email` ni `discount_limit_pct` de terceros.

### 2.3 Observación de control (no es hallazgo de código)

#### O-1 · El responsable puede ver el esperado antes de contar

El contrato de 1a manda que `expected_cash` viaje al responsable de caja en
`GET /shifts/current`, y §3.2 manda que el conteo de cierre se haga **a ciegas**
(«mostrar el esperado antes de contar invita a cuadrar el conteo»). Con B-2b corregido
esto ya no es teórico: el responsable **hoy sí ve** el esperado en la tira de estado, y
puede leerlo y después entrar al cierre. El cierre a ciegas protege contra el olvido, no
contra el que quiere cuadrar.

No es un bug de nadie: es una tensión de la spec, y las dos mitades están donde el
contrato dice. Vale decidirlo antes de 1b —por ejemplo, ocultar el esperado en
`/shifts/current` a partir del momento en que se teclea el conteo, o dejarlo como está y
asumir que el control real es el arqueo sorpresa—. **Va al dueño de la spec, no a un
builder.**

---

## 3. Inventario de datos sensibles y quién los ve (según el código real)

### 3.1 PII de empleados

| Dato | Dónde vive | Quién lo ve hoy | Veredicto |
|---|---|---|---|
| `name` | `employees.name` + copia congelada en toda escritura (`opened_by_employee_name`, `cash_responsible_name`, `authorizer_name`, …) | admin y dispositivo (`EmployeeBriefOut`, roster, turno) | correcto: §2.1 exige `employee_id` FK + nombre congelado |
| `document` | `employees.document` | **sólo admin** (`EmployeeOut`, `app/auth/schemas.py:127`); verificado por `test_employee_document_never_reaches_a_device_session` | correcto — salvo la copia en auditoría (A-7) |
| `email` | `employees.email` | sólo admin (`EmployeeOut`) y el propio admin en `/auth/me` (`UserOut`) | correcto |
| `pin` (claro) | no se almacena | nadie | correcto |
| `pin_hash` | `employees.pin_hash` (bcrypt, `app/core/security.hash_secret`) | ningún esquema de salida; verificado por `test_no_endpoint_ever_returns_a_pin_or_a_password_hash` | correcto |
| `discount_limit_pct` | `employees.discount_limit_pct` | admin, y **la propia persona** al identificarse (`EmployeeBriefOut`) | aceptable: la persona necesita saber su propio límite. En 1b, cuidar que un listado de personal no se lo muestre a terceros desde el dispositivo (ver A-9) |
| `failed_pin_attempts`, `pin_locked_until` | `employees` | nadie por API; llegan al admin como notificación `pin_locked` con `payload.employee_id` | correcto |
| `employee_id` / `employee_expires_at` de la sesión | `device_sessions` | nadie por API (la sesión vive en el servidor, la cookie es opaca) | correcto — y ahora verificado que **una lectura no corre la expiración** (`test_reading_the_current_shift_does_not_extend_the_person_session`) |
| entradas/salidas/pausas (`shift_roster`) | `shift_roster` | admin y cualquier persona identificada vía `GET /shifts/{id}` | aceptable en un turno compartido; en 1b, con propinas y nómina, conviene revisarlo |

### 3.2 Secretos

| Dato | Dónde vive | Quién lo ve | Veredicto |
|---|---|---|---|
| `password_hash` (admin) | `employees.password_hash` (bcrypt) | ningún esquema de salida | correcto |
| `store_pin_hash` | `stores.store_pin_hash` (bcrypt) | ningún esquema de salida (`app/stores/router.py:73` lo dice y lo cumple); rotación por `POST /admin/stores/{id}/rotate-pin`, auditada **sin** el secreto | correcto |
| cookie de sesión (`admin_session`, `device_session`) | cookie `httpOnly`, `SameSite=lax`, `secure` en producción | el navegador; **nunca** el cuerpo de una respuesta (verificado) | correcto |
| `JWT_SECRET` | variable de entorno | — | **A-2**: default publicado en el repo, sin guardia de producción |

### 3.3 Sensibles de negocio

| Dato | Dónde vive | Quién lo ve hoy | Veredicto |
|---|---|---|---|
| `expected_cash` (turno abierto) | derivado con `compute_breakdown` | admin y **el responsable de caja del turno**, en `GET /shifts/{id}` y en `GET /shifts/current`; el gate es `_can_see_expected()` (`app/shifts/router.py:122`) | **correcto** (era B-2b). Tensión de diseño en O-1 |
| `expected_at_pickup` (snapshot del retiro) | `cash_pickups.expected_at_pickup` | admin y responsable; `null` para el resto | **correcto** (era B-3) |
| `breakdown` del relevo/arqueo (`base…expected…difference`) | `shift_handovers.breakdown` | admin y responsable; `null` para el resto | **correcto** (era B-4) |
| `cash_over_threshold` (bandera) | derivada en `GET /shifts/current` | **cualquiera con el dispositivo activado** | correcto: es un bit deliberado del contrato de 1a (`spec.md:121`) y de la notificación homónima — «el cajón está muy lleno, hagan un retiro». Revela una cota gruesa del esperado, pero es la información que hace el control, no la que lo rompe |
| `difference`, `to_deposit`, `close_cause` | `shifts` (congelados al cerrar) | admin y cualquier persona identificada vía `GET /shifts/{id}` | aceptable para 1a (el turno es responsabilidad compartida); si el dueño quiere restringirlo, es la misma puerta que ya existe: `_can_see_expected()` |
| costos / márgenes / `food_cost` | **no existen** en `app/catalog/**` en esta fase | nadie | correcto: verificado en la respuesta **y** en el OpenAPI |
| configuración fiscal de la sede | `store_fiscal_configs`, versionada por `valid_from` | sólo admin | correcto |
| auditoría con antes/después | `audit_logs` | sólo admin (`GET /admin/audit`, exportable a CSV) | correcto en control de acceso; **A-7** por el documento adentro y por la falta de registro de exportaciones |

### 3.4 Lo que el sistema deliberadamente **no** guarda

- **Ninguna deuda de empleado ni deducción de nómina** (§11.16, CST art. 149):
  verificado por `test_no_shift_payload_ever_speaks_of_employee_debt`, que barre
  recursivamente todo JSON de turno buscando `debt`, `deuda`, `owes` y
  `payroll_deduction`. No aparece ninguno, y tampoco hay columnas con esos nombres.
- **Ningún dato de cliente**: correcto, el maestro de clientes es 1b (§8.4: «nada de
  datos en ventas a consumidor final»).

---

## 4. Lo que quedó sin poder verificar, y por qué

Los dos puntos de la ronda 1 que eran deuda propia —B-4 por test y la cadena de
Alembic— **quedaron cerrados**. Lo que sigue abierto es lo que no se puede cerrar desde
mi territorio o desde este entorno.

1. **El `409 SHIFT_OPEN_RACE` literal.** `test_two_concurrent_opens_leave_exactly_one_winner`
   verifica lo que importa (un solo ganador, la perdedora rechazada limpiamente, un solo
   turno abierto), pero en SQLite la perdedora llega siempre como
   `400 SHIFT_ALREADY_OPEN`: el motor serializa las escrituras, así que la segunda
   request ya ve el turno confirmado y para en la validación antes del índice. La rama
   `409` existe y está escrita (`app/shifts/service.py:365-371`,
   `IntegrityError → SHIFT_OPEN_RACE`), pero **sólo es alcanzable con concurrencia
   real**: hay que probarla en el CI contra el servicio Postgres. Ambas respuestas están
   declaradas en el contrato de 1a, así que ninguna es un hallazgo.
2. **Postgres, y el alcance del test de migraciones.** Todo corrió en SQLite. El
   invariante nuevo compara **nombres** de tablas y columnas, no tipos, `nullable`,
   índices ni constraints: un `Integer` donde el modelo dice `Numeric`, o un índice único
   que falta en el DDL a mano, **no** lo caza. Las trampas de §12 que quedan fuera:
   orden de `NULL` en `ORDER BY DESC`, tope de variables en `IN (...)`, `MIN` sobre
   `Date`. Lo que sí verifiqué por lectura: no hay enums nativos (`native_enum=False` en
   todos los modelos), no hay `func.date()` ni `extract()` sobre columnas, no hay
   `datetime.now()` ni `datetime.utcnow()` fuera de `app/core/clock.py`, y no hay ningún
   `db.delete()` en `app/` (nada financiero se borra físicamente).
3. **El menú del día por franja y día** (checklist §16: «aparece `active_now` sólo en su
   franja»). Es territorio de `catalogo` y tiene sus propios tests; no lo dupliqué. Sí
   verifiqué lo que me toca de la carta: que `GET /catalog` con dispositivo no trae
   costos ni márgenes, ni en la respuesta ni en el OpenAPI.
4. **Accesibilidad (WCAG 2.1 AA)** y el resto de la UI: no es mi rol ni mi territorio.
5. **Lo fiscal.** Como manda el guardrail, en 1a sólo verifiqué que la configuración
   fiscal tenga `valid_from` obligatorio y que `tip_suggested_pct > 10` se rechace. Todo
   lo demás —INC 8 %, régimen SIMPLE, documento equivalente electrónico— es 1b y la spec
   ya lo marca como **verificar con contador**.
6. **Marcado como «verificar con abogado» por la propia spec**, y así queda: el
   tratamiento de datos de empleados de §8.4 (A-7), y la advertencia de §3.2 sobre qué
   puede hacer el dueño con una diferencia de caja (el sistema reporta la diferencia por
   persona y **nunca** calcula una deuda: eso está verificado y es lo único que el
   sistema tiene que garantizar).

---

## 5. Resumen para el Maestro

- **Cero bloqueantes abiertos.** B-1, B-2, B-2b, B-3 y B-4 están corregidos y
  verificados por test. B-4, que en la ronda 1 sólo tenía respaldo de lectura, ahora
  tiene su invariante corriendo entero.
- **Cinco invariantes nuevos**: el cierre en un paso endurecido a código exacto
  (`BLIND_CLOSE_REQUIRED` + `feature` + turno todavía abierto), la lectura de
  `/shifts/current` que **no** renueva la sesión de la persona (con contraprueba de que
  una escritura sí), el relevo que mueve la responsabilidad **y el esperado con ella**, y
  tres sobre la cadena de Alembic contra los modelos (tablas, columnas, `downgrade
  base`) — 31 tablas, coincidencia exacta.
- **Nueve advertencias y una observación de control siguen abiertas**, todas
  re-verificadas contra el código de esta ronda y sin cambios. La que más conviene
  atender antes de 1b es **A-3** (`UTCDateTime` en `app/shifts/models.py`), porque
  explota en dev y en tests (SQLite) y no en el Postgres del CI. La que hay que decidir,
  no arreglar, es **O-1**.
- **La caja está sólida**: una sola fórmula (`compute_breakdown`), un solo gate de
  visibilidad (`_can_see_expected`), reserva fuera del esperado, swap neutro, retiro con
  snapshot y reversa sin borrar, tolerancias que alertan y no bloquean, foto exigida en
  el backend, idempotencia reservada dentro de la transacción, índice único parcial,
  auditoría con antes y después en cada escritura, aislamiento por organización y por
  sede con `404` (nunca `403`), y cero campos de costo hacia el dispositivo.
- **Comandos para reproducir**:
  `cd backend && TMPDIR=/tmp/pt-auditor-control python -m pytest tests/audit -q` (58 verdes, ~3 min),
  `cd backend && python -m mypy tests/audit`,
  `cd frontend && npx vitest run src/audit` (8 verdes).
