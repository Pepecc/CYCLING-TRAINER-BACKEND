import { PlannedWorkout, PlannedWorkoutInput, PlanValidationError, WorkoutFocus } from '../../../domain/planning/PlannedWorkout'
import { formatStructure } from '../../../domain/planning/formatStructure'
import { CyclistProfileRepository } from '../../../domain/profile/CyclistProfileRepository'
import { LoadProfile } from '../../../domain/training/trainingMetrics'
import { addDays, formatDayKey, mondayKey } from '../../../domain/training/calendar'
import { SavePlannedWorkouts } from '../../../application/planning/SavePlannedWorkouts'
import { UpdatePlannedWorkout } from '../../../application/planning/UpdatePlannedWorkout'
import { DeletePlannedWorkout } from '../../../application/planning/DeletePlannedWorkout'
import { GetTrainingPlan } from '../../../application/planning/GetTrainingPlan'

export const PLANNING_TOOLS = ['get_training_plan', 'save_planned_workout', 'update_planned_workout', 'delete_planned_workout']

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
    private readonly profiles: CyclistProfileRepository
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
      default:
        throw new Error(`Tool de planificación desconocida: ${toolName}`)
    }
  }

  private async getTrainingPlan(userId: string, args: Record<string, unknown>): Promise<string> {
    const [plan, profile] = await Promise.all([
      this.getPlan.execute(userId, optionalString(args.from), optionalString(args.to)),
      this.profiles.findByUserId(userId),
    ])
    const range = `${formatDayKey(plan.from, { day: 'numeric', month: 'long' })} - ${formatDayKey(plan.to, { day: 'numeric', month: 'long' })}`

    if (plan.workouts.length === 0) {
      return JSON.stringify({ desde: plan.from, hasta: plan.to, message: `No hay entrenos planificados entre ${range}.` })
    }

    // Weekly totals (Monday-Sunday) of the planned workouts in range
    const weeks = new Map<string, { sesiones: number; minutos: number; tss: number; hechos: number; saltados: number }>()
    for (const w of plan.workouts) {
      const key = mondayKey(w.date)
      const week = weeks.get(key) ?? { sesiones: 0, minutos: 0, tss: 0, hechos: 0, saltados: 0 }
      if (w.focus !== 'rest') week.sesiones++
      week.minutos += w.durationMinutes ?? 0
      week.tss += w.plannedTss ?? 0
      if (w.status === 'done' || w.status === 'partial') week.hechos++
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
        hechos: wk.hechos,
        saltados: wk.saltados,
      })),
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
    if (w.description) entry.descripcion = w.description
    if (w.notes) entry.notas = w.notes
    return entry
  }
}

// ─── Conversión de argumentos ────────────────────────────────────────────────

function toInput(a: Record<string, unknown>): PlannedWorkoutInput {
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
