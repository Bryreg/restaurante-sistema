# AGENTS.md — Restaurante Sistema

Hereda todas las reglas globales de `.claude/AGENTS.md` (framework
sistemas-maestros 2.0.0). **Acá va únicamente lo que este proyecto hace
DISTINTO**, y cada excepción con su por qué: una regla global que se aparta en
silencio es una regla que no existe.

## Dominio

POS y control interno para restaurantes en Colombia, **pensado para venderse a varios**:
cada restaurante habilita las funciones que su complejidad pide (mostrador, mesas,
cocina, recetas, inventario, dinero). Lo usan
dos personas distintas: el operador del salón (mesero o cajero) en una tablet
compartida en modo kiosko, y el administrador en PC. La spec completa está en
`docs/SPEC-NEGOCIO.md`; las reglas que no se negocian, en su sección 11.

## Lo que se aparta de las reglas globales

| Regla global | Qué hace este proyecto | Por qué |
|---|---|---|
| Stack default (FastAPI + React) | **Se mantiene.** SQLite en desarrollo, PostgreSQL en producción. | Sin motivo para apartarse; la referencia corre igual. |
| Régimen fiscal (el framework no asume ninguno) | **Colombia.** Impuesto nacional al consumo 8 % sobre todo el consumo de un restaurante no franquicia (IVA 19 % si franquicia); régimen ordinario o SIMPLE; todo por configuración de sede **con vigencia**. Propina voluntaria ≤ 10 %, preguntada al presentar la cuenta, separada de la venta y del impuesto (Ley 1935 de 2018). **Documento equivalente electrónico POS** con rangos de numeración DIAN, consecutivo sin huecos, estados de validación y contingencia de 48 h, modelado desde el pedido 1b y emitido vía proveedor tecnológico en cuanto el dueño elija uno (Res. DIAN 000165/2023). Datos de cliente sólo con finalidad declarada y prueba de autorización (Ley 1581 de 2012). | Es el país de operación. El Contador y el Legal del equipo trabajan sobre estas reglas, no las inventan. Ver `docs/SPEC-NEGOCIO.md § 8`. |
| Roles del framework (admin / usuario) | Cuatro roles: operador, **responsable de caja**, **supervisor** (autoriza anulaciones, cortesías y descuentos, no retiros ni rescates) y administrador; contador de sólo lectura en fase 2. | Un PIN de administrador compartido convierte la autorización en teatro; el supervisor con PIN propio y el reporte de autorizaciones por autorizador son el control. |
| Caja | **Base fija por sede**; una caja por turno con responsable; cierre **a ciegas en tres pasos** con causa tipada; tolerancias que alertan y nunca bloquean; el sistema **nunca calcula deuda de un empleado** (CST art. 149). | Elimina el cuadre por saldos de días anteriores y la cascada entre días que la referencia necesitó y que fabricaron sobrantes dobles. |
| Autenticación JWT | JWT para admin **y** para el dispositivo del salón (sesión larga por dispositivo activado con PIN de sede), más **PIN personal de 4 dígitos** para atribuir cada acción a una persona en el dispositivo compartido; la persona activa se liga a la sesión del dispositivo en el servidor. La sesión va en cookie `httpOnly`, nunca en `localStorage`, y por eso **frontend y API se sirven bajo el mismo origen**. | Un mesero no va a teclear correo y contraseña entre mesa y mesa. La referencia guardaba el token del kiosko en `localStorage` porque desplegaba en dos dominios; acá se cumple la regla global desde el inicio. |
| Patrón «atribución sin FK dura» (`docs/PATRONES.md` del framework) | **No se adopta.** Toda escritura de una persona guarda `employee_id` como **FK real** más `employee_name` congelado. Los empleados se desactivan, nunca se borran. | En la referencia las columnas planas fueron un parche añadido después en doce tablas; con la FK decidida desde el inicio no hace falta relajar la integridad. |
| Base de datos | PostgreSQL en producción y CI; SQLite permitido en desarrollo local y tests unitarios, con `busy_timeout` y evitando las trampas listadas en `docs/SPEC-NEGOCIO.md § 12`. Migraciones con Alembic desde el primer commit. | La referencia migraba con una lista de `ALTER` en el arranque y pagó los dos bugs más caros del go-live por columnas sin migración. |
| Idioma de UI | Español. Sin cambio. | |
| Fecha y hora | La **fecha operativa** se guarda como fecha de negocio en `America/Bogota`, en columna propia; los timestamps de auditoría en UTC. | Un día que "cambia" a las 7 pm por derivar la fecha de UTC es un bug real de la referencia. |
| Agentes del catálogo | Ninguno desactivado. El Maestro arma el equipo por fase; para fases con recetas, preparaciones e inventario se espera un rol nuevo de **especialista en inventario y costos** si el Maestro lo juzga necesario. | El catálogo es material, no mandato. |

