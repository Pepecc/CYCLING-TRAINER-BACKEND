import { RaceEvent, RaceEventInput, RacePriority, RaceType, RaceValidationError } from '../../../domain/events/RaceEvent'
import { SeasonPhaseKind, WeekType, DateRange } from '../../../domain/events/seasonPlan'
import { addDays, dayKey, daysBetween, formatDayKey } from '../../../domain/training/calendar'
import { SaveRaceEvents } from '../../../application/events/SaveRaceEvents'
import { UpdateRaceEvent } from '../../../application/events/UpdateRaceEvent'
import { DeleteRaceEvent } from '../../../application/events/DeleteRaceEvent'
import { GetRaceEvents } from '../../../application/events/GetRaceEvents'
import { GetSeasonPlan } from '../../../application/events/GetSeasonPlan'

export const SEASON_TOOLS = ['get_race_events', 'save_race_event', 'update_race_event', 'delete_race_event', 'get_season_plan']

export const RACE_TYPE_LABELS: Record<RaceType, string> = {
  road_race: 'carrera en ruta',
  gran_fondo: 'gran fondo / marcha',
  criterium: 'critérium',
  time_trial: 'contrarreloj',
  hill_climb: 'cronoescalada',
  stage_race: 'vuelta por etapas',
  gravel: 'gravel',
  mtb: 'MTB',
  cyclocross: 'ciclocross',
  other: 'otra',
}

export const PHASE_LABELS: Record<SeasonPhaseKind, string> = {
  base: 'base',
  build: 'construcción',
  peak: 'pico',
  taper: 'taper',
  race: 'carrera',
  recovery: 'recuperación',
  general: 'preparación general',
}

export const PHASE_GUIDE: Record<SeasonPhaseKind, string> = {
  base: 'Resistencia aeróbica: volumen progresivo, sobre todo Z2, con algo de tempo / sweet spot y fuerza-resistencia (cadencia baja en subida). 3 semanas de carga y 1 de descarga.',
  build: 'Construcción: se mantiene el volumen y sube la intensidad (sweet spot, umbral y VO2max según la prueba), 2-3 sesiones de calidad por semana. 3 semanas de carga y 1 de descarga.',
  peak: 'Pico / específico: sesiones que imitan la carrera (subidas largas, ritmo de carrera, simulacros), algo menos de volumen y buena recuperación entre sesiones duras.',
  taper: 'Taper: bajar el volumen un 40-60 % manteniendo toques cortos de intensidad; la última semana, activaciones cortas y descanso. Llegar con TSB positivo.',
  race: 'Día de carrera.',
  recovery: 'Recuperación: descanso y rodajes suaves en Z1-Z2, sin intensidad, hasta sentirse fresco.',
  general: 'Preparación general: base aeróbica con algo de intensidad, alternando 3 semanas de carga y 1 de descarga.',
}

export const PRIORITY_GUIDE: Record<RacePriority, string> = {
  A: 'Objetivo principal: la temporada se periodiza hacia ella, con taper de 2 semanas y una semana de recuperación después.',
  B: 'Mini-taper de 3 días (menos volumen y una activación corta el día antes) y 2 días suaves después. No interrumpe el bloque.',
  C: 'Se corre como entreno: sustituye la sesión de calidad de ese día o semana, sin taper; al día siguiente, rodaje suave.',
}

const WEEK_TYPE_LABELS: Record<WeekType, string> = {
  load: 'carga',
  deload: 'descarga',
  peak: 'específica',
  taper: 'taper',
  race: 'carrera',
  recovery: 'recuperación',
  general: 'general',
}

// Tools de carreras y temporada. Los argumentos llegan en snake_case (como los ve el modelo).
export class SeasonTools {
  constructor(
    private readonly saveEvents: SaveRaceEvents,
    private readonly updateEvent: UpdateRaceEvent,
    private readonly deleteEvent: DeleteRaceEvent,
    private readonly getEvents: GetRaceEvents,
    private readonly getPlan: GetSeasonPlan
  ) {}

  async execute(userId: string, toolName: string, args: Record<string, unknown>): Promise<string> {
    switch (toolName) {
      case 'get_race_events':
        return this.list(userId, args)
      case 'save_race_event':
        return this.save(userId, args)
      case 'update_race_event':
        return this.update(userId, args)
      case 'delete_race_event':
        return this.delete(userId, args)
      case 'get_season_plan':
        return this.seasonPlan(userId)
      default:
        throw new Error(`Tool de temporada desconocida: ${toolName}`)
    }
  }

  private async list(userId: string, args: Record<string, unknown>): Promise<string> {
    const events = await this.getEvents.execute(userId, args.include_past === true)
    if (events.length === 0) {
      return JSON.stringify({ carreras: [], message: 'No hay carreras guardadas. Pregunta al ciclista por sus objetivos y guárdalos con save_race_event.' })
    }
    return JSON.stringify({ carreras: events.map(e => raceToModel(e)) })
  }

  private async save(userId: string, args: Record<string, unknown>): Promise<string> {
    // Accept a single race object as well, in case the model skips the array
    const raw = Array.isArray(args.events) ? args.events : args.name ? [args] : []
    const saved = await this.saveEvents.execute(userId, raw.map(e => toInput(asRecord(e))))
    return JSON.stringify({
      guardadas: saved.length,
      carreras: saved.map(e => raceToModel(e)),
      siguiente_paso: 'Consulta get_season_plan para ver cómo quedan las fases de la temporada.',
    })
  }

