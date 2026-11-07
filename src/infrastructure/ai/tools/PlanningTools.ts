import { PlannedWorkout, PlannedWorkoutInput, PlanValidationError, WorkoutFocus, WorkoutVersion } from '../../../domain/planning/PlannedWorkout'
import { formatStructure } from '../../../domain/planning/formatStructure'
import { AdaptationNotPossibleError } from '../../../domain/planning/adaptWorkout'
import { AdaptPlannedWorkout } from '../../../application/planning/AdaptPlannedWorkout'
import { CyclistProfileRepository } from '../../../domain/profile/CyclistProfileRepository'
import { LoadProfile, TssSource, workoutTss } from '../../../domain/training/trainingMetrics'
import { addDays, dayKey, formatDayKey, mondayKey } from '../../../domain/training/calendar'
import { LoadOrigin, interpretTsb } from '../../../domain/training/fitness'
import { WahooWorkout } from '../../../domain/wahoo/WahooWorkout'
import { ReconcilePlan, ReconcileOutcome } from '../../../application/planning/ReconcilePlan'
import { ReplanWeek } from '../../../application/planning/ReplanWeek'
import { GetFormProjection } from '../../../application/planning/GetFormProjection'
import { SavePlannedWorkouts } from '../../../application/planning/SavePlannedWorkouts'
import { UpdatePlannedWorkout } from '../../../application/planning/UpdatePlannedWorkout'
import { DeletePlannedWorkout } from '../../../application/planning/DeletePlannedWorkout'
import { GetTrainingPlan } from '../../../application/planning/GetTrainingPlan'

const DESCRIPTION_IN_TOOL = 800

export const PLANNING_TOOLS = [
  'get_training_plan', 'save_planned_workout', 'update_planned_workout', 'delete_planned_workout', 'adapt_planned_workout',
  'replan_week', 'get_form_projection',
]

export const TSS_SOURCE_LABELS: Record<TssSource, string> = {
  power: 'potencia (Wahoo)',
  power_estimated: 'estimado con NP y FTP',
  hr: 'hrTSS (FC media)',
}

const LOAD_ORIGIN_LABELS: Record<LoadOrigin, string> = {
  actual: 'real',
  planned: 'plan',
  season: 'estimada (plan de temporada)',
}

const HORIZON_LABELS = {
  request: 'pedido',
  race: 'una semana después de la carrera A',
  plan: 'final del plan',
  default: '4 semanas',
}

const FOCUS_LABELS: Record<WorkoutFocus, string> = {
  recovery: 'recuperación',
  endurance: 'resistencia',
  tempo: 'tempo',
  sweet_spot: 'sweet spot',
  threshold: 'umbral',
  vo2max: 'VO2max',
  anaerobic: 'anaeróbico',
  sprint: 'sprint',
  technique: 'técnica',
  strength: 'fuerza',
  test: 'test',
  race: 'carrera',
  rest: 'descanso',
  other: 'otro',
}

// Tools del plan de entrenamiento. Los argumentos llegan en snake_case (como los ve el modelo).
export class PlanningTools {
  constructor(
    private readonly savePlanned: SavePlannedWorkouts,
    private readonly updatePlanned: UpdatePlannedWorkout,
    private readonly deletePlanned: DeletePlannedWorkout,
    private readonly getPlan: GetTrainingPlan,
    private readonly profiles: CyclistProfileRepository,
    private readonly adaptPlanned: AdaptPlannedWorkout,
    private readonly reconcile: ReconcilePlan,
    private readonly replan: ReplanWeek,
    private readonly formProjection: GetFormProjection
  ) {}

