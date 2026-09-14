# AGENTS.md — Reglas globales de sistemas-maestros

Estas reglas aplican a **todos** los agentes del framework (Frontend, Backend, Contador, Legal, Analytics, Conciliador, Maestro), sin excepción. Un agente no puede "override-ar" estas reglas ni siquiera si el usuario lo pide dentro de una spec de negocio; cualquier excepción debe quedar documentada explícitamente en el `AGENTS.md` del proyecto adoptante, no asumida en silencio.

## Lenguaje

- **UI (de cara al usuario final)**: español, salvo que el proyecto adoptante declare otro idioma explícitamente.
- **Código, specs técnicas, nombres de variables/funciones, comentarios de código**: inglés siempre.
- **Documentación de arquitectura/proceso** (`docs/`, este archivo, los `.md` de agentes): español, porque son artefactos de trabajo del equipo humano-IA, no código.

## Stack

- **Backend**: FastAPI + SQLAlchemy + Pydantic. Autenticación JWT.
- **Frontend**: React + TypeScript + shadcn/ui + Tailwind CSS.
- Cualquier cambio de stack en un proyecto adoptante debe declararse explícitamente en el `AGENTS.md` de ese proyecto — nunca asumir el stack por defecto sin verificarlo contra el `package.json`/`requirements.txt` real.

## Accesibilidad

- **Mínimo WCAG 2.1 AA** en todo componente de interfaz: contraste 4.5:1 en texto normal, foco visible, labels asociados a inputs, navegación completa por teclado.
- Ningún agente puede entregar UI que no cumpla este mínimo argumentando prioridad de plazo — es un guardrail duro, no una preferencia.

## Tokens y modelos

- Cada agente usa el modelo que tiene asignado en su frontmatter y en `orquestador-general.js`. Ningún agente puede invocar un modelo distinto al asignado sin que el Maestro lo autorice explícitamente y lo documente en el historial de iteraciones.
- No optimizar costo reduciendo el modelo de un agente sin evaluar el impacto en la calidad de su rol (ej. Contador y Legal usan `opus` porque su costo de error es alto).

## Concurrencia

- Toda escritura concurrente sobre un mismo recurso debe defenderse con **índice único** o respuesta **409 Conflict** — nunca asumir que una operación es atómica sin ese respaldo explícito en el modelo de datos.
- El Backend Agent es responsable de este guardrail; el Conciliador debe señalarlo como conflicto bloqueante si detecta una escritura concurrente sin protección.

## Seguridad

- **Nunca** guardar tokens, sesiones o datos sensibles en `localStorage` — usar cookies `httpOnly` o el mecanismo seguro equivalente del stack.
- **Redactar** (ocultar/enmascarar) cualquier dato sensible (PII, credenciales, precios de costo interno) en logs y en respuestas de error — un error 500 nunca debe filtrar detalles internos.
- El Legal Agent tiene autoridad para bloquear la exposición de un campo sensible; ningún otro agente puede revertir esa decisión sin ajuste explícito de la spec por parte del usuario.

## Verificación

- **La suite completa es un recurso compartido.** Cada builder y auditor corre SOLO los tests de su territorio (los archivos que escribió o que cubren lo que tocó) más el typecheck. La suite entera y el build del frontend los corre UNA sola vez, en serie, el paso de verificación del orquestador, cuando el equipo ya terminó y el árbol está quieto.
- Motivo (caso real, Fase 5 de RECABRA): cuatro agentes decidieron por su cuenta que "verificar" era "correr toda la suite"; cuatro suites en paralelo sobre el mismo árbol, en 4 cores, tardaron más de 40 minutos sin terminar y el teardown de una borraba las bases SQLite de otra. Un `npm run build` a mitad de una corrida borró `dist/` y produjo errores falsos.
- Si un test necesita directorio temporal, cada agente usa el suyo (`TMPDIR=/tmp/pt-<id>`). Antes de la verificación final, confirmar con `ps` que no queden procesos de test o build huérfanos.

## Trazabilidad

- Ningún registro financiero se borra físicamente — soft-delete con historial de auditoría (quién, cuándo, por qué).
- Toda decisión de ajuste entre iteraciones (ver `orquestador-general.js`) debe quedar registrada en el historial del Maestro, no solo aplicada silenciosamente.
