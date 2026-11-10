import { SaveDailyCheckIn } from '../../../application/wellness/SaveDailyCheckIn'
import { GetDailyCheckIns, CheckInWithReadiness } from '../../../application/wellness/GetDailyCheckIns'
import { GetFitnessTests } from '../../../application/testing/GetFitnessTests'
import { ScheduleFitnessTest } from '../../../application/testing/ScheduleFitnessTest'
import { RecordFitnessTest } from '../../../application/testing/RecordFitnessTest'
import { GetWeeklySummary } from '../../../application/planning/GetWeeklySummary'
import { READINESS_GUIDE, ReadinessLevel } from '../../../domain/wellness/DailyCheckIn'
import { FIELD_LABELS, PROTOCOLS } from '../../../domain/testing/fitnessTest'
import { RecommendationLevel } from '../../../domain/planning/weeklySummary'
import { addDays, dayKey, formatDayKey } from '../../../domain/training/calendar'

export const PROGRESS_TOOLS = [
  'save_daily_checkin', 'get_checkins', 'get_fitness_tests', 'schedule_fitness_test', 'record_fitness_test', 'get_weekly_summary',
]

export const READINESS_LABELS: Record<ReadinessLevel, string> = {
  good: 'buena', normal: 'normal', caution: 'precaución', rest: 'descanso recomendado',
}

const RECOMMENDATION_LABELS: Record<RecommendationLevel, string> = {
  progress: 'subir carga', maintain: 'mantener', reduce: 'bajar un poco', recover: 'descarga',
}

const STATUS_LABELS = { planned: 'pendiente', done: 'hecho', partial: 'parcial', skipped: 'saltado' }

// Check-in diario, tests de FTP / FC y resumen semanal. Argumentos en snake_case (como los ve el modelo).
export class ProgressTools {
  constructor(
    private readonly saveCheckIn: SaveDailyCheckIn,
    private readonly getCheckIns: GetDailyCheckIns,
    private readonly getTests: GetFitnessTests,
    private readonly scheduleTest: ScheduleFitnessTest,
    private readonly recordTest: RecordFitnessTest,
    private readonly weeklySummary: GetWeeklySummary
  ) {}

  async execute(userId: string, toolName: string, args: Record<string, unknown>): Promise<string> {
    switch (toolName) {
      case 'save_daily_checkin': return this.saveDailyCheckIn(userId, args)
      case 'get_checkins': return this.listCheckIns(userId, args)
      case 'get_fitness_tests': return this.tests(userId)
      case 'schedule_fitness_test': return this.schedule(userId, args)
      case 'record_fitness_test': return this.record(userId, args)
      case 'get_weekly_summary': return this.summary(userId, args)
      default: throw new Error(`Tool desconocida: ${toolName}`)
    }
  }

  private async saveDailyCheckIn(userId: string, args: Record<string, unknown>): Promise<string> {
    const input = {
      fatigue: args.fatigue,
      sleepHours: args.sleep_hours,
      sleepQuality: args.sleep_quality,
      feeling: args.feeling,
      soreness: args.soreness,
      morningHr: args.morning_hr,
      notes: args.notes,
    }
    if (Object.values(input).every(v => v === undefined)) {
      return JSON.stringify({ error: 'sin_datos', mensaje: 'No se ha indicado ningún dato del check-in.' })
    }
    const saved = await this.saveCheckIn.execute(userId, optionalString(args.date), input)
    return JSON.stringify({ guardado: true, ...checkInToModel(saved) })
  }

  private async listCheckIns(userId: string, args: Record<string, unknown>): Promise<string> {
    const days = Math.min(Math.max(Math.floor(Number(args.days)) || 7, 1), 60)
    const today = dayKey(new Date())
    const r = await this.getCheckIns.execute(userId, addDays(today, -(days - 1)), today)
    if (r.checkIns.length === 0) {
      return JSON.stringify({ mensaje: `No hay check-ins en los últimos ${days} días.` })
    }
    const a = r.averages
    return JSON.stringify({
      check_ins: r.checkIns.map(checkInToModel),
      medias: {
        dias: a.days,
        ...(a.fatigue !== null ? { cansancio: a.fatigue } : {}),
        ...(a.sleepHours !== null ? { horas_sueno: a.sleepHours } : {}),
        ...(a.sleepQuality !== null ? { calidad_sueno: a.sleepQuality } : {}),
        ...(a.feeling !== null ? { sensaciones: a.feeling } : {}),
        ...(a.soreness !== null ? { dolor_muscular: a.soreness } : {}),
        ...(a.morningHr !== null ? { fc_despertar: a.morningHr } : {}),
      },
      escalas: 'cansancio y dolor: 1 nada/fresco a 5 mucho/agotado · sueño y sensaciones: 1 muy mal a 5 muy bien',
    })
  }

