import { WahooWorkout } from '../wahoo/WahooWorkout'
import { isCyclingWorkoutType } from '../wahoo/WorkoutTypes'
import { LoadProfile, TssSource, workoutTss } from '../training/trainingMetrics'
import { addDays, daysBetween, dayKey } from '../training/calendar'
import { PlannedStatus, PlannedWorkout, WorkoutCompletion, WorkoutFocus } from './PlannedWorkout'

// Enlace del plan con los entrenos reales de Wahoo (plan vivo, 7.9).
//
// - Cada entreno de bici planificado se enlaza con los entrenos de Wahoo de su día. Si un entreno de Wahoo
//   cae en un día sin nada planificado, se enlaza con el planificado sin hacer del día anterior o del
//   siguiente, si su carga se parece (entreno cambiado de día).
// - Con enlace: hecho si se completa al menos el 80 % de la duración (y el 70 % del TSS, si se conoce);
//   si no, parcial. Sin enlace y con el día ya pasado: saltado. Hoy y los días siguientes, pendiente.
// - Un estado puesto a mano (por el ciclista o el coach) no se cambia; solo se actualizan los datos del enlace.
// - Descansos, fuerza y "otro" (core, movilidad) no pasan por Wahoo: no se enlazan.

const NOT_LINKED: WorkoutFocus[] = ['rest', 'strength', 'other']

export const DONE_DURATION_PERCENT = 80
export const DONE_TSS_PERCENT = 70
export const DONE_TSS_ONLY_PERCENT = 80
// Entreno cambiado de día: solo si su carga se parece a la planificada (evita tomar un rodaje suave
// sin planificar por la sesión de series de mañana)
export const SHIFT_MIN_PERCENT = 60
export const SHIFT_MAX_DAYS = 1

export interface DateRange {
  from: string
  to: string
}

export interface ReconcileResult {
  changed: PlannedWorkout[]       // entrenos cuyo estado o enlace ha cambiado (hay que guardarlos)
  unplanned: WahooWorkout[]       // entrenos de bici del rango sin entreno planificado (más recientes primero)
}

export function isLinkable(w: PlannedWorkout): boolean {
  return !NOT_LINKED.includes(w.focus)
}

// planned / actuals: todo lo cargado, incluido un día de margen a cada lado del rango (para los cambios de día).
// Solo cambian los entrenos planificados con fecha dentro de `range`. Modifica los entrenos recibidos.
export function reconcilePlan(
  planned: PlannedWorkout[],
  actuals: WahooWorkout[],
  profile: LoadProfile | null,
  today: string,
  range: DateRange
): ReconcileResult {
  const now = new Date().toISOString()
  const rides = actuals
    .filter(a => isCyclingWorkoutType(a.workoutTypeName))
    .map(a => ({ workout: a, day: dayKey(new Date(a.startedAt)) }))
    .sort((a, b) => a.workout.startedAt.localeCompare(b.workout.startedAt))
  const linkable = planned
    .filter(isLinkable)
    .sort((a, b) => a.date.localeCompare(b.date) || a.createdAt.localeCompare(b.createdAt))

  const links = new Map<PlannedWorkout, WahooWorkout[]>()
  const used = new Set<WahooWorkout>()

  // 1. Mismo día. Con un solo entreno planificado, todo lo de ese día cuenta para él (sesión partida en dos);
  //    con varios, se emparejan en orden y lo que sobra queda sin planificar.
  for (const [day, plannedDay] of groupBy(linkable, w => w.date)) {
    const ridesDay = rides.filter(r => r.day === day).map(r => r.workout)
    if (ridesDay.length === 0) continue
    if (plannedDay.length === 1) {
      links.set(plannedDay[0], ridesDay)
      ridesDay.forEach(r => used.add(r))
    } else {
      plannedDay.forEach((p, i) => {
        if (!ridesDay[i]) return
        links.set(p, [ridesDay[i]])
        used.add(ridesDay[i])
      })
    }
  }

  // 2. Cambiado de día: un entreno en un día sin nada planificado (ni descanso) → el planificado sin hacer
  //    más cercano. Primero el del día anterior: recuperar una sesión es más habitual que adelantarla.
  //    Adelantada solo si se hizo hoy (la sesión es la de mañana) o si ya estaba enlazada así: un rodaje
  //    sin planificar de ayer no cuenta como la sesión de hoy (p. ej. una que se acaba de mover a hoy).
  const plannedDays = new Set(planned.map(p => p.date))
  for (const r of rides) {
    if (used.has(r.workout) || plannedDays.has(r.day)) continue
    const candidate = linkable
      .filter(p => !links.has(p))
      .map(p => ({ p, shift: daysBetween(p.date, r.day) }))   // > 0: se hizo después de lo planificado
      .filter(({ p, shift }) => shift < 0
        ? r.day === today || (p.completion?.wahooWorkoutIds.includes(r.workout.id) ?? false)
        : true)
      .filter(({ p, shift }) => shift !== 0 && Math.abs(shift) <= SHIFT_MAX_DAYS && similarLoad(p, [r.workout], profile))
      .sort((a, b) => b.shift - a.shift)[0]
    if (candidate) {
      links.set(candidate.p, [r.workout])
      used.add(r.workout)
    }
  }

  const changed: PlannedWorkout[] = []
  for (const p of linkable) {
    if (p.date < range.from || p.date > range.to) continue
    const linked = links.get(p)
    let status: PlannedStatus
    let completion: WorkoutCompletion | null = null
    if (linked) {
      completion = buildCompletion(p, linked, profile, now)
      status = isDone(p, completion) ? 'done' : 'partial'
    } else {
      status = p.date < today ? 'skipped' : 'planned'
    }
    if (p.applyLink(status, completion)) changed.push(p)
  }

  const unplanned = rides
    .filter(r => !used.has(r.workout) && r.day >= range.from && r.day <= range.to)
    .map(r => r.workout)
    .reverse()
  return { changed, unplanned }
}

