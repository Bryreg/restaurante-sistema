# AGENTS.md — Restaurante Sistema

Hereda todas las reglas globales de `.claude/AGENTS.md` (framework
sistemas-maestros 2.0.0). **Acá va únicamente lo que este proyecto hace
DISTINTO**, y cada excepción con su por qué: una regla global que se aparta en
silencio es una regla que no existe.

## Dominio

POS y control interno para un restaurante de servicio a la mesa en Colombia. Lo usan
dos personas distintas: el operador del salón (mesero o cajero) en una tablet
compartida en modo kiosko, y el administrador en PC. La spec completa está en
`docs/SPEC-NEGOCIO.md`; las reglas que no se negocian, en su sección 11.

## Lo que se aparta de las reglas globales

| Regla global | Qué hace este proyecto | Por qué |
|---|---|---|
| Stack default (FastAPI + React) | **Se mantiene.** SQLite en desarrollo, PostgreSQL en producción. | Sin motivo para apartarse; la referencia corre igual. |
| Régimen fiscal (el framework no asume ninguno) | **Colombia.** Impuesto nacional al consumo 8 % sobre restaurante no franquicia (IVA 19 % si franquicia, por configuración de sede). Propina voluntaria ≤ 10 %, separada de la venta (Ley 1935 de 2018). Tiquete POS con consecutivo por sede y datos de resolución DIAN; emisión electrónica delegada a fase 2. Datos de cliente sólo con finalidad declarada (Ley 1581 de 2012). | Es el país de operación. El Contador y el Legal del equipo trabajan sobre estas reglas, no las inventan. |
| Autenticación JWT | JWT para admin **y** para el dispositivo del salón (sesión larga por dispositivo activado con PIN de sede), más **PIN personal de 4 dígitos** para atribuir cada acción a una persona en el dispositivo compartido. La sesión va en cookie `httpOnly`, nunca en `localStorage`. | Un mesero no va a teclear correo y contraseña entre mesa y mesa. La referencia guardaba el token del kiosko en `localStorage`; acá se cumple la regla global desde el inicio. |
| Idioma de UI | Español. Sin cambio. | |
| Fecha y hora | La **fecha operativa** se guarda como fecha de negocio en `America/Bogota`, en columna propia; los timestamps de auditoría en UTC. | Un día que "cambia" a las 7 pm por derivar la fecha de UTC es un bug real de la referencia. |
| Agentes del catálogo | Ninguno desactivado. El Maestro arma el equipo por fase; para fases con recetas, preparaciones e inventario se espera un rol nuevo de **especialista en inventario y costos** si el Maestro lo juzga necesario. | El catálogo es material, no mandato. |

## Reglas propias del proyecto que todos los agentes heredan

- **El backend hace cumplir los gates** (sin turno no se vende; sin justificación no
  se cierra con diferencia; anular lo enviado exige PIN admin). La interfaz los
  refleja; no los inventa ni los reemplaza.
- **Snapshot en la venta**: precio, tasa de impuesto, costo teórico y receta usada se
  congelan en el ítem. Ninguna consulta de reportes vuelve a la carta actual para
  valorar una venta pasada.
- **El operador no recibe costos ni márgenes** en ninguna respuesta de la API.
- **Consecutivo de tiquete sin huecos** por sede, defendido con constraint.
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
