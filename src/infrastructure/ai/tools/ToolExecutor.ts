import { WahooNotConnectedError } from '../../../infrastructure/wahoo/WahooOAuthService'
import { CyclistProfileRepository } from '../../../domain/profile/CyclistProfileRepository'
import { CyclistProfileFields, ProfileValidationError } from '../../../domain/profile/CyclistProfile'
import { WahooWorkout } from '../../../domain/wahoo/WahooWorkout'
import { WorkoutRepository } from '../../../domain/wahoo/WorkoutRepository'
import { SyncWahooWorkouts } from '../../../application/wahoo/SyncWahooWorkouts'
import { UpdateProfile } from '../../../application/profile/UpdateProfile'
import { classifyPower, classifyHeartRate, intensityFactor, workoutTss } from '../../../domain/training/trainingMetrics'
import { Fitness, interpretTsb, stepFitness } from '../../../domain/training/fitness'
import { dayKey, addDays, mondayKey, formatDayKey, formatDate } from '../../../domain/training/calendar'
import { PlanValidationError, PlannedWorkoutNotFoundError } from '../../../domain/planning/PlannedWorkout'
import { PlanningTools, PLANNING_TOOLS, TSS_SOURCE_LABELS } from './PlanningTools'
import { SeasonTools, SEASON_TOOLS } from './SeasonTools'
import { RaceValidationError, RaceEventNotFoundError } from '../../../domain/events/RaceEvent'

interface WeekBucket {
  weekStart: string
  weekEnd: string
  sessions: number
  tss: number
  hours: number
  npAvg: number | null
}

interface SeasonKpis {
  ctl: number
  atl: number
  tsb: number
  totalHours: number
  totalTss: number
  peakCtl: number
  peakCtlDate: string | null
  workoutsCount: number
}

// CTL/ATL need history before the period being reported, otherwise they start at 0
const CTL_WARMUP_DAYS = 90

// update_profile argument (snake_case, as the model sees it) → profile field
const PROFILE_ARG_MAP: Record<string, keyof CyclistProfileFields> = {
  ftp: 'ftp',
  weight_kg: 'weightKg',
  hours_per_week: 'hoursPerWeek',
  goal: 'goal',
  experience: 'experience',
  max_hr: 'maxHr',
  resting_hr: 'restingHr',
  available_days: 'availableDays',
  limitations: 'limitations',
}

export class ToolExecutor {
  constructor(
    private readonly syncWorkouts: SyncWahooWorkouts,
    private readonly workoutRepository: WorkoutRepository,
    private readonly profileRepository: CyclistProfileRepository,
    private readonly updateProfileUseCase: UpdateProfile,
    private readonly planningTools: PlanningTools,
    private readonly seasonTools: SeasonTools
  ) {}