export function buildCompletion(
  p: PlannedWorkout, rides: WahooWorkout[], profile: LoadProfile | null, linkedAt: string
): WorkoutCompletion {
  const seconds = rides.reduce((acc, r) => acc + (r.summary?.durationActiveSeconds ?? r.durationMinutes * 60), 0)
  let tss: number | null = null
  let tssSource: TssSource | null = null
  for (const r of rides) {
    const load = workoutTss(r, profile)
    if (load.tss !== null) {
      tss = (tss ?? 0) + load.tss
      tssSource = tssSource ?? load.source
    }
  }
  const actualMinutes = Math.round(seconds / 60)
  return {
    wahooWorkoutIds: rides.map(r => r.id),
    date: dayKey(new Date(rides[0].startedAt)),
    actualMinutes,
    actualTss: tss === null ? null : Math.round(tss),
    tssSource,
    durationPercent: p.durationMinutes ? Math.round((actualMinutes / p.durationMinutes) * 100) : null,
    tssPercent: p.plannedTss && tss !== null ? Math.round((tss / p.plannedTss) * 100) : null,
    linkedAt,
  }
}

export function isDone(p: PlannedWorkout, c: WorkoutCompletion): boolean {
  if (p.focus === 'race') return true   // una carrera se da por hecha aunque dure menos de lo estimado
  if (c.durationPercent !== null) {
    return c.durationPercent >= DONE_DURATION_PERCENT && (c.tssPercent === null || c.tssPercent >= DONE_TSS_PERCENT)
  }
  if (c.tssPercent !== null) return c.tssPercent >= DONE_TSS_ONLY_PERCENT
  return true   // sin duración ni TSS previstos no hay con qué comparar
}

function similarLoad(p: PlannedWorkout, rides: WahooWorkout[], profile: LoadProfile | null): boolean {
  const c = buildCompletion(p, rides, profile, '')
  const percents = [c.durationPercent, c.tssPercent].filter((x): x is number => x !== null)
  return percents.length > 0 && percents.every(x => x >= SHIFT_MIN_PERCENT)
}

function groupBy<T>(items: T[], key: (t: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>()
  for (const it of items) {
    const k = key(it)
    const list = map.get(k)
    if (list) list.push(it)
    else map.set(k, [it])
  }
  return map
}

// Parte de [from, to] que conviene enlazar: hasta mañana (un entreno de mañana puede haberse adelantado a hoy)
// y como mucho los últimos `maxPastDays` días. null si no hay nada que enlazar.
export function reconcileRange(from: string, to: string, today: string, maxPastDays = 60): DateRange | null {
  const oldest = addDays(today, -maxPastDays)
  const latest = addDays(today, SHIFT_MAX_DAYS)
  const start = from > oldest ? from : oldest
  const end = to < latest ? to : latest
  return start <= end ? { from: start, to: end } : null
}
