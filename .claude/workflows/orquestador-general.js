/**
 * Orquestador General — sistemas-maestros
 *
 * El EQUIPO NO ES FIJO: la Fase 0 (Planificación) le pide al Maestro (Fable)
 * que analice el pedido y el repo y DEFINA qué agentes lanzar. La librería de
 * `.claude/skills/agentes/` es un catálogo, no un mandato — el Maestro
 * reutiliza definiciones que calcen, las adapta, descarta las que no aporten
 * y crea roles nuevos cuando el problema pide un especialista que la librería
 * no tiene. Después: construcción en paralelo (territorios disjuntos),
 * Conciliador con veredicto estructurado, iteración hasta coherencia (máx 3
 * rondas) y entrega con historial.
 *
 * Uso (desde la raíz del repo instanciado, con este framework como submodule
 * o clonado):
 *   Workflow({ scriptPath: 'systems-master/.claude/workflows/orquestador-general.js',
 *              args: { pedido: '...', outputs: 'features/<slug>/outputs',
 *                      spec: 'features/<slug>/spec.md',
 *                      contexto: ['docs/ESTADO.md'] } })
 *
 * Ver: .claude/skills/agentes/maestro-fable.md · conciliador.md · agente-*.md
 */

export const meta = {
  name: 'orquestador-sistema-maestro',
  description: 'Orquestación multi-agente con equipo dinámico: el Maestro define qué agentes lanzar según el problema',
  whenToUse: 'Construcción de features/sistemas que cruzan varias especialidades. El pedido va en args.pedido; el equipo lo decide el Maestro, no una plantilla.',
  phases: [
    { title: 'Planificación', detail: 'El Maestro analiza pedido+repo y define el equipo ad-hoc (librería de agentes como catálogo, no mandato)' },
    { title: 'Construcción', detail: 'El equipo definido trabaja en paralelo, territorios disjuntos' },
    { title: 'Conciliación', detail: 'Cruce estructurado de outputs contra el código real (git diff)' },
    { title: 'Iteración', detail: 'Reajuste de agentes con conflictos bloqueantes (máx 3 rondas)' },
    { title: 'Entrega', detail: 'Síntesis del Maestro: equipo elegido, historial, conflictos abiertos' },
  ],
}

const MAX_ITERATIONS = 3

// El framework puede vivir como submodule (systems-master/) o ser el repo raíz;
// los agentes resuelven con ls cuál de los dos directorios existe.
const AGDIR = 'systems-master/.claude/skills/agentes o .claude/skills/agentes'

const PEDIDO = (args && args.pedido) || null
if (!PEDIDO) {
  return { error: 'Falta args.pedido — el orquestador necesita el pedido del usuario en lenguaje natural' }
}
const OUT = (args && args.outputs) || 'outputs'
const SPEC = (args && args.spec) || null
const CONTEXTO_FILES = (args && args.contexto) || []

const CONTEXTO = [
  'CONTEXTO OBLIGATORIO — leé estos archivos ANTES de trabajar:',
  ...CONTEXTO_FILES.map((f, i) => (i + 1) + '. ' + f + ' (leelo COMPLETO — las reglas del proyecto mandan sobre tu definición de rol)'),
  ...(SPEC ? [(CONTEXTO_FILES.length + 1) + '. ' + SPEC + ' — la spec de este pedido.'] : []),
  '',
  'NO hagas commit ni push — eso lo hace el orquestador humano después de revisar.',
  'Escribí tu entregable COMPLETO (no un resumen) en el archivo de salida indicado. Tu retorno estructurado NO lo ve un humano: es data para el orquestador.',
].join('\n')

// Regla de verificación para TODOS los agentes de construcción y auditoría.
// Nació de una fase real: cuatro agentes decidieron por su cuenta que
// "verificar" era "correr la suite entera", en paralelo, en el mismo
// directorio y en una máquina de 4 cores — 40+ minutos sin que ninguna
// terminara, y bases SQLite borrándose entre sí. La suite completa es un
// recurso compartido: la corre UNA sola vez el paso de verificación, en serie.
const REGLA_VERIFICACION =
  'REGLA DE VERIFICACIÓN (obligatoria, vale para builders y auditores): ' +
  'corré SOLO los tests de tu territorio — los archivos de test que escribiste o que cubren lo que tocaste (p. ej. `pytest tests/test_mi_modulo.py`, `vitest src/mi-componente`), más el typecheck. ' +
  'NUNCA corras la suite completa del proyecto: otros agentes trabajan en paralelo sobre el mismo árbol y N suites simultáneas se pisan (CPU, archivos temporales, bases de prueba borradas por el teardown ajeno) y no terminan nunca. ' +
  'La suite completa la corre UNA sola vez, en serie, el paso de verificación del orquestador cuando el equipo ya terminó. ' +
  'Tampoco lances builds que borren y reescriban artefactos compartidos (p. ej. `npm run build` sobre dist/ que el backend sirve) — un typecheck alcanza para tu entregable; el build va en verificación. ' +
  'Si tus tests necesitan un directorio temporal, usá uno PROPIO (TMPDIR=/tmp/pt-<tu-id>) para que tu teardown no borre archivos de otro agente.'