  private async update(userId: string, args: Record<string, unknown>): Promise<string> {
    const patch = toInput(args)
    if (Object.values(patch).every(v => v === undefined)) {
      return JSON.stringify({ error: 'sin_datos', mensaje: 'No se ha indicado ningún cambio.' })
    }
    const updated = await this.updateEvent.execute(userId, requireId(args.id), patch)
    return JSON.stringify({ actualizada: true, carrera: raceToModel(updated) })
  }

  private async delete(userId: string, args: Record<string, unknown>): Promise<string> {
    const deleted = await this.deleteEvent.execute(userId, requireId(args.id))
    return JSON.stringify({ borrada: true, id: deleted.id, nombre: deleted.name, fecha: deleted.date })
  }

  private async seasonPlan(userId: string): Promise<string> {
    const plan = await this.getPlan.execute(userId)
    const range = (r: DateRange) => ({ desde: r.from, hasta: r.to })
    const raceName = (id: string | null) => plan.races.find(r => r.raceId === id)?.name ?? null
    const phaseKinds = new Set(plan.phases.map(p => p.kind))

    const target = plan.targetRace
    return JSON.stringify({
      hoy: plan.today,
      carrera_objetivo: target ? {
        id: target.id,
        nombre: target.name,
        fecha: target.date,
        dias_restantes: daysBetween(plan.today, target.date),
        semanas_restantes: +(daysBetween(plan.today, target.date) / 7).toFixed(1),
      } : null,
      fase_actual: plan.currentPhase ? {
        fase: PHASE_LABELS[plan.currentPhase.kind],
        ...range(plan.currentPhase),
        carrera: raceName(plan.currentPhase.raceId),
        dias_restantes_fase: daysBetween(plan.today, plan.currentPhase.to) + 1,
      } : null,
      fases: plan.phases.map(p => ({
        fase: PHASE_LABELS[p.kind],
        ...range(p),
        semanas: +((daysBetween(p.from, p.to) + 1) / 7).toFixed(1),
        carrera: raceName(p.raceId),
      })),
      pautas_por_fase: Object.fromEntries(
        (Object.keys(PHASE_GUIDE) as SeasonPhaseKind[])
          .filter(k => phaseKinds.has(k) && k !== 'race')
          .map(k => [PHASE_LABELS[k], PHASE_GUIDE[k]])
      ),
      carreras: plan.races.map(r => ({
        id: r.raceId,
        nombre: r.name,
        prioridad: r.priority,
        fecha: r.date,
        ...(r.endDate !== r.date ? { fecha_fin: r.endDate } : {}),
        dias_restantes: r.daysToRace,
        ...(r.taper ? { [r.priority === 'A' ? 'taper' : 'mini_taper']: range(r.taper) } : {}),
        ...(r.recovery ? { recuperacion: range(r.recovery) } : {}),
        como_correrla: PRIORITY_GUIDE[r.priority],
        ...(r.warnings.length ? { avisos: r.warnings } : {}),
      })),
      semanas: plan.weeks.map(w => ({
        semana: `${formatDayKey(w.monday, { day: 'numeric', month: 'short' })} - ${formatDayKey(addDays(w.monday, 6), { day: 'numeric', month: 'short' })}`,
        lunes: w.monday,
        fase: PHASE_LABELS[w.phase],
        tipo: WEEK_TYPE_LABELS[w.type],
        carga_pct: w.loadPercent,
        ...(w.races.length ? { carreras: w.races.map(r => `${r.name} (${r.priority}, ${formatDayKey(r.date, { weekday: 'short', day: 'numeric' })})`) } : {}),
      })),
      nota_carga: 'carga_pct es orientativa: % de la carga de una semana normal del ciclista (consulta su TSS semanal con get_block_summary).',
      ...(plan.warnings.length ? { avisos: plan.warnings } : {}),
    })
  }
}

// ─── Conversión ──────────────────────────────────────────────────────────────

export function raceToModel(e: RaceEvent, today = dayKey(new Date())): Record<string, unknown> {
  const entry: Record<string, unknown> = {
    id: e.id,
    nombre: e.name,
    fecha: e.date,
    dia: formatDayKey(e.date, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }),
    prioridad: e.priority,
    tipo: RACE_TYPE_LABELS[e.type],
  }
  if (e.days > 1) entry.dias_competicion = e.days
  const daysTo = daysBetween(today, e.date)
  if (e.endDate < today) entry.estado = 'corrida'
  else if (daysTo <= 0) entry.estado = 'en curso'
  else {
    entry.dias_restantes = daysTo
    entry.semanas_restantes = +(daysTo / 7).toFixed(1)
  }
  if (e.distanceKm !== null) entry.distancia_km = e.distanceKm
  if (e.elevationM !== null) entry.desnivel_m = e.elevationM
  if (e.location) entry.lugar = e.location
  if (e.goal) entry.objetivo = e.goal
  if (e.notes) entry.notas = e.notes
  if (e.result) entry.resultado = e.result
  return entry
}

function toInput(a: Record<string, unknown>): RaceEventInput {
  return {
    name: a.name,
    date: a.date,
    days: a.days,
    priority: a.priority,
    type: a.type,
    distanceKm: a.distance_km,
    elevationM: a.elevation_m,
    location: a.location,
    goal: a.goal,
    notes: a.notes,
    result: a.result,
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
}

function requireId(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new RaceValidationError('Falta el id de la carrera')
  return value.trim()
}