  private async tests(userId: string): Promise<string> {
    const o = await this.getTests.execute(userId)
    return JSON.stringify({
      historial: o.tests.slice(0, 10).map(t => ({
        fecha: t.date,
        test: PROTOCOLS[t.protocol].title,
        medido: `${t.measured} ${PROTOCOLS[t.protocol].unit}`,
        resultado: `${FIELD_LABELS[t.field]} ${t.value}${t.field === 'ftp' ? ' W' : ' ppm'}`,
        ...(t.previous !== null ? { antes: t.previous } : {}),
      })),
      programados: o.scheduled.map(w => ({ id: w.id, fecha: w.date, titulo: w.title, protocolo: w.testProtocol })),
      ftp: { toca: o.ftp.due, motivo: o.ftp.reason, ...(o.ftp.suggestedDate ? { fecha_sugerida: o.ftp.suggestedDate } : {}) },
      fc: { toca: o.heartRate.due, motivo: o.heartRate.reason, ...(o.heartRate.suggestedDate ? { fecha_sugerida: o.heartRate.suggestedDate } : {}) },
      protocolos: Object.fromEntries(Object.entries(PROTOCOLS).map(([id, p]) => [id, `${p.title}: ${p.instructions}`])),
    })
  }

  private async schedule(userId: string, args: Record<string, unknown>): Promise<string> {
    const r = await this.scheduleTest.execute(userId, { protocol: args.protocol, date: args.date, environment: args.environment }, 'coach')
    const w = r.workout
    return JSON.stringify({
      guardado: true,
      id: w.id,
      fecha: w.date,
      dia: formatDayKey(w.date, { weekday: 'long', day: 'numeric', month: 'long' }),
      titulo: w.title,
      entorno: w.environment,
      duracion_min: w.durationMinutes,
      tss_previsto: w.plannedTss,
      instrucciones: w.description,
      ...(r.warnings.length ? { avisos: r.warnings } : {}),
    })
  }

  private async record(userId: string, args: Record<string, unknown>): Promise<string> {
    const r = await this.recordTest.execute(
      userId,
      { protocol: args.protocol, value: args.value, date: args.date, plannedWorkoutId: args.planned_workout_id, notes: args.notes },
      args.save === true
    )
    const o = r.outcome
    const unit = o.field === 'ftp' ? 'W' : 'ppm'
    const zones = (z: typeof r.zonesAfter) => z?.map(x => `${x.zone} ${x.min}${x.max !== null ? `-${x.max}` : '+'}`).join(' · ') ?? null
    return JSON.stringify({
      guardado: r.saved,
      ...(r.saved
        ? { nota: 'Perfil actualizado: las zonas y el TSS previsto de los entrenos se recalculan con el nuevo valor.' }
        : { nota: 'Vista previa: no se ha guardado. Preséntala y, si el ciclista está de acuerdo, llama otra vez con save: true.' }),
      test: PROTOCOLS[o.protocol].title,
      fecha: r.date,
      medido: `${o.measured} ${PROTOCOLS[o.protocol].unit}`,
      [FIELD_LABELS[o.field].toLowerCase().replace(/ /g, '_')]: { nuevo: `${o.value} ${unit}`, anterior: o.previous !== null ? `${o.previous} ${unit}` : null, cambio_pct: o.changePercent },
      zonas_antes: zones(r.zonesBefore),
      zonas_despues: zones(r.zonesAfter),
      ...(r.plannedWorkout ? { entreno_del_plan: { id: r.plannedWorkout.id, titulo: r.plannedWorkout.title, estado: r.plannedWorkout.status } } : {}),
      ...(r.note ? { origen_dato: r.note } : {}),
      ...(o.warnings.length ? { avisos: o.warnings } : {}),
    })
  }