const EQUIPO_SCHEMA = {
  type: 'object',
  required: ['analisis', 'equipo'],
  properties: {
    analisis: { type: 'string', description: 'Qué dimensiones tiene el pedido y qué rol cubre cada una' },
    equipo: {
      type: 'array', minItems: 2, maxItems: 6,
      items: {
        type: 'object',
        required: ['id', 'nombre', 'modelo', 'tipo', 'mision'],
        properties: {
          id: { type: 'string', description: 'kebab-case único' },
          nombre: { type: 'string' },
          modelo: { type: 'string', enum: ['sonnet', 'opus', 'haiku'], description: 'sonnet=construir código; opus=validación/razonamiento pesado; haiku=mecánico' },
          tipo: { type: 'string', enum: ['builder', 'auditor'] },
          mision: { type: 'string', description: 'Prompt COMPLETO y autocontenido: rol, tareas verificables, qué explorar primero, guardrails, contenido del entregable. El agente que la recibe no vio el análisis del Maestro.' },
          definicion_base: { type: 'string', description: 'Ruta a un agente-*.md de la librería si reutiliza uno, o "nueva"' },
        },
      },
    },
  },
}

const BUILDER_SCHEMA = {
  type: 'object',
  required: ['resumen', 'entregables', 'archivos_tocados', 'endpoints', 'gaps'],
  properties: {
    resumen: { type: 'string' },
    entregables: { type: 'array', items: { type: 'string' } },
    archivos_tocados: { type: 'array', items: { type: 'string' } },
    endpoints: { type: 'array', items: { type: 'string' }, description: 'Expuestos o consumidos; vacío si no aplica' },
    gaps: { type: 'array', items: { type: 'string' }, description: 'Todo lo asumido, faltante o dependiente de otro agente' },
  },
}

const CONCILIADOR_SCHEMA = {
  type: 'object',
  required: ['coherente', 'conflicts'],
  properties: {
    coherente: { type: 'boolean' },
    conflicts: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'origen', 'destino', 'descripcion', 'severidad'],
        properties: {
          id: { type: 'string' },
          origen: { type: 'string', description: 'id del agente cuyo output origina el conflicto' },
          destino: { type: 'string', description: 'id del agente que debe resolverlo' },
          descripcion: { type: 'string' },
          severidad: { type: 'string', enum: ['bloqueante', 'advertencia'] },
        },
      },
    },
  },
}

const AJUSTES_SCHEMA = {
  type: 'object',
  required: ['ajustes'],
  properties: {
    ajustes: {
      type: 'array',
      items: {
        type: 'object',
        required: ['agente', 'instrucciones'],
        properties: { agente: { type: 'string' }, instrucciones: { type: 'string' } },
      },
    },
  },
}

// ─── Fase 0: el Maestro define el equipo ───────────────────────────────────
phase('Planificación')
log('Maestro analizando el problema y armando el equipo...')
const plan = await agent(
  'Sos el MAESTRO ORCHESTRATOR (Fable) de sistemas-maestros. Encontrá y leé tu definición: maestro-fable.md en ' + AGDIR + ' (resolvé con ls cuál existe en este repo).\n\n' +
  'PEDIDO DEL USUARIO: "' + PEDIDO + '"\n\n' +
  'Tu primera tarea es DEFINIR EL EQUIPO: qué agentes hacen falta para ESTE problema en concreto. No hay roster fijo — el equipo sale del análisis del pedido, no de una plantilla.\n' +
  'Para decidir con fundamento: (1) leé ' + (SPEC ? SPEC + ' y ' : '') + (CONTEXTO_FILES.join(', ') || 'los docs del proyecto') + ' completos; (2) explorá la estructura real del repo para ver dónde está la complejidad de verdad; (3) revisá la librería de agentes (agente-*.md en el mismo directorio de tu definición) — es un catálogo, no un mandato: reutilizá los que calcen tal cual o adaptados, descartá los que no aporten, y creá roles NUEVOS si el problema pide un especialista que la librería no tiene.\n\n' +
  'Reglas del equipo: entre 2 y 6 agentes; cada builder debe poder trabajar EN PARALELO sin pisar los archivos de otro (repartí el territorio explícitamente en las misiones); cada misión debe ser autocontenida y verificable. Asigná modelo por costo/beneficio real (sonnet=construir código, opus=razonamiento pesado, haiku=mecánico).\n' +
  REGLA_VERIFICACION,
  { label: 'maestro:planificación', phase: 'Planificación', schema: EQUIPO_SCHEMA }
)
if (!plan || !plan.equipo || !plan.equipo.length) {
  return { error: 'El Maestro no devolvió equipo — abortado', plan }
}
log('Equipo definido (' + plan.equipo.length + '): ' + plan.equipo.map(a => a.id + ' [' + a.modelo + ']').join(', '))

