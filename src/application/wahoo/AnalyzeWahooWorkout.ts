import { WahooOAuthService } from '../../infrastructure/wahoo/WahooOAuthService'
import { CyclistProfileRepository } from '../../domain/profile/CyclistProfileRepository'
import { WahooWorkout } from '../../domain/wahoo/WahooWorkout'
import { CyclistProfile } from '../../domain/profile/CyclistProfile'
import { classifyPower, classifyHeartRate, intensityFactor, workoutTss, TssSource } from '../../domain/training/trainingMetrics'
import { formatDate } from '../../domain/training/calendar'

const TSS_SOURCE_NOTES: Record<TssSource, string> = {
  power: '',
  power_estimated: ' (estimado con NP y FTP)',
  hr: ' (hrTSS estimado con la FC media)',
}

interface AnalyzeWorkoutInput {
  userId: string
  workoutId: number
}

interface AnalyzeWorkoutOutput {
  workout: WahooWorkout
  analysisContext: string   // texto listo para inyectar en el prompt del asistente
}

export class AnalyzeWahooWorkout {
  constructor(
    private readonly wahooService: WahooOAuthService,
    private readonly profileRepository: CyclistProfileRepository
  ) {}

  async execute({ userId, workoutId }: AnalyzeWorkoutInput): Promise<AnalyzeWorkoutOutput> {
    const [workout, profile] = await Promise.all([
      this.wahooService.getWorkout(userId, workoutId),
      this.profileRepository.findByUserId(userId),
    ])

    const analysisContext = this.buildAnalysisContext(workout, profile)
    return { workout, analysisContext }
  }

  private buildAnalysisContext(workout: WahooWorkout, profile: CyclistProfile | null): string {
    const s = workout.summary
    const ftp = profile?.ftp ?? null
    const date = formatDate(new Date(workout.startedAt), {
      weekday: 'long', day: 'numeric', month: 'long',
    })

    const lines: string[] = [
      `ENTRENO A ANALIZAR (datos de Wahoo):`,
      `- Nombre: ${workout.name}`,
      `- Fecha: ${date}`,
      `- Tipo: ${workout.workoutTypeName} (${workout.location})`,
      `- Duración: ${workout.durationMinutes} min`,
    ]

    if (s) {
      if (s.durationActiveSeconds) lines.push(`- Tiempo en movimiento: ${Math.round(s.durationActiveSeconds / 60)} min`)
      if (s.distanceInMeters)  lines.push(`- Distancia: ${(s.distanceInMeters / 1000).toFixed(1)} km`)
      if (s.ascentInMeters)    lines.push(`- Desnivel positivo: ${Math.round(s.ascentInMeters)} m`)
      if (s.speedAvgKmh)       lines.push(`- Velocidad media: ${s.speedAvgKmh} km/h`)
      if (s.powerAvg)          lines.push(`- Potencia media: ${s.powerAvg}w`)
      if (s.normalizedPower)   lines.push(`- Potencia normalizada (NP): ${s.normalizedPower}w`)
      if (s.heartRateAvg)      lines.push(`- FC media: ${s.heartRateAvg} ppm`)
      if (s.cadenceAvg)        lines.push(`- Cadencia media: ${s.cadenceAvg} rpm`)
      if (s.workKj)            lines.push(`- Trabajo: ${s.workKj} kJ`)
      if (s.calories)          lines.push(`- Calorías: ${Math.round(s.calories)} kcal`)

      const { tss, source } = workoutTss(workout, profile)
      if (tss && source) lines.push(`- TSS: ${tss}${TSS_SOURCE_NOTES[source]}`)

      const iF = intensityFactor(s.normalizedPower, ftp)
      if (iF) lines.push(`- IF: ${iF}`)

      // Classify NP in user's power zones if profile has FTP
      if (s.normalizedPower && ftp) {
        lines.push(`- Zona predominante (por NP): ${classifyPower(s.normalizedPower, ftp)}`)
      }
      if (s.heartRateAvg && profile?.maxHr && profile.restingHr) {
        const hrZone = classifyHeartRate(s.heartRateAvg, profile.maxHr, profile.restingHr)
        if (hrZone) lines.push(`- Zona de la FC media: ${hrZone}`)
      }
    }

    lines.push(`\nAnaliza este entrenamiento en detalle. Ten en cuenta el perfil del ciclista y sus zonas de potencia o de FC. Comenta la distribución de intensidad, la carga (TSS), y da recomendaciones concretas para el próximo entrenamiento.`)

    return lines.join('\n')
  }
}