  async execute(userId: string, toolName: string, args: Record<string, unknown>): Promise<string> {
    switch (toolName) {
      case 'get_training_plan':
        return this.getTrainingPlan(userId, args)
      case 'save_planned_workout':
        return this.save(userId, args)
      case 'update_planned_workout':
        return this.update(userId, args)
      case 'delete_planned_workout':
        return this.delete(userId, args)
      case 'adapt_planned_workout':
        return this.adapt(userId, args)
      case 'replan_week':
        return this.replanWeek(userId, args)
      case 'get_form_projection':
        return this.projection(userId, args)
      default:
        throw new Error(`Tool de planificación desconocida: ${toolName}`)
    }
  }

  private async getTrainingPlan(userId: string, args: Record<string, unknown>): Promise<string> {
    let plan = await this.getPlan.execute(userId, optionalString(args.from), optionalString(args.to))   // validates the dates
    // Link the past days with Wahoo first, so the statuses are up to date
    const outcome = await this.safeReconcile(userId, plan.from, plan.to)
    const profile = await this.profiles.findByUserId(userId)
    if (outcome?.changed.length) plan = await this.getPlan.execute(userId, plan.from, plan.to)

    const unplanned = (outcome?.unplanned ?? []).map(a => unplannedToModel(a, profile))
    const linkNote = plan.from <= dayKey(new Date()) && outcome && !outcome.linked
      ? 'Wahoo no conectado o sin entrenos: los estados de los días pasados son los marcados a mano.'
      : undefined
    const range = `${formatDayKey(plan.from, { day: 'numeric', month: 'long' })} - ${formatDayKey(plan.to, { day: 'numeric', month: 'long' })}`

    if (plan.workouts.length === 0) {
      return JSON.stringify({
        desde: plan.from,
        hasta: plan.to,
        message: `No hay entrenos planificados entre ${range}.`,
        ...(unplanned.length ? { entrenos_sin_planificar: unplanned } : {}),
      })
    }

    // Weekly totals (Monday-Sunday) of the planned workouts in range
    interface WeekTotals { sesiones: number; minutos: number; tss: number; tssReal: number; hechos: number; parciales: number; saltados: number }
    const weeks = new Map<string, WeekTotals>()
    for (const w of plan.workouts) {
      const key = mondayKey(w.date)
      const week = weeks.get(key) ?? { sesiones: 0, minutos: 0, tss: 0, tssReal: 0, hechos: 0, parciales: 0, saltados: 0 }
      if (w.focus !== 'rest') week.sesiones++
      week.minutos += w.durationMinutes ?? 0
      week.tss += w.plannedTss ?? 0
      week.tssReal += w.completion?.actualTss ?? 0
      if (w.status === 'done') week.hechos++
      if (w.status === 'partial') week.parciales++
      if (w.status === 'skipped') week.saltados++
      weeks.set(key, week)
    }

    return JSON.stringify({
      desde: plan.from,
      hasta: plan.to,
      entrenos: plan.workouts.map(w => this.toModel(w, profile)),
      semanas: Array.from(weeks.entries()).map(([monday, wk]) => ({
        semana: `${formatDayKey(monday, { day: 'numeric', month: 'short' })} - ${formatDayKey(addDays(monday, 6), { day: 'numeric', month: 'short' })}`,
        sesiones: wk.sesiones,
        horas: +(wk.minutos / 60).toFixed(1),
        tss_previsto: Math.round(wk.tss),
        tss_realizado_en_plan: Math.round(wk.tssReal),
        hechos: wk.hechos,
        parciales: wk.parciales,
        saltados: wk.saltados,
      })),
      ...(unplanned.length ? { entrenos_sin_planificar: unplanned } : {}),
      ...(linkNote ? { nota_estados: linkNote } : {}),
    })
  }

  // The plan must still be readable if Wahoo or the link fails
  private async safeReconcile(userId: string, from: string, to: string): Promise<ReconcileOutcome | null> {
    try {
      return await this.reconcile.execute(userId, from, to)
    } catch (err) {
      console.error('Plan reconciliation failed:', err)
      return null
    }
  }

