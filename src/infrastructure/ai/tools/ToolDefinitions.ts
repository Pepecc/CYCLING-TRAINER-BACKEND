import { AgentTool, AgentToolParameter } from '../../../domain/chat/AgentTool'
import {
  STEP_KINDS, TARGET_TYPES, WORKOUT_FOCUSES, ENVIRONMENTS, PLANNED_STATUSES,
} from '../../../domain/planning/PlannedWorkout'
import { RACE_PRIORITIES, RACE_TYPES } from '../../../domain/events/RaceEvent'
import { TEST_PROTOCOLS } from '../../../domain/testing/fitnessTest'

const scale = (what: string) => ({ type: 'number' as const, description: `${what} (1-5)` })

// ─── Esquema de un entreno planificado (compartido por save y update) ────────

const targetSchema: AgentToolParameter = {
  type: 'object',
  description: `Objetivo de intensidad del paso.
    hr_zone: zona de FC (1-5) en "zone" y opcionalmente "zone_max" para un rango (p.ej. Z1-Z2). Es el objetivo por defecto en bici estática con pulsómetro.
    power_zone: zona de potencia de Coggan (1-7) en "zone" / "zone_max".
    ftp_percent: % del FTP en "min" / "max" (p.ej. 88-94).
    power_w: vatios en "min" / "max". hr_bpm: ppm en "min" / "max". rpe: esfuerzo percibido 1-10 en "min" / "max".
    open: sin objetivo (rodar libre).`,
  properties: {
    type: { type: 'string', enum: TARGET_TYPES },
    zone: { type: 'number', description: 'Zona (hr_zone, power_zone)' },
    zone_max: { type: 'number', description: 'Zona superior de un rango de zonas (opcional)' },
    min: { type: 'number', description: 'Valor mínimo (ftp_percent, power_w, hr_bpm, rpe)' },
    max: { type: 'number', description: 'Valor máximo (opcional; si falta, igual al mínimo)' },
  },
  required: ['type'],
}

const stepSchema: AgentToolParameter = {
  type: 'object',
  properties: {
    kind: { type: 'string', enum: STEP_KINDS, description: 'warmup calentamiento · work trabajo · recovery recuperación entre series · steady ritmo continuo · cooldown vuelta a la calma' },
    duration_min: { type: 'number', description: 'Duración en minutos (admite decimales, p.ej. 0.5 = 30 s)' },
    target: targetSchema,
    cadence_min: { type: 'number', description: 'Cadencia mínima en rpm (opcional)' },
    cadence_max: { type: 'number', description: 'Cadencia máxima en rpm (opcional)' },
    notes: { type: 'string', description: 'Indicación breve para el paso (opcional)' },
  },
  required: ['kind', 'duration_min', 'target'],
}

const blockSchema: AgentToolParameter = {
  type: 'object',
  description: 'Bloque de pasos que se repite "repeat" veces. Las series van en un bloque: 4 × (8 min Z4 + 4 min Z1) = repeat 4 con dos pasos.',
  properties: {
    name: { type: 'string', description: 'Nombre del bloque, p.ej. "Calentamiento" o "Series" (opcional)' },
    repeat: { type: 'number', description: 'Repeticiones del bloque. Default: 1' },
    steps: { type: 'array', items: stepSchema, minItems: 1 },
  },
  required: ['steps'],
}

const workoutProperties: Record<string, AgentToolParameter> = {
  date: { type: 'string', description: 'Fecha del entreno, AAAA-MM-DD' },
  title: { type: 'string', description: 'Título corto, p.ej. "Umbral 4×8"' },
  focus: { type: 'string', enum: WORKOUT_FOCUSES, description: 'Objetivo principal de la sesión. "rest" = día de descanso' },
  environment: { type: 'string', enum: ENVIRONMENTS, description: 'indoor (bici estática / rodillo), outdoor (carretera) o any' },
  description: { type: 'string', description: 'Objetivo de la sesión y cómo ejecutarla, en 1-3 frases' },
  blocks: {
    type: 'array',
    items: blockSchema,
    description: 'Estructura completa en orden: calentamiento, parte principal y vuelta a la calma. La duración y el TSS se calculan solos a partir de ella.',
  },
  duration_min: { type: 'number', description: 'Duración total en minutos. Solo para entrenos sin estructura (fuerza, salida libre)' },
  tss: { type: 'number', description: 'TSS previsto. Solo para entrenos sin estructura' },
  notes: { type: 'string', description: 'Notas adicionales (nutrición, material, alternativas...)' },
}