const TEAM = {}
for (const a of plan.equipo) TEAM[a.id] = a

function misionCompleta(a, ajuste, iter) {
  const outFile = OUT + '/' + a.id + '.md'
  let p = 'Sos "' + a.nombre + '" (' + a.tipo + ') del equipo sistemas-maestros armado para: "' + PEDIDO + '".\n\n' +
    'TU MISIÓN (definida por el Maestro):\n' + a.mision + '\n\n' +
    (a.definicion_base && a.definicion_base !== 'nueva' ? 'Tu definición base de rol (leela y respetá sus guardrails): ' + a.definicion_base + '\n' : '') +
    CONTEXTO + '\n\nTu archivo de salida: ' + outFile + ' (mkdir -p si hace falta).'
  if (a.tipo === 'builder') p += '\nComo builder: escribí CÓDIGO REAL en el repo y verificalo con las herramientas del proyecto antes de terminar — SOLO sobre tu territorio (tus archivos de test, tu typecheck), nunca la suite completa.'
  p += '\n\n' + REGLA_VERIFICACION
  if (ajuste) {
    p += '\n\n=== AJUSTE DE ITERACIÓN ' + iter + ' (del Maestro, derivado del Conciliador) ===\n' + ajuste +
      '\nYa trabajaste en rondas anteriores: tu output previo está en ' + outFile + ' y tus cambios ya están en el repo. ACTUALIZÁ (no dupliques).'
  }
  return p
}

// ─── Fases 1-3: construcción, conciliación, iteración ──────────────────────
const historial = []
const latest = {}
let veredicto = null
let ajustesPorAgente = null