  private async summary(userId: string, args: Record<string, unknown>): Promise<string> {
    const s = await this.weeklySummary.execute(userId, optionalString(args.week))
    const day = (d: string) => formatDayKey(d, { weekday: 'short', day: 'numeric' })
    return JSON.stringify({
      semana: `${formatDayKey(s.monday, { day: 'numeric', month: 'long' })} - ${formatDayKey(s.sunday, { day: 'numeric', month: 'long' })}`,
      completa: s.complete,
      planificado: { sesiones: s.planned.sessions, horas: +(s.planned.minutes / 60).toFixed(1), tss: s.planned.tss },
      hecho: {
        sesiones: s.done.sessions,
        horas: +(s.done.minutes / 60).toFixed(1),
        tss: s.done.tss,
        ...(s.done.estimatedTss ? { tss_previsto_de_marcados_a_mano: s.done.estimatedTss } : {}),
        fuera_del_plan: s.done.unplanned.map(a => ({ dia: day(a.date), nombre: a.name, min: a.minutes, tss: a.tss })),
      },
      estados: { hechos: s.statuses.done, parciales: s.statuses.partial, saltados: s.statuses.skipped, pendientes: s.statuses.planned },
      cumplimiento_sesiones_pct: s.compliance.sessionsPercent,
      cumplimiento_tss_pct: s.compliance.tssPercent,
      sesiones_clave: s.keySessions.map(k => ({ dia: day(k.date), titulo: k.title, estado: STATUS_LABELS[k.status] })),
      ...(s.complete ? {} : { queda: { sesiones: s.remaining.sessions, tss: s.remaining.tss } }),
      check_ins: s.wellness.days
        ? {
          dias: s.wellness.days,
          cansancio_medio: s.wellness.fatigue,
          horas_sueno_media: s.wellness.sleepHours,
          sensaciones_media: s.wellness.feeling,
          dias_precaucion: s.wellness.levels.filter(l => l === 'caution').length,
          dias_descanso_recomendado: s.wellness.levels.filter(l => l === 'rest').length,
        }
        : null,
      forma: {
        inicio: round(s.fitness.start),
        final: round(s.fitness.end),
        cambio_ctl: s.fitness.ctlChange,
      },
      ...(s.season ? { tipo_semana: `${s.season.type} (${s.season.loadPercent} %)` } : {}),
      ...(s.nextSeason ? { semana_siguiente_plan_temporada: `${s.nextSeason.type} (${s.nextSeason.loadPercent} %)` } : {}),
      semana_siguiente_planificada: {
        sesiones: s.nextWeek.sessions,
        tss: s.nextWeek.tss,
        ...(s.nextWeek.targetTss ? { tss_orientativo: `${s.nextWeek.targetTss[0]}-${s.nextWeek.targetTss[1]}` } : {}),
      },
      recomendacion: {
        nivel: RECOMMENDATION_LABELS[s.recommendation.level],
        titular: s.recommendation.headline,
        puntos: s.recommendation.points,
      },
    })
  }
}

export function checkInToModel({ checkIn: c, readiness: r }: CheckInWithReadiness): Record<string, unknown> {
  return {
    fecha: c.date,
    ...(c.fatigue !== null ? { cansancio: c.fatigue } : {}),
    ...(c.sleepHours !== null ? { horas_sueno: c.sleepHours } : {}),
    ...(c.sleepQuality !== null ? { calidad_sueno: c.sleepQuality } : {}),
    ...(c.feeling !== null ? { sensaciones: c.feeling } : {}),
    ...(c.soreness !== null ? { dolor_muscular: c.soreness } : {}),
    ...(c.morningHr !== null ? { fc_despertar: c.morningHr } : {}),
    ...(c.notes ? { notas: c.notes } : {}),
    disponibilidad: READINESS_LABELS[r.level],
    ...(r.reasons.length ? { motivos: r.reasons } : {}),
    pauta: READINESS_GUIDE[r.level],
  }
}

const round = (f: { ctl: number; atl: number; tsb: number }) => ({ ctl: Math.round(f.ctl), atl: Math.round(f.atl), tsb: Math.round(f.tsb) })

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