  private async replanWeek(userId: string, args: Record<string, unknown>): Promise<string> {
    const r = await this.replan.execute(userId, args.save === true)
    const day = (d: string) => formatDayKey(d, { weekday: 'long', day: 'numeric', month: 'long' })
    const actionable = r.changes.some(c => c.kind !== 'drop')
    return JSON.stringify({
      guardado: r.saved && actionable,
      ...(!r.saved && actionable ? { nota: 'Vista previa: no se ha guardado nada. Preséntala y, si el ciclista está de acuerdo, llama otra vez con save: true.' } : {}),
      semana: `${day(r.monday)} - ${day(r.sunday)}`,
      saltados: r.skipped.map(w => ({ id: w.id, dia: day(w.date), titulo: w.title, tipo: FOCUS_LABELS[w.focus], tss_previsto: w.plannedTss })),
      cambios: r.changes.map(c => {
        switch (c.kind) {
          case 'move':
            return {
              accion: 'mover', id: c.workout.id, titulo: c.workout.title, de: day(c.from), a: day(c.to),
              ...(c.replaces ? { sustituye_a: { id: c.replaces.id, titulo: c.replaces.title, se_borra: true } } : {}),
              motivo: c.reason,
            }
          case 'extend':
            return { accion: 'ampliar', id: c.workout.id, titulo: c.workout.title, dia: day(c.workout.date), minutos_mas: c.addMinutes, motivo: c.reason }
          case 'drop':
            return { accion: 'no_recuperar', id: c.workout.id, titulo: c.workout.title, dia: day(c.workout.date), motivo: c.reason }
        }
      }),
      tss_perdido: Math.round(r.missedTss),
      tss_recuperado: Math.round(r.recoveredTss),
      ...(r.notes.length ? { notas: r.notes } : {}),
    })
  }

  private async projection(userId: string, args: Record<string, unknown>): Promise<string> {
    const p = await this.formProjection.execute(userId, optionalString(args.to))
    const point = (x: { ctl: number; atl: number; tsb: number }) => ({ ctl: Math.round(x.ctl), atl: Math.round(x.atl), tsb: Math.round(x.tsb) })
    const a = p.assessment
    return JSON.stringify({
      hoy: { ...point(p.current), estado: interpretTsb(p.current.tsb), nota: 'al final de hoy, contando lo pendiente de hoy' },
      horizonte: { hasta: p.horizon, motivo: HORIZON_LABELS[p.horizonReason] },
      carrera_objetivo: p.targetRace ? { nombre: p.targetRace.name, fecha: p.targetRace.date } : null,
      semanas: p.weeks.map(w => ({
        semana: formatDayKey(w.monday, { day: 'numeric', month: 'short' }),
        tss: w.tss,
        ...point(w),
        carga: LOAD_ORIGIN_LABELS[w.origin],
      })),
      carreras: a.races.map(r => ({
        nombre: r.name,
        prioridad: r.priority,
        fecha: r.date,
        ctl_llegada: Math.round(r.ctl),
        tsb_llegada: Math.round(r.tsb),
        ...(r.targetTsb ? { tsb_recomendado: `${r.targetTsb[0]} a ${r.targetTsb[1]}` } : {}),
        valoracion: r.assessment,
      })),
      ...(a.peakCtl ? { pico_ctl: { fecha: a.peakCtl.date, ctl: Math.round(a.peakCtl.ctl) } } : {}),
      ...(a.minTsb ? { tsb_minimo: { fecha: a.minTsb.date, tsb: Math.round(a.minTsb.tsb) } } : {}),
      plan_detallado_hasta: p.planEnd,
      tss_semanal_referencia: p.baseWeeklyTss,
      ...(a.warnings.length ? { avisos: a.warnings } : {}),
      ...(p.notes.length ? { notas: p.notes } : {}),
    })
  }