  // Never throws: errors are returned to the model as a tool result so the coach can answer normally
  async execute(userId: string, toolName: string, args: Record<string, unknown>): Promise<string> {
    try {
      switch (toolName) {
        case 'get_recent_workouts':
          return await this.getRecentWorkouts(userId, args)
        case 'get_block_summary':
          return await this.getBlockSummary(userId, args)
        case 'get_season_kpis':
          return await this.getSeasonKpis(userId)
        case 'update_profile':
          return await this.updateProfile(userId, args)
        case 'get_training_plan':
        case 'save_planned_workout':
        case 'update_planned_workout':
        case 'delete_planned_workout':
        case 'adapt_planned_workout':
        case 'replan_week':
        case 'get_form_projection':
          return await this.planningTools.execute(userId, toolName, args)
        case 'get_race_events':
        case 'save_race_event':
        case 'update_race_event':
        case 'delete_race_event':
        case 'get_season_plan':
          return await this.seasonTools.execute(userId, toolName, args)
        default:
          return JSON.stringify({ error: `Tool desconocida: ${toolName}` })
      }
    } catch (err) {
      if (err instanceof ProfileValidationError) {
        return JSON.stringify({ error: 'dato_no_valido', mensaje: `${err.message}. No se ha guardado nada; confirma el dato con el ciclista.` })
      }
      if (err instanceof PlanValidationError) {
        return JSON.stringify({ error: 'dato_no_valido', mensaje: `${err.message}. No se ha guardado nada; corrige el dato y vuelve a intentarlo.` })
      }
      if (err instanceof RaceValidationError) {
        return JSON.stringify({ error: 'dato_no_valido', mensaje: `${err.message}. No se ha guardado nada; corrige el dato y vuelve a intentarlo.` })
      }
      if (err instanceof RaceEventNotFoundError) {
        return JSON.stringify({ error: 'no_encontrado', mensaje: 'No existe una carrera con ese id. Consulta las carreras con get_race_events.' })
      }
      if (err instanceof PlannedWorkoutNotFoundError) {
        return JSON.stringify({ error: 'no_encontrado', mensaje: 'No existe un entreno planificado con ese id. Consulta el plan con get_training_plan.' })
      }
      if (err instanceof WahooNotConnectedError) {
        return JSON.stringify({
          error: 'wahoo_no_conectado',
          mensaje: 'El usuario no ha conectado su cuenta de Wahoo. Sugiérele conectarla para analizar sus entrenos reales.',
        })
      }
      console.error(`Tool ${toolName} failed:`, err)
      if (toolName === 'update_profile') {
        return JSON.stringify({ error: 'error_guardando', mensaje: 'No se ha podido guardar el perfil. Inténtalo más tarde.' })
      }
      if (SEASON_TOOLS.includes(toolName)) {
        return JSON.stringify({ error: 'carreras_no_disponible', mensaje: 'No se ha podido acceder a las carreras en este momento. Inténtalo más tarde.' })
      }
      if (PLANNING_TOOLS.includes(toolName)) {
        return JSON.stringify({ error: 'plan_no_disponible', mensaje: 'No se ha podido acceder al plan de entrenamiento en este momento. Inténtalo más tarde.' })
      }
      return JSON.stringify({
        error: 'wahoo_no_disponible',
        mensaje: 'No se han podido obtener los datos de Wahoo en este momento. Inténtalo más tarde.',
      })
    }
  }

  // ─── get_recent_workouts ──────────────────────────────────────────────────

  private async getRecentWorkouts(userId: string, args: Record<string, unknown>): Promise<string> {
    const days = positiveInt(args.days, 7)
    const limit = positiveInt(args.limit, 5)

    // days=1 → solo hoy (día local del ciclista)
    const cutoffKey = addDays(dayKey(new Date()), -(days - 1))

    const [workouts, profile] = await Promise.all([
      this.loadWorkouts(userId, keyToDate(addDays(cutoffKey, -1))),
      this.profileRepository.findByUserId(userId),
    ])
    const ftp = profile?.ftp ?? null

    const filtered = workouts
      .filter(w => dayKey(new Date(w.startedAt)) >= cutoffKey)
      .slice(0, limit)

    if (filtered.length === 0) {
      return JSON.stringify({ message: `No hay entrenamientos en los últimos ${days} días.` })
    }

    const result = filtered.map(w => {
      const s = w.summary
      const entry: Record<string, unknown> = {
        id: w.id,
        nombre: w.name,
        fecha: formatDate(new Date(w.startedAt), { weekday: 'long', day: 'numeric', month: 'long' }),
        tipo: w.workoutTypeName,
        ubicacion: w.location,
        duracion_min: w.durationMinutes,
      }

      if (s) {
        if (s.durationActiveSeconds) entry.tiempo_movimiento_min = Math.round(s.durationActiveSeconds / 60)
        if (s.powerAvg)         entry.potencia_media_w = s.powerAvg
        if (s.normalizedPower)  entry.np_w = s.normalizedPower
        if (s.heartRateAvg)     entry.fc_media_ppm = s.heartRateAvg
        if (s.cadenceAvg)       entry.cadencia_media_rpm = s.cadenceAvg
        if (s.speedAvgKmh)      entry.velocidad_media_kmh = s.speedAvgKmh
        if (s.distanceInMeters) entry.distancia_km = +(s.distanceInMeters / 1000).toFixed(1)
        if (s.ascentInMeters)   entry.desnivel_m = Math.round(s.ascentInMeters)
        if (s.workKj)           entry.trabajo_kj = s.workKj
        if (s.calories)         entry.calorias = Math.round(s.calories)

        const load = workoutTss(w, profile)
        if (load.tss && load.source) {
          entry.tss = load.tss
          entry.tss_origen = TSS_SOURCE_LABELS[load.source]
          if (load.estimated) entry.tss_estimado = true
        }

        const iF = intensityFactor(s.normalizedPower, ftp)
        if (iF) entry.if = iF

        if (s.normalizedPower && ftp) {
          entry.zona_predominante = classifyPower(s.normalizedPower, ftp)
        }
        if (s.heartRateAvg && profile?.maxHr && profile.restingHr) {
          const hrZone = classifyHeartRate(s.heartRateAvg, profile.maxHr, profile.restingHr)
          if (hrZone) entry.zona_fc_media = hrZone
        }
      }

      return entry
    })

    return JSON.stringify({ entrenamientos: result, total: result.length })
  }

