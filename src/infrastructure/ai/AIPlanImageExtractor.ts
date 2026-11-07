import { AIPort } from '../../domain/chat/AIPort'
import { ImageInput } from '../../domain/chat/ImageAttachment'
import { ImportParseResult, PlanImageExtractor, MAX_IMPORT_WORKOUTS } from '../../domain/planning/PlanImport'
import { ENVIRONMENTS, STEP_KINDS, TARGET_TYPES, WORKOUT_FOCUSES } from '../../domain/planning/PlannedWorkout'
import { formatDayKey } from '../../domain/training/calendar'
import { LoadProfile } from '../../domain/training/trainingMetrics'
import { toInput } from './tools/PlanningTools'

// Extracción de un plan desde una foto o captura (tabla de un entrenador, PDF, TrainingPeaks...)
// con el modelo de visión. El modelo devuelve el mismo esquema que la tool save_planned_workout;
// se convierte al del dominio y pasa por la misma vista previa y validación que un JSON importado.

const PROMPT = `Eres un asistente que transcribe planes de entrenamiento de ciclismo desde imágenes
(tablas, calendarios, capturas de TrainingPeaks u hojas de un entrenador) a JSON.

Devuelve SOLO un objeto JSON con esta forma:
{
  "workouts": [
    {
      "date": "AAAA-MM-DD",
      "title": "título corto, el de la tabla si lo tiene",
      "focus": uno de ${JSON.stringify(WORKOUT_FOCUSES)},
      "environment": uno de ${JSON.stringify(ENVIRONMENTS)},
      "description": "indicaciones de la tabla para la sesión (opcional)",
      "blocks": [
        {
          "name": "opcional",
          "repeat": 1,
          "steps": [
            {
              "kind": uno de ${JSON.stringify(STEP_KINDS)},
              "duration_min": número (admite decimales: 0.5 = 30 s),
              "target": { "type": uno de ${JSON.stringify(TARGET_TYPES)}, "zone": n, "zone_max": n, "min": n, "max": n },
              "cadence_min": n, "cadence_max": n,
              "notes": "opcional"
            }
          ]
        }
      ],
      "duration_min": número (solo si no hay bloques: fuerza, salida libre),
      "tss": número (solo si la tabla lo indica y no hay bloques)
    }
  ],
  "dudas": ["lo que no se ve bien o es ambiguo, en frases cortas"]
}

Reglas:
- Transcribe con fidelidad lo que hay en la imagen. No inventes sesiones ni rellenes huecos.
- Una fila o celda por sesión. Los días de descanso, con focus "rest" y sin bloques.
- Las series van en un bloque con repeat: "4x8' Z4 r4' Z1" = repeat 4 con dos pasos (work 8 min Z4, recovery 4 min Z1).
  Calentamiento y vuelta a la calma, en bloques aparte con kind warmup / cooldown.
- Objetivos: zonas de FC (pulso, ppm, FC) → hr_zone con "zone" (y "zone_max" para un rango como Z1-Z2);
  zonas de potencia → power_zone; % de FTP → ftp_percent con min / max; vatios → power_w; ppm concretas → hr_bpm; RPE → rpe.
  Si pone solo "Z2" sin decir si es FC o potencia, usa hr_zone para Z1-Z5 y power_zone si aparecen Z6 o Z7, y anótalo una vez en "dudas".
- Fuerza o gimnasio → focus "strength" con duration_min si se indica.
- Fechas: usa las de la imagen. Si solo hay días de la semana o números de semana, usa la indicación del ciclista;
  si no la hay, empieza el lunes siguiente a hoy y dilo en "dudas". No pongas fechas de más de un año atrás.
- environment "indoor" si la tabla dice rodillo, bici estática o indoor; "outdoor" si es en carretera o con terreno concreto; si no, "any".
- Si la imagen no contiene un plan de entrenamiento, devuelve "workouts": [] y explícalo en "dudas".`

export class AIPlanImageExtractor implements PlanImageExtractor {
  constructor(private readonly ai: AIPort) {}

  async extract(
    image: ImageInput,
    context: { today: string; hint: string | null; profile: LoadProfile | null }
  ): Promise<ImportParseResult> {
    const today = formatDayKey(context.today, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
    const lines = [`Hoy es ${today} (${context.today}).`]
    if (context.hint) lines.push(`Indicaciones del ciclista: ${context.hint}`)
    lines.push('Transcribe el plan de la imagen.')

    const result = await this.ai.completeJson(PROMPT, [
      { role: 'user', content: lines.join('\n'), images: [{ mediaType: image.mediaType, data: image.data }] },
    ])

    const r = (result && typeof result === 'object' ? result : {}) as Record<string, unknown>
    const workouts = Array.isArray(r.workouts) ? r.workouts.slice(0, MAX_IMPORT_WORKOUTS) : []
    const doubts = Array.isArray(r.dudas) ? r.dudas.filter((d): d is string => typeof d === 'string' && !!d.trim()) : []
    if (workouts.length === 0 && doubts.length === 0) doubts.push('No se ha encontrado ningún entreno en la imagen.')

    return {
      format: 'image',
      drafts: workouts.map(w => ({
        externalId: null,
        input: toInput(w && typeof w === 'object' ? (w as Record<string, unknown>) : {}),
        warnings: [],
        error: w && typeof w === 'object' ? null : 'Entrada no válida',
      })),
      warnings: doubts.map(d => d.trim()),
    }
  }
}
