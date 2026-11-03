import { AgentTool } from '../../../domain/chat/AgentTool'

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
]