  // ─── get_block_summary ────────────────────────────────────────────────────

  private async getBlockSummary(userId: string, args: Record<string, unknown>): Promise<string> {
    const weeks = positiveInt(args.weeks, 6)

    const firstMonday = addDays(mondayKey(dayKey(new Date())), -(weeks - 1) * 7)

    const [workouts, profile] = await Promise.all([
      this.loadWorkouts(userId, keyToDate(addDays(firstMonday, -1))),
      this.profileRepository.findByUserId(userId),
    ])
    const ftp = profile?.ftp ?? null

    // Group by week (Monday-Sunday), including weeks without sessions
    const buckets = new Map<string, WahooWorkout[]>()
    for (let i = 0; i < weeks; i++) buckets.set(addDays(firstMonday, i * 7), [])

    workouts.forEach(w => {
      const key = mondayKey(dayKey(new Date(w.startedAt)))
      buckets.get(key)?.push(w)
    })

    let estimatedCount = 0
    let hrTssCount = 0

    const summary: WeekBucket[] = Array.from(buckets.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([monday, ws]) => {
        const tss = ws.reduce((acc, w) => {
          const t = workoutTss(w, profile)
          if (t.estimated) estimatedCount++
          if (t.source === 'hr') hrTssCount++
          return acc + (t.tss ?? 0)
        }, 0)
        const hours = ws.reduce((acc, w) => acc + w.durationMinutes / 60, 0)
        const nps = ws.filter(w => w.summary?.normalizedPower).map(w => w.summary!.normalizedPower!)
        const npAvg = nps.length > 0 ? Math.round(nps.reduce((a, b) => a + b, 0) / nps.length) : null

        return {
          weekStart: formatDayKey(monday, { day: 'numeric', month: 'short' }),
          weekEnd: formatDayKey(addDays(monday, 6), { day: 'numeric', month: 'short' }),
          sessions: ws.length,
          tss: Math.round(tss),
          hours: +hours.toFixed(1),
          npAvg,
        }
      })

    const totalTss = summary.reduce((acc, w) => acc + w.tss, 0)
    const totalHours = summary.reduce((acc, w) => acc + w.hours, 0)
    const avgTssPerWeek = summary.length > 0 ? Math.round(totalTss / summary.length) : 0

    return JSON.stringify({
      semanas: summary,
      resumen: {
        semanas_analizadas: summary.length,
        tss_total: Math.round(totalTss),
        horas_totales: +totalHours.toFixed(1),
        tss_medio_semanal: avgTssPerWeek,
        entrenos_con_tss_estimado: estimatedCount,
        entrenos_con_hrtss: hrTssCount,
      },
    })
  }

  // ─── get_season_kpis ──────────────────────────────────────────────────────

