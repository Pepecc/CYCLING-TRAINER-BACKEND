import { parseImage } from '../../domain/chat/ImageAttachment'
import { PlanImageExtractor } from '../../domain/planning/PlanImport'
import { CyclistProfileRepository } from '../../domain/profile/CyclistProfileRepository'
import { dayKey } from '../../domain/training/calendar'
import { ImportPreview, PreviewPlanImport } from './PreviewPlanImport'

const HINT_MAX = 500

// Foto o captura de una tabla de entrenos → borradores con el mismo esquema que el JSON → vista previa.
// No guarda nada: el ciclista revisa la vista previa y confirma con ImportPlannedWorkouts.
export class ExtractPlanFromImage {
  constructor(
    private readonly extractor: PlanImageExtractor,
    private readonly preview: PreviewPlanImport,
    private readonly profiles: CyclistProfileRepository
  ) {}

  // hint: aclaraciones del ciclista, p. ej. "la semana 1 empieza el lunes 10 de noviembre".
  // Throws ImageValidationError.
  async execute(userId: string, rawImage: unknown, hint?: unknown): Promise<ImportPreview> {
    const image = parseImage(rawImage)
    const text = typeof hint === 'string' && hint.trim() ? hint.trim().slice(0, HINT_MAX) : null
    const profile = await this.profiles.findByUserId(userId)
    const parsed = await this.extractor.extract(image, { today: dayKey(new Date()), hint: text, profile })
    return this.preview.fromParsed(userId, parsed)
  }
}