  private async save(userId: string, args: Record<string, unknown>): Promise<string> {
    // Accept a single workout object as well, in case the model skips the array
    const raw = Array.isArray(args.workouts) ? args.workouts : args.date ? [args] : []
    const inputs = raw.map(w => toInput(asRecord(w)))
    const [saved, profile] = await Promise.all([
      this.savePlanned.execute(userId, inputs, 'coach'),
      this.profiles.findByUserId(userId),
    ])
    return JSON.stringify({
      guardados: saved.length,
      entrenos: saved.map(w => this.toModel(w, profile)),
    })
  }

  private async update(userId: string, args: Record<string, unknown>): Promise<string> {
    const id = requireId(args.id)
    const patch = toInput(args)
    if (args.status !== undefined) patch.status = args.status
    if (Object.values(patch).every(v => v === undefined)) {
      return JSON.stringify({ error: 'sin_datos', mensaje: 'No se ha indicado ningún cambio.' })
    }
    const [updated, profile] = await Promise.all([
      this.updatePlanned.execute(userId, id, patch),
      this.profiles.findByUserId(userId),
    ])
    return JSON.stringify({ actualizado: true, entreno: this.toModel(updated, profile) })
  }

  private async delete(userId: string, args: Record<string, unknown>): Promise<string> {
    const deleted = await this.deletePlanned.execute(userId, requireId(args.id))
    return JSON.stringify({ borrado: true, id: deleted.id, fecha: deleted.date, titulo: deleted.title })
  }

  private async adapt(userId: string, args: Record<string, unknown>): Promise<string> {
    const id = requireId(args.id)
    const profile = await this.profiles.findByUserId(userId)

    if (args.restore_original === true) {
      const restored = await this.adaptPlanned.restore(userId, id)
      return JSON.stringify({ restaurado: true, entreno: this.toModel(restored, profile) })
    }

    try {
      const r = await this.adaptPlanned.execute(
        userId,
        id,
        { environment: args.environment, availableMinutes: args.available_minutes },
        args.save === true
      )
      const w = r.workout
      return JSON.stringify({
        guardado: r.saved,
        ...(r.saved ? {} : { nota: 'Vista previa: no se ha guardado. Preséntala y, si el ciclista está de acuerdo, llama otra vez con save: true.' }),
        id: w.id,
        fecha: w.date,
        titulo: w.title,
        tipo: FOCUS_LABELS[w.focus],
        original: versionToModel(r.original, profile),
        adaptado: versionToModel(w, profile),
        cambios: r.changes,
        ...(r.warnings.length ? { avisos: r.warnings } : {}),
      })
    } catch (err) {
      if (err instanceof AdaptationNotPossibleError) {
        return JSON.stringify({
          error: 'no_cabe',
          mensaje: `${err.message}. No se ha guardado nada. Propón otra sesión más corta con el mismo objetivo, o una de recuperación, y guárdala si el ciclista acepta.`,
          minimo_min: err.minimumMinutes,
        })
      }
      throw err
    }
  }