## Reglas propias del proyecto que todos los agentes heredan

- **Es un producto para varios restaurantes.** Organización → sede; toda consulta se
  acota por organización y sede (un id ajeno es `404`). **Toda función opcional se
  construye detrás de su flag** (`docs/SPEC-NEGOCIO.md § 1.1 y 1.2`) desde el primer
  commit, el backend la hace cumplir con `400 FEATURE_DISABLED`, la interfaz se arma
  a partir de los flags de la sesión, y los tests la prueban encendida y apagada. Lo
  que es ley o integridad (auditoría, snapshots, idempotencia, fecha operativa,
  propina separada, consecutivo, causa tipada, documento fiscal si está obligado) no
  es un flag.

- **El backend hace cumplir los gates** (sin turno no se vende; sin justificación no
  se cierra con diferencia; anular lo enviado exige PIN admin). La interfaz los
  refleja; no los inventa ni los reemplaza.
- **Snapshot en la venta**: precio, tasa de impuesto, costo teórico y receta usada se
  congelan en el ítem. Ninguna consulta de reportes vuelve a la carta actual para
  valorar una venta pasada.
- **El operador no recibe costos ni márgenes** en ninguna respuesta de la API.
- **Consecutivo de tiquete sin huecos** por sede, defendido con constraint.
- **Una sola matemática, en el backend.** El frontend nunca deriva saldos, esperados
  ni diferencias. `null` no es 0. El error tolerable es el que muestra menos plata.
- **Causa tipada** (enum) en todo movimiento de caja y de inventario; nunca se
  clasifica por texto libre.
- **Toda escritura que mueve plata o estado acepta `Idempotency-Key`**, reservada
  dentro de la transacción; `409` ante concurrencia; constraints en la base para
  «un turno abierto por sede» y «una comanda abierta por mesa».
- **Errores** con una sola forma `{ error: { code, message } }`: reglas de negocio en
  `400` con código y mensaje que nombra la acción correctiva; nunca `500` por una
  regla de negocio.
- **El insumo se descuenta una sola vez**: al producir la preparación o al enviar
  el plato a cocina, nunca en ambos.
- **Nombres**: código, tests, rutas y esquemas en inglés (`order`, `shift`,
  `business_day`, `ticket`, `prep`, `ingredient`); la UI y estos documentos en
  español. La correspondencia de términos vive en `docs/ESTADO.md`.

## Verificación mínima

Los comandos que tienen que pasar antes de dar algo por hecho. Hasta que exista el
código de la fase 1, son la meta; cuando exista, son la ley y se actualizan acá:

```bash
# backend
cd backend && python -m pytest -q            # suite completa: SOLO el paso final del orquestador
cd backend && python -m mypy app             # typecheck
cd backend && uvicorn app.main:app --port 8000   # arranca y /docs responde

# frontend
cd frontend && npm run typecheck             # tsc --noEmit
cd frontend && npm run test                  # vitest: suite completa SOLO en el paso final
cd frontend && npm run build                 # SOLO en el paso final, con el árbol quieto
```

Cada agente corre **sólo los tests de su territorio** más el typecheck
(`.claude/AGENTS.md § Verificación`). La suite completa y el build los corre una
vez, en serie, la entrega del Maestro.