// ─── Esquema de una carrera (compartido por save y update) ────────────────────

const raceProperties: Record<string, AgentToolParameter> = {
  name: { type: 'string', description: 'Nombre de la prueba, p.ej. "Quebrantahuesos"' },
  date: { type: 'string', description: 'Fecha AAAA-MM-DD (primer día si dura varios)' },
  priority: {
    type: 'string',
    enum: RACE_PRIORITIES,
    description: 'A = objetivo principal de la temporada · B = importante, se llega fresco · C = se corre como entreno',
  },
  type: { type: 'string', enum: RACE_TYPES, description: 'Tipo de prueba (gran_fondo = marcha cicloturista)' },
  days: { type: 'number', description: 'Días de competición (vueltas por etapas). Default: 1' },
  distance_km: { type: 'number', description: 'Distancia en km' },
  elevation_m: { type: 'number', description: 'Desnivel positivo en metros' },
  location: { type: 'string', description: 'Lugar' },
  goal: { type: 'string', description: 'Objetivo del ciclista en la prueba (terminar, bajar de X horas, puesto...)' },
  notes: { type: 'string', description: 'Notas (puertos clave, avituallamientos, logística...)' },
}

export const toolDefinitions: AgentTool[] = [
  {
    type: 'function',
    function: {
      name: 'get_recent_workouts',
      description: `Obtiene los entrenamientos recientes del usuario desde Wahoo con detalle completo.
        Úsalo cuando el usuario pregunte por: el entreno de hoy, ayer, esta semana,
        el último entreno, cómo fue una sesión reciente, o quiera comparar sesiones.
        Devuelve potencia, FC, TSS, IF, NP, duración y tipo de cada entreno.`,
      parameters: {
        type: 'object',
        properties: {
          days: {
            type: 'number',
            description: 'Días hacia atrás desde hoy. 1=solo hoy, 7=última semana. Default: 7',
          },
          limit: {
            type: 'number',
            description: 'Número máximo de entrenamientos a devolver. Default: 5',
          },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_block_summary',
      description: `Obtiene el resumen agregado por semana de las últimas N semanas.
        Úsalo cuando el usuario pregunte por: progresión reciente, tendencia de forma,
        carga acumulada del bloque, si está entrenando más o menos que antes,
        o para planificar las próximas semanas con contexto del bloque actual.
        Devuelve TSS semanal, horas, número de sesiones y NP media por semana.`,
      parameters: {
        type: 'object',
        properties: {
          weeks: {
            type: 'number',
            description: 'Número de semanas hacia atrás. Default: 6',
          },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_season_kpis',
      description: `Obtiene los KPIs globales de la temporada del usuario.
        Úsalo cuando el usuario pregunte por: su forma actual, CTL/ATL/TSB,
        cuánto ha entrenado en total, si está listo para una carrera,
        o para hacer planificación a medio/largo plazo.
        Devuelve CTL, ATL, TSB actuales, horas y TSS totales de temporada,
        y el pico de CTL del año.`,
      parameters: {
        type: 'object',
        properties: {},
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_profile',
      description: `Guarda en el perfil del ciclista los datos que te haya dado en la conversación.
        Úsalo en cuanto el ciclista te diga un dato nuevo o corregido: FTP, peso, horas semanales,
        nivel, objetivo, FC máxima, FC en reposo, días disponibles o lesiones.
        Las carreras y eventos no van aquí: se guardan con save_race_event.
        Incluye solo los campos que el ciclista haya dicho explícitamente; no inventes ni estimes valores.
        Para borrar un dato, no lo envíes: pide al ciclista que lo edite en su perfil.`,
      parameters: {
        type: 'object',
        properties: {
          ftp: { type: 'number', description: 'FTP en vatios' },
          weight_kg: { type: 'number', description: 'Peso en kg' },
          hours_per_week: { type: 'number', description: 'Horas semanales disponibles para entrenar' },
          experience: {
            type: 'string',
            description: 'Nivel del ciclista',
            enum: ['beginner', 'intermediate', 'advanced'],
          },
          goal: { type: 'string', description: 'Objetivo principal de la temporada, en una frase' },
          max_hr: { type: 'number', description: 'Frecuencia cardíaca máxima en ppm' },
          resting_hr: { type: 'number', description: 'Frecuencia cardíaca en reposo en ppm' },
          available_days: { type: 'string', description: 'Días de la semana disponibles, p.ej. "martes, jueves, sábado y domingo"' },
          limitations: { type: 'string', description: 'Lesiones, molestias o limitaciones físicas relevantes' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_training_plan',
      description: `Obtiene los entrenos planificados del ciclista entre dos fechas, con su estructura,
        duración, TSS previsto y estado (planned, done, partial, skipped), y los totales por semana.
        Antes enlaza los días pasados con Wahoo: cada entreno hecho lleva "realizado" (duración, TSS y % de lo previsto),
        los días pasados sin entreno quedan como saltados, y "entrenos_sin_planificar" lista lo hecho fuera del plan.
        Úsalo antes de planificar (para no duplicar sesiones), cuando pregunte qué le toca hoy o esta semana,
        cómo va la semana, o antes de modificar un entreno (necesitas su id).`,
      parameters: {
        type: 'object',
        properties: {
          from: { type: 'string', description: 'Fecha inicial AAAA-MM-DD. Default: hoy' },
          to: { type: 'string', description: 'Fecha final AAAA-MM-DD (incluida). Default: 14 días desde la inicial' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'save_planned_workout',
      description: `Guarda uno o varios entrenos en el plan del ciclista (hasta 21 a la vez, p.ej. una semana entera).
        Úsalo cuando hayas acordado con el ciclista una sesión o un plan y quiera tenerlo guardado.
        Cada entreno con estructura detallada en bloques y pasos; los días de descanso, con focus "rest" y sin bloques.
        Si algún entreno no es válido no se guarda ninguno: corrige el error y vuelve a llamar.`,
      parameters: {
        type: 'object',
        properties: {
          workouts: {
            type: 'array',
            minItems: 1,
            maxItems: 21,
            items: { type: 'object', properties: workoutProperties, required: ['date', 'title', 'focus', 'environment'] },
          },
        },
        required: ['workouts'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_planned_workout',
      description: `Modifica un entreno planificado por su id (obtenlo con get_training_plan).
        Envía solo los campos que cambian: date para moverlo de día, blocks para sustituir toda la estructura,
        status para marcarlo como hecho (done), parcial (partial), saltado (skipped) o pendiente (planned).
        El estado se enlaza solo con Wahoo; márcalo a mano solo si el ciclista lo dice (p.ej. lo hizo sin grabarlo)
        o para corregir el enlace. Un estado puesto a mano ya no lo cambia Wahoo; "planned" le devuelve el control.`,
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'id del entreno planificado' },
          ...workoutProperties,
          status: { type: 'string', enum: PLANNED_STATUSES, description: 'Estado del entreno' },
        },
        required: ['id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete_planned_workout',
      description: `Borra un entreno planificado por su id. Úsalo solo si el ciclista lo pide o acepta
        quitar la sesión del plan; para moverla de día usa update_planned_workout.`,
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'id del entreno planificado' },
        },
        required: ['id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'adapt_planned_workout',
      description: `Adapta un entreno planificado (por su id) a otro entorno y/o a los minutos que tiene el ciclista,
        manteniendo el objetivo de la sesión. El sistema recorta primero el calentamiento, la vuelta a la calma y el volumen suave,
        y después repeticiones (como mucho hasta la mitad del trabajo de calidad). En indoor pasa los objetivos a zonas de FC
        y agrupa las series cortas y sprints en series de al menos 3 min por tiempo en zona.
        Calcula la duración y el TSS, y conserva siempre la versión original.
        Úsalo cuando el ciclista diga que hoy tiene menos tiempo, que tiene que hacerlo en la bici estática o que puede salir fuera.
        Sin save devuelve una vista previa; con save: true la guarda como versión adaptada.
        Se adapta siempre desde la original: lo que no indiques se mantiene de la adaptación anterior.
        restore_original: true deshace la adaptación.`,
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'id del entreno planificado (obtenlo con get_training_plan)' },
          environment: { type: 'string', enum: ENVIRONMENTS, description: 'indoor (bici estática con pulsómetro) u outdoor (carretera)' },
          available_minutes: { type: 'number', description: 'Minutos totales disponibles para la sesión (15-720)' },
          save: { type: 'boolean', description: 'true = guardar la versión adaptada. Default: false (vista previa)' },
          restore_original: { type: 'boolean', description: 'true = volver a la versión original (ignora el resto)' },
        },
        required: ['id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'replan_week',
      description: `Replanifica la semana actual (lunes a domingo) cuando se han saltado entrenos.
        Las sesiones de calidad saltadas se mueven al primer día que no junte dos días duros (sustituyendo un rodaje
        suave o a un día libre disponible), como mucho 1-2 por semana; los rodajes de resistencia saltados se recuperan
        en parte alargando otro rodaje; lo suave no se recupera. No toca días de descanso, taper ni carreras, y en semanas
        de descarga, taper o recuperación no recupera nada. Primero enlaza la semana con Wahoo.
        Sin save devuelve una vista previa; con save: true aplica los cambios.`,
      parameters: {
        type: 'object',
        properties: {
          save: { type: 'boolean', description: 'true = aplicar los cambios. Default: false (vista previa)' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_form_projection',
      description: `Proyecta CTL (forma), ATL (fatiga) y TSB (frescura) desde hoy hasta la carrera objetivo:
        carga real de Wahoo hasta hoy, después el plan guardado y, más allá del plan, una estimación con el TSS semanal
        reciente y el % de carga de cada semana del plan de temporada. Devuelve la evolución por semanas, con qué CTL y
        TSB se llega a cada carrera A y B (con valoración frente a la frescura recomendada), el pico de CTL, el TSB
        mínimo y avisos (subida de carga demasiado rápida, fatiga excesiva, llegar cansado o demasiado fresco).
        Úsalo cuando pregunte cómo llegará a una carrera, al revisar un plan o un taper, o tras replanificar.`,
      parameters: {
        type: 'object',
        properties: {
          to: { type: 'string', description: 'Último día AAAA-MM-DD. Default: una semana después de la próxima carrera A (o el final del plan)' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_race_events',
      description: `Obtiene las carreras y eventos del ciclista (próximos, y la que esté en curso), con su id,
        fecha, prioridad A/B/C, tipo, distancia, desnivel y días que faltan.
        Úsalo cuando hable de sus carreras u objetivos, o antes de modificar o borrar una (necesitas su id).`,
      parameters: {
        type: 'object',
        properties: {
          include_past: { type: 'boolean', description: 'Incluir también las del último año (ya corridas). Default: false' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'save_race_event',
      description: `Guarda una o varias carreras o eventos en el calendario del ciclista.
        Úsalo en cuanto el ciclista te diga una prueba con su fecha. Si no ha dicho la prioridad, pregúntasela
        (A = objetivo principal, B = importante, C = de entreno) antes de guardar.
        Antes, consulta get_race_events para no duplicar una que ya exista.`,
      parameters: {
        type: 'object',
        properties: {
          events: {
            type: 'array',
            minItems: 1,
            maxItems: 30,
            items: { type: 'object', properties: raceProperties, required: ['name', 'date', 'priority'] },
          },
        },
        required: ['events'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_race_event',
      description: `Modifica una carrera por su id (obtenlo con get_race_events): cambio de fecha, de prioridad,
        datos del recorrido, o el resultado una vez corrida. Envía solo los campos que cambian.`,
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'id de la carrera' },
          ...raceProperties,
          result: { type: 'string', description: 'Resultado y sensaciones, una vez corrida' },
        },
        required: ['id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete_race_event',
      description: 'Borra una carrera por su id. Solo si el ciclista lo pide (p.ej. ya no la va a correr).',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'id de la carrera' },
        },
        required: ['id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_season_plan',
      description: `Obtiene la periodización de la temporada calculada a partir de las carreras:
        fase actual y fases hacia cada carrera A (base, construcción, pico, taper, carrera, recuperación) con fechas,
        pautas de cada fase, semana a semana el tipo (carga, descarga, taper...) y el % de carga orientativo,
        el mini-taper y la recuperación de las carreras B, cómo tratar las C y avisos de conflictos.
        Úsalo antes de planificar semanas (para saber qué toca en cada una), al hablar de cómo llegar a una carrera,
        y después de guardar o cambiar carreras.`,
      parameters: {
        type: 'object',
        properties: {},
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'save_daily_checkin',
      description: `Guarda el check-in diario del ciclista: cansancio, sueño, sensaciones, dolor muscular y FC al despertar.
        Úsalo en cuanto el ciclista te cuente cómo ha dormido o cómo se encuentra (p.ej. "he dormido 5 horas y voy reventado").
        Traduce lo que diga a las escalas de 1 a 5 sin exagerar; envía solo lo que haya dicho. Un check-in por día:
        volver a llamarlo ese día añade o corrige datos. Devuelve la disponibilidad para entrenar (buena, normal,
        precaución, descanso recomendado) con sus motivos.`,
      parameters: {
        type: 'object',
        properties: {
          date: { type: 'string', description: 'Día AAAA-MM-DD. Default: hoy' },
          fatigue: scale('Cansancio: 1 fresco, 3 normal, 5 agotado'),
          sleep_hours: { type: 'number', description: 'Horas dormidas (admite decimales)' },
          sleep_quality: scale('Calidad del sueño: 1 muy mala, 5 muy buena'),
          feeling: scale('Sensaciones y ánimo: 1 muy malas, 5 muy buenas'),
          soreness: scale('Dolor muscular: 1 nada, 5 mucho'),
          morning_hr: { type: 'number', description: 'FC al despertar, en reposo (ppm)' },
          notes: { type: 'string', description: 'Notas breves (enfermedad, estrés, viaje...)' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_checkins',
      description: `Obtiene los check-ins diarios de los últimos días (cansancio, sueño, sensaciones, dolor, FC al despertar),
        con la disponibilidad de cada día y las medias. Úsalo antes de planificar o adaptar la semana, cuando hable de fatiga
        o de cómo se encuentra, y al valorar si conviene descargar.`,
      parameters: {
        type: 'object',
        properties: {
          days: { type: 'number', description: 'Días hacia atrás desde hoy. Default: 7' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_fitness_tests',
      description: `Obtiene el historial de tests (FTP, FC máxima, FC en reposo), los tests ya programados, si toca hacer
        un test de FTP (cada 6-8 semanas) o de FC, con una fecha sugerida (final de la próxima semana de descarga),
        y la descripción de cada protocolo. Úsalo antes de programar un test y cuando hable de su FTP o de sus zonas.`,
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'schedule_fitness_test',
      description: `Programa un test en el plan como sesión estructurada (calentamiento, activaciones, test y vuelta a la calma).
        Protocolos: ftp_20min (FTP = 95 % de 20 min), ftp_8min (90 % de la media de 2 × 8 min), ramp (75 % del mejor minuto;
        necesita rodillo con potencia) y max_hr (FC máxima). Los de FTP necesitan potenciómetro: en la bici estática solo con
        pulsómetro, usa max_hr. Ponlo descansado (al final de una semana de descarga) y como única sesión del día.
        Pide antes la conformidad del ciclista con el día.`,
      parameters: {
        type: 'object',
        properties: {
          protocol: { type: 'string', enum: TEST_PROTOCOLS.filter(p => p !== 'resting_hr'), description: 'Protocolo del test' },
          date: { type: 'string', description: 'Fecha AAAA-MM-DD' },
          environment: { type: 'string', enum: ENVIRONMENTS, description: 'Dónde lo hará. Default: outdoor para FTP de 20 y 8 min, indoor para rampa y FC' },
        },
        required: ['protocol', 'date'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'record_fitness_test',
      description: `Registra el resultado de un test y actualiza el perfil: el FTP (y con él las zonas de potencia y el TSS
        previsto) o la FC máxima / en reposo (zonas de FC y hrTSS). Calcula el valor según el protocolo: no lo calcules tú.
        Sin save devuelve una vista previa con el valor nuevo frente al anterior y las zonas; con save: true lo guarda
        y marca como hecho el test del plan de ese día.
        resting_hr sin value usa la media de la FC al despertar de los check-ins de la última semana.`,
      parameters: {
        type: 'object',
        properties: {
          protocol: { type: 'string', enum: TEST_PROTOCOLS, description: 'Protocolo (si va enlazado a un test del plan, se toma de él)' },
          value: { type: 'number', description: 'Dato medido: potencia media del esfuerzo del test (W) o FC (ppm), según el protocolo' },
          date: { type: 'string', description: 'Día del test AAAA-MM-DD. Default: hoy (o el del test del plan)' },
          planned_workout_id: { type: 'string', description: 'id del test en el plan (opcional; si no, se busca el de ese día)' },
          notes: { type: 'string', description: 'Condiciones del test (calor, cansancio, recorrido...)' },
          save: { type: 'boolean', description: 'true = guardar y actualizar el perfil. Default: false (vista previa)' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_weekly_summary',
      description: `Resumen de una semana (lunes a domingo): planificado frente a hecho (sesiones, horas, TSS y cumplimiento),
        sesiones clave y su estado, lo hecho fuera del plan, las medias de los check-ins, cómo cambian CTL/ATL/TSB,
        el tipo de semana del plan de temporada y una recomendación para la semana siguiente (subir, mantener, bajar o
        descargar) con un TSS orientativo frente al ya planificado. Primero enlaza la semana con Wahoo.
        Úsalo cuando pregunte qué tal la semana, al cerrar una semana o antes de planificar la siguiente.`,
      parameters: {
        type: 'object',
        properties: {
          week: { type: 'string', description: 'Cualquier día de la semana, AAAA-MM-DD. Default: la semana actual (el lunes, usa la anterior)' },
        },
      },
    },
  },
]