  private toModel(w: PlannedWorkout, profile: LoadProfile | null): Record<string, unknown> {
    const entry: Record<string, unknown> = {
      id: w.id,
      fecha: w.date,
      dia: formatDayKey(w.date, { weekday: 'long', day: 'numeric', month: 'long' }),
      titulo: w.title,
      tipo: FOCUS_LABELS[w.focus],
      entorno: w.environment,
      estado: w.status,
    }
    if (w.durationMinutes !== null) entry.duracion_min = w.durationMinutes
    if (w.plannedTss !== null) entry.tss_previsto = w.plannedTss
    if (w.blocks.length > 0) entry.estructura = formatStructure(w.blocks, profile)
    // Imported descriptions can be long (TrainingPeaks): keep the tool result compact
    if (w.description) {
      entry.descripcion = w.description.length > DESCRIPTION_IN_TOOL
        ? `${w.description.slice(0, DESCRIPTION_IN_TOOL).trimEnd()}…`
        : w.description
    }
    if (w.notes) entry.notas = w.notes
    if (w.source === 'import') entry.origen = 'import'
    if (w.status !== 'planned') entry.estado_fijado = w.statusSource === 'auto' ? 'wahoo' : 'a mano'
    const c = w.completion
    if (c) {
      entry.realizado = {
        ...(c.date !== w.date ? { fecha: c.date } : {}),
        duracion_min: c.actualMinutes,
        ...(c.actualTss !== null ? { tss: c.actualTss } : {}),
        ...(c.tssSource ? { tss_origen: TSS_SOURCE_LABELS[c.tssSource] } : {}),
        ...(c.durationPercent !== null ? { pct_duracion: c.durationPercent } : {}),
        ...(c.tssPercent !== null ? { pct_tss: c.tssPercent } : {}),
        entrenos_wahoo: c.wahooWorkoutIds,
      }
    }
    if (w.adaptation) {
      const o = w.adaptation.original
      entry.adaptado = {
        original: versionToModel(o, profile),
        ...(w.adaptation.availableMinutes !== null ? { minutos_disponibles: w.adaptation.availableMinutes } : {}),
        cambios: w.adaptation.changes,
      }
    }
    return entry
  }
}

function unplannedToModel(a: WahooWorkout, profile: LoadProfile | null): Record<string, unknown> {
  const load = workoutTss(a, profile)
  return {
    id_wahoo: a.id,
    fecha: dayKey(new Date(a.startedAt)),
    nombre: a.name,
    duracion_min: a.durationMinutes,
    ...(load.tss !== null ? { tss: load.tss } : {}),
  }
}

function versionToModel(v: WorkoutVersion, profile: LoadProfile | null): Record<string, unknown> {
  const entry: Record<string, unknown> = { entorno: v.environment }
  if (v.durationMinutes !== null) entry.duracion_min = v.durationMinutes
  if (v.plannedTss !== null) entry.tss_previsto = v.plannedTss
  if (v.blocks.length > 0) entry.estructura = formatStructure(v.blocks, profile)
  return entry
}

// ─── Conversión de argumentos ────────────────────────────────────────────────
// Formato del modelo (snake_case, duración en minutos, zonas en zone / zone_max) → dominio.
// También lo usa la extracción de planes desde imágenes, que pide al modelo el mismo esquema.

export function toInput(a: Record<string, unknown>): PlannedWorkoutInput {
  return {
    date: a.date,
    title: a.title,
    focus: a.focus,
    environment: a.environment,
    description: a.description,
    blocks: a.blocks === undefined ? undefined : toBlocks(a.blocks),
    durationMinutes: a.duration_min,
    tss: a.tss,
    notes: a.notes,
  }
}

function toBlocks(raw: unknown): unknown {
  if (!Array.isArray(raw)) return raw  // the domain reports the error
  return raw.map(b => {
    const block = asRecord(b)
    return {
      name: block.name,
      repeat: block.repeat,
      steps: Array.isArray(block.steps) ? block.steps.map(s => toStep(asRecord(s))) : block.steps,
    }
  })
}

function toStep(s: Record<string, unknown>): Record<string, unknown> {
  const minutes = Number(s.duration_min)
  return {
    kind: s.kind,
    durationSeconds: s.duration_s !== undefined ? s.duration_s : Number.isFinite(minutes) ? minutes * 60 : undefined,
    target: toTarget(s.target),
    cadenceMin: s.cadence_min,
    cadenceMax: s.cadence_max,
    notes: s.notes,
  }
}

function toTarget(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object') return raw
  const t = raw as Record<string, unknown>
  if (t.type === 'hr_zone' || t.type === 'power_zone') {
    return { type: t.type, min: t.zone ?? t.min, max: t.zone_max ?? t.max ?? t.zone ?? t.min }
  }
  return { type: t.type, min: t.min, max: t.max }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function requireId(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new PlanValidationError('Falta el id del entreno planificado')
  return value.trim()
}