  private async getSeasonKpis(userId: string): Promise<string> {
    const todayKey = dayKey(new Date())
    const seasonStartKey = `${todayKey.slice(0, 4)}-01-01`
    const warmupStartKey = addDays(seasonStartKey, -CTL_WARMUP_DAYS)

    const [workouts, profile] = await Promise.all([
      this.loadWorkouts(userId, keyToDate(addDays(warmupStartKey, -1))),
      this.profileRepository.findByUserId(userId),
    ])
    const ftp = profile?.ftp ?? null

    // Daily TSS map (local day)
    const dailyTss = new Map<string, number>()
    let workoutsWithoutTss = 0
    let workoutsWithEstimatedTss = 0
    let workoutsWithHrTss = 0
    const seasonWorkouts: WahooWorkout[] = []

    workouts.forEach(w => {
      const key = dayKey(new Date(w.startedAt))
      if (key < warmupStartKey) return
      const { tss, estimated, source } = workoutTss(w, profile)
      dailyTss.set(key, (dailyTss.get(key) ?? 0) + (tss ?? 0))
      if (key >= seasonStartKey) {
        seasonWorkouts.push(w)
        if (tss === null) workoutsWithoutTss++
        if (estimated) workoutsWithEstimatedTss++
        if (source === 'hr') workoutsWithHrTss++
      }
    })

    let fitness: Fitness = { ctl: 0, atl: 0 }
    let peakCtl = 0
    let peakCtlKey: string | null = null
    let totalTss = 0

    // Iterate day by day from warm-up start to today; peak and totals only count the season
    for (let key = warmupStartKey; key <= todayKey; key = addDays(key, 1)) {
      const tss = dailyTss.get(key) ?? 0

      fitness = stepFitness(fitness, tss)

      if (key >= seasonStartKey) {
        totalTss += tss
        if (fitness.ctl > peakCtl) {
          peakCtl = fitness.ctl
          peakCtlKey = key
        }
      }
    }

    const { ctl, atl } = fitness
    const tsb = ctl - atl
    const totalHours = seasonWorkouts.reduce((acc, w) => acc + w.durationMinutes / 60, 0)

    const kpis: SeasonKpis = {
      ctl: Math.round(ctl),
      atl: Math.round(atl),
      tsb: Math.round(tsb),
      totalHours: +totalHours.toFixed(1),
      totalTss: Math.round(totalTss),
      peakCtl: Math.round(peakCtl),
      peakCtlDate: peakCtlKey ? formatDayKey(peakCtlKey, { day: 'numeric', month: 'long' }) : null,
      workoutsCount: seasonWorkouts.length,
    }

    return JSON.stringify({
      kpis,
      interpretacion_tsb: interpretTsb(tsb),
      calidad_datos: {
        entrenos_sin_tss: workoutsWithoutTss,
        entrenos_con_tss_estimado: workoutsWithEstimatedTss,
        entrenos_con_hrtss: workoutsWithHrTss,
        nota: workoutsWithoutTss > 0
          ? 'Algunos entrenos no tienen carga: sin potencia ni FTP, y sin FC media o sin FC máxima y en reposo en el perfil. CTL/ATL pueden estar infravalorados.'
          : undefined,
      },
    })
  }

  // ─── update_profile ───────────────────────────────────────────────────────

  private async updateProfile(userId: string, args: Record<string, unknown>): Promise<string> {
    const patch: Record<string, unknown> = {}
    for (const [arg, field] of Object.entries(PROFILE_ARG_MAP)) {
      if (args[arg] !== undefined) patch[field] = args[arg]
    }

    if (Object.keys(patch).length === 0) {
      return JSON.stringify({ error: 'sin_datos', mensaje: 'No se ha indicado ningún dato que guardar.' })
    }

    const profile = await this.updateProfileUseCase.execute({ userId, ...(patch as Partial<CyclistProfileFields>) })

    return JSON.stringify({
      guardado: true,
      campos_actualizados: Object.keys(args).filter(a => a in PROFILE_ARG_MAP && args[a] !== undefined),
      perfil: {
        ftp_w: profile.ftp,
        peso_kg: profile.weightKg,
        w_kg: profile.wattsPerKg,
        horas_semana: profile.hoursPerWeek,
        nivel: profile.experience,
        objetivo: profile.goal,
        fc_max: profile.maxHr,
        fc_reposo: profile.restingHr,
        dias_disponibles: profile.availableDays,
        limitaciones: profile.limitations,
      },
    })
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────

  // Syncs with Wahoo (throttled, incremental) and reads from the local copy
  private async loadWorkouts(userId: string, since: Date): Promise<WahooWorkout[]> {
    await this.syncWorkouts.execute(userId)
    return this.workoutRepository.findSince(userId, since)
  }

}

function positiveInt(value: unknown, fallback: number): number {
  const n = Math.floor(Number(value))
  return Number.isFinite(n) && n > 0 ? n : fallback
}

// Start of a local day key, as an instant (approximate to UTC; callers subtract a margin day)
function keyToDate(key: string): Date {
  return new Date(`${key}T00:00:00Z`)
}
