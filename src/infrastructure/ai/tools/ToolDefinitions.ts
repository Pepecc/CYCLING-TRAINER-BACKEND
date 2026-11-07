import { AgentTool, AgentToolParameter } from '../../../domain/chat/AgentTool'
import {
  STEP_KINDS, TARGET_TYPES, WORKOUT_FOCUSES, ENVIRONMENTS, PLANNED_STATUSES,
} from '../../../domain/planning/PlannedWorkout'

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
        nivel, objetivo, FC máxima, FC en reposo, días disponibles, eventos objetivo o lesiones.
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
          target_events: { type: 'string', description: 'Eventos o competiciones objetivo con sus fechas, p.ej. "Quebrantahuesos 20/06/2027"' },
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
        Úsalo antes de planificar (para no duplicar sesiones), cuando pregunte qué le toca hoy o esta semana,
        o antes de modificar un entreno (necesitas su id).`,
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
        status para marcarlo como hecho (done), parcial (partial), saltado (skipped) o pendiente (planned).`,
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
]