for (let iter = 1; iter <= MAX_ITERATIONS; iter++) {
  const fase = iter === 1 ? 'Construcción' : 'Iteración'
  const ids = iter === 1 ? Object.keys(TEAM) : Object.keys(TEAM).filter(id => ajustesPorAgente && ajustesPorAgente[id])
  if (iter > 1 && ids.length === 0) break
  log('Ronda ' + iter + ': disparando ' + ids.length + ' agentes (' + ids.join(', ') + ')')

  const results = await parallel(ids.map(id => () =>
    agent(misionCompleta(TEAM[id], ajustesPorAgente ? ajustesPorAgente[id] : null, iter), {
      label: id + (iter > 1 ? ' r' + iter : ''),
      phase: fase,
      model: TEAM[id].modelo,
      schema: BUILDER_SCHEMA,
    })
  ))
  ids.forEach((id, i) => { if (results[i]) latest[id] = results[i] })
  const muertos = ids.filter((id, i) => !results[i])
  if (muertos.length) log('AVISO: agentes sin resultado esta ronda: ' + muertos.join(', '))

  log('Ronda ' + iter + ': conciliando...')
  veredicto = await agent(
    'Sos el CONCILIADOR AGENT de sistemas-maestros. Encontrá y leé tu definición (conciliador.md en ' + AGDIR + ') y cumplila al pie de la letra — generalizada: el equipo NO es un roster fijo; es este equipo dinámico definido por el Maestro:\n' + JSON.stringify(plan.equipo.map(a => ({ id: a.id, nombre: a.nombre, tipo: a.tipo, mision: a.mision }))) + '\n\n' +
    'Leé TODOS los outputs completos en ' + OUT + '/ (ls primero) y verificá contra el código real: git diff --stat y git diff sobre los directorios tocados (un output que declara algo que el diff no muestra ES un conflicto bloqueante).\n' +
    'Cruces obligatorios según las misiones: contratos consumidos vs expuestos entre agentes; reglas de validación de los auditores vs lo que el código implementa de verdad; gaps declarados — ¿alguien los resolvió o siguen abiertos?; cumplimiento de las reglas del proyecto (' + (CONTEXTO_FILES.join(', ') || 'docs del repo') + ').\n' +
    'Resúmenes estructurados de esta ronda:\n' + JSON.stringify(latest) + '\n' +
    'En cada conflicto, origen y destino son ids del equipo de arriba. coherente=true SOLO sin bloqueantes. No propongas soluciones: describí con precisión accionable. Sé determinista.',
    { label: 'reconciliation r' + iter, phase: 'Conciliación', model: 'haiku', schema: CONCILIADOR_SCHEMA }
  )
  if (!veredicto) { log('Conciliador sin resultado — corto la iteración'); break }
  historial.push({ ronda: iter, agentes: ids, conflicts: veredicto.conflicts, coherente: veredicto.coherente })
  const bloqueantes = veredicto.conflicts.filter(c => c.severidad === 'bloqueante')
  log('Ronda ' + iter + ': ' + veredicto.conflicts.length + ' conflictos (' + bloqueantes.length + ' bloqueantes), coherente=' + veredicto.coherente)

  if (veredicto.coherente || bloqueantes.length === 0) break
  if (iter === MAX_ITERATIONS) { log('MAX_ITERATIONS alcanzado con conflictos abiertos — se reportarán explícitamente'); break }

  const ajustes = await agent(
    'Sos el MAESTRO ORCHESTRATOR (Fable). Vos armaste este equipo: ' + JSON.stringify(plan.equipo.map(a => ({ id: a.id, nombre: a.nombre, tipo: a.tipo }))) + '\n' +
    'El Conciliador (fuente de verdad de coherencia — no modifiques su veredicto) reportó en la ronda ' + iter + ':\n' + JSON.stringify(veredicto.conflicts) + '\n' +
    'Resúmenes de los agentes: ' + JSON.stringify(latest) + '\n' +
    'Para cada conflicto BLOQUEANTE decidí qué agente(s) del equipo deben ajustar su trabajo y redactá instrucciones PRECISAS y accionables. Usá exactamente los ids del equipo. Mantené a cada agente en su rol. Un solo bloque de instrucciones por agente.',
    { label: 'maestro:ajustes r' + iter, phase: 'Iteración', schema: AJUSTES_SCHEMA }
  )
  ajustesPorAgente = {}
  if (ajustes && ajustes.ajustes.length) {
    for (const a of ajustes.ajustes) {
      if (!TEAM[a.agente]) { log('AVISO: maestro nombró id desconocido "' + a.agente + '" — ignorado'); continue }
      ajustesPorAgente[a.agente] = (ajustesPorAgente[a.agente] ? ajustesPorAgente[a.agente] + '\n' : '') + a.instrucciones
    }
  }
  if (!Object.keys(ajustesPorAgente).length) {
    for (const c of bloqueantes) { if (TEAM[c.destino]) ajustesPorAgente[c.destino] = (ajustesPorAgente[c.destino] || '') + '\nResolver: ' + c.descripcion }
    log('Fallback determinista sobre destinos de conflictos bloqueantes')
  }
}

// ─── Fase 4: entrega ───────────────────────────────────────────────────────
phase('Entrega')
const sintesis = await agent(
  'Sos el MAESTRO ORCHESTRATOR (Fable). Cerrá el ciclo. Equipo que definiste y por qué: ' + JSON.stringify({ analisis: plan.analisis, equipo: plan.equipo.map(a => ({ id: a.id, nombre: a.nombre, modelo: a.modelo, tipo: a.tipo })) }) + '\n' +
  'Historial de iteraciones: ' + JSON.stringify(historial) + '\nVeredicto final del Conciliador: ' + JSON.stringify(veredicto) + '\n' +
  'Antes de redactar, VERIFICÁ con las herramientas del proyecto (tests, typecheck, lo que el repo defina' + (SPEC ? ', y el checklist de ' + SPEC : '') + ') — contra el código, no contra los reportes. ' +
  'Acá y SOLO acá corre la suite completa: UNA vez (dos si el proyecto lo pide), en SERIE, con el árbol quieto — ningún otro agente está trabajando ya. Antes de correrla confirmá que no quede ningún proceso de test o build huérfano (ps), y no lances builds del frontend mientras la suite corre: un build que borra y reescribe dist/ a mitad de corrida produce errores falsos.\n' +
  'Leé los outputs completos en ' + OUT + '/ y redactá la ENTREGA FINAL en ' + OUT + '/ENTREGA.md: qué equipo armaste y por qué (parte del valor del framework), qué construyó/halló cada agente (con archivos), coherencia, verificación, conflictos NO resueltos (explícitos, nunca ocultos), próximos pasos priorizados. Español, directo, sin humo.',
  { label: 'maestro:entrega', phase: 'Entrega' }
)

return {
  equipo: plan.equipo.map(a => ({ id: a.id, nombre: a.nombre, modelo: a.modelo, tipo: a.tipo, base: a.definicion_base })),
  analisis_maestro: plan.analisis,
  iteraciones: historial.length,
  coherente: veredicto ? veredicto.coherente : null,
  conflictos_finales: veredicto ? veredicto.conflicts : [],
  resumenes: latest,
  sintesis,
}
