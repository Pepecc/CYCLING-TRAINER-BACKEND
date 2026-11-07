import { addDays, mondayKey } from '../training/calendar'
import { LoadProfile } from '../training/trainingMetrics'
import { WeekType } from '../events/seasonPlan'
import { PlannedWorkout, PlannedWorkoutInput, WorkoutBlock, WorkoutFocus, WorkoutStep } from './PlannedWorkout'

// Replanificar la semana cuando se saltan entrenos (plan vivo, 7.9). Determinista, sin IA.
//
// - Solo se mueve dentro de la misma semana (lunes a domingo) y a partir de hoy (mañana si hoy ya se ha entrenado).
// - Sesiones de calidad saltadas (test primero, luego umbral / VO2max / anaeróbico, luego sweet spot / tempo / sprint):
//   se mueven al primer día que no deje dos días duros seguidos, sustituyendo un rodaje suave de ese día o a un
//   día libre disponible. Nunca a un día de descanso planificado ni a días protegidos (taper, carreras, recuperación).
//   Como mucho 1 sesión si quedan 3 días o menos, y 2 si quedan más.
// - Rodaje de resistencia saltado: se amplía el rodaje de resistencia pendiente más largo con la mitad del
//   tiempo perdido (máx. 30 min), una vez por semana.
// - Recuperación, técnica y carreras saltadas no se recuperan.
// - En semanas de descarga, taper, carrera o recuperación no se recupera nada: lo perdido se da por perdido.

export const QUALITY_FOCUSES: WorkoutFocus[] = ['test', 'threshold', 'vo2max', 'anaerobic', 'sweet_spot', 'tempo', 'sprint']
const HARD_FOCUSES: WorkoutFocus[] = [...QUALITY_FOCUSES, 'race']
const EASY_FOCUSES: WorkoutFocus[] = ['recovery', 'endurance', 'technique']
const QUALITY_PRIORITY: Partial<Record<WorkoutFocus, number>> = {
  test: 0, threshold: 1, vo2max: 1, anaerobic: 1, sweet_spot: 2, tempo: 2, sprint: 2,
}
const NO_RECOVERY_WEEKS: Partial<Record<WeekType, string>> = {
  deload: 'Es una semana de descarga: lo que se ha saltado no se recupera, la prioridad es asimilar.',
  taper: 'Es una semana de taper: no se recupera lo saltado, llegar fresco a la carrera es lo importante.',
  race: 'Es la semana de la carrera: no se recupera lo saltado.',
  recovery: 'Es una semana de recuperación: no se recupera lo saltado.',
}
export const MAX_EXTENSION_MINUTES = 30
const MIN_EXTENSION_MINUTES = 10

export interface ProtectedRange {
  from: string
  to: string
  reason: string
}

export interface ReplanInput {
  today: string
  week: PlannedWorkout[]                 // entrenos planificados de la semana (lunes a domingo)
  availableWeekdays: number[] | null     // 1 = lunes … 7 = domingo; null = no se sabe
  weekType: WeekType | null              // tipo de la semana en el plan de temporada
  protectedRanges: ProtectedRange[]      // días sin sesiones de calidad nuevas
  trainedToday: boolean
  profile: LoadProfile | null
}

export type ReplanChange =
  | { kind: 'move'; workout: PlannedWorkout; from: string; to: string; replaces: PlannedWorkout | null; reason: string; tssDelta: number }
  | { kind: 'extend'; workout: PlannedWorkout; addMinutes: number; patch: PlannedWorkoutInput; recovers: PlannedWorkout; reason: string; tssDelta: number }
  | { kind: 'drop'; workout: PlannedWorkout; reason: string }

export interface ReplanResult {
  monday: string
  sunday: string
  skipped: PlannedWorkout[]
  changes: ReplanChange[]
  missedTss: number
  recoveredTss: number
  notes: string[]
}

interface Slot {
  date: string
  focus: WorkoutFocus
  workout: PlannedWorkout
}

export function replanWeek(input: ReplanInput): ReplanResult {
  const { today, profile } = input
  const monday = mondayKey(today)
  const sunday = addDays(monday, 6)
  const start = input.trainedToday ? addDays(today, 1) : today
  const notes: string[] = []
  const changes: ReplanChange[] = []

  const skipped = input.week
    .filter(w => w.status === 'skipped' && w.date >= monday && w.date <= sunday && w.focus !== 'rest')
    .sort((a, b) => a.date.localeCompare(b.date))
  const missedTss = skipped.reduce((a, w) => a + (w.plannedTss ?? 0), 0)
  const result = (): ReplanResult => ({
    monday, sunday, skipped, changes, missedTss,
    recoveredTss: changes.reduce((a, c) => a + (c.kind === 'drop' ? 0 : c.tssDelta), 0),
    notes,
  })

  if (skipped.length === 0) {
    notes.push('No hay entrenos saltados esta semana: no hace falta replanificar.')
    return result()
  }
  const noRecovery = input.weekType ? NO_RECOVERY_WEEKS[input.weekType] : undefined
  if (noRecovery || start > sunday) {
    const reason = noRecovery ?? 'Ya no quedan días esta semana: lo saltado no se recupera.'
    notes.push(reason)
    skipped.forEach(w => changes.push({ kind: 'drop', workout: w, reason }))
    return result()
  }

  // Simulated week: what stays in each day after the changes (skipped sessions are not there)
  let slots: Slot[] = input.week
    .filter(w => w.status !== 'skipped')
    .map(w => ({ date: w.date, focus: w.focus, workout: w }))
  const isHard = (d: string) => slots.some(s => s.date === d && HARD_FOCUSES.includes(s.focus))
  const isProtected = (d: string) => input.protectedRanges.find(r => r.from <= d && d <= r.to) ?? null

  const remainingDays = daysInclusive(start, sunday)
  const maxMoves = remainingDays <= 3 ? 1 : 2
  let moves = 0
  let extended = false
  let usedUnknownAvailability = false

  const ordered = [...skipped].sort((a, b) => priority(a) - priority(b) || a.date.localeCompare(b.date))
  for (const s of ordered) {
    if (QUALITY_FOCUSES.includes(s.focus)) {
      if (moves >= maxMoves) {
        changes.push({ kind: 'drop', workout: s, reason: `Ya se recupera ${maxMoves === 1 ? 'una sesión de calidad' : 'dos sesiones de calidad'} esta semana: meter más acumularía demasiada fatiga.` })
        continue
      }
      let chosen: { date: string; replaces: Slot | null } | null = null
      for (let d = start; d <= sunday && !chosen; d = addDays(d, 1)) {
        if (isProtected(d) || isHard(addDays(d, -1)) || isHard(d) || isHard(addDays(d, 1))) continue
        const day = slots.filter(x => x.date === d)
        if (day.some(x => x.focus === 'rest')) continue   // a planned rest day is deliberate
        const easy = day.find(x => EASY_FOCUSES.includes(x.focus) && x.workout.status === 'planned') ?? null
        if (day.length > 0 && !easy) continue             // strength / core days or sessions already done
        if (day.length === 0) {
          if (input.availableWeekdays && !input.availableWeekdays.includes(weekday(d))) continue
          if (!input.availableWeekdays) usedUnknownAvailability = true
        }
        chosen = { date: d, replaces: easy }
      }
      if (!chosen) {
        changes.push({ kind: 'drop', workout: s, reason: 'No queda ningún día esta semana sin juntar dos días duros (ni días disponibles libres): se da por perdida.' })
        continue
      }
      const replaces = chosen.replaces?.workout ?? null
      changes.push({
        kind: 'move', workout: s, from: s.date, to: chosen.date, replaces,
        reason: replaces
          ? `Sesión clave: pasa al ${chosen.date} en lugar de "${replaces.title}", sin juntar dos días duros.`
          : `Sesión clave: pasa al ${chosen.date}, día libre, sin juntar dos días duros.`,
        tssDelta: (s.plannedTss ?? 0) - (replaces?.plannedTss ?? 0),
      })
      slots = slots.filter(x => x !== chosen!.replaces)
      slots.push({ date: chosen.date, focus: s.focus, workout: s })
      moves++
      continue
    }

    if (s.focus === 'endurance' && !extended) {
      const missed = s.durationMinutes ?? 0
      const add = Math.min(MAX_EXTENSION_MINUTES, Math.round((missed * 0.5) / 5) * 5)
      const target = slots
        .filter(x => x.date >= start && x.focus === 'endurance' && x.workout.status === 'planned')
        .map(x => ({ x, patch: extensionPatch(x.workout, add) }))
        .filter((c): c is { x: Slot; patch: PlannedWorkoutInput } => c.patch !== null)
        .sort((a, b) => (b.x.workout.durationMinutes ?? 0) - (a.x.workout.durationMinutes ?? 0))[0]
      if (add >= MIN_EXTENSION_MINUTES && target) {
        const w = target.x.workout
        changes.push({
          kind: 'extend', workout: w, addMinutes: add, patch: target.patch, recovers: s,
          reason: `Se recupera parte del volumen de "${s.title}": ${add} min más de rodaje suave el ${w.date}.`,
          tssDelta: tssAfter(w, target.patch, profile) - (w.plannedTss ?? 0),
        })
        extended = true
        continue
      }
      changes.push({
        kind: 'drop', workout: s,
        reason: add < MIN_EXTENSION_MINUTES
          ? 'Poco volumen perdido: no hace falta recuperarlo.'
          : 'No queda ningún rodaje de resistencia esta semana que se pueda alargar.',
      })
      continue
    }

    changes.push({
      kind: 'drop', workout: s,
      reason: s.focus === 'race' ? 'Una carrera no se recupera.'
        : s.focus === 'endurance' ? 'Ya se amplía otro rodaje esta semana.'
        : 'Sesión suave o complementaria: no hace falta recuperarla.',
    })
  }

  if (usedUnknownAvailability) {
    notes.push('No consta qué días puede entrenar (perfil sin días disponibles): confirma que puede el día propuesto.')
  }
  // Present the changes in calendar order
  changes.sort((a, b) => changeDate(a).localeCompare(changeDate(b)))
  return result()
}

// ─── Ampliar un rodaje ───────────────────────────────────────────────────────

// Patch that adds `minutes` to the longest easy continuous step (or to the duration, without structure).
// null if the workout has nothing that can be extended.
export function extensionPatch(w: PlannedWorkout, minutes: number): PlannedWorkoutInput | null {
  if (minutes <= 0) return null
  if (w.blocks.length === 0) {
    if (!w.durationMinutes) return null
    const duration = w.durationMinutes + minutes
    const tss = w.plannedTss !== null ? Math.round((w.plannedTss * duration) / w.durationMinutes) : null
    return { durationMinutes: duration, tss }
  }

  let best: { b: number; s: number; seconds: number } | null = null
  for (let b = 0; b < w.blocks.length; b++) {
    if (w.blocks[b].repeat !== 1) continue
    w.blocks[b].steps.forEach((step, s) => {
      if (step.kind !== 'steady' || !isEasy(step)) return
      if (best === null || step.durationSeconds > best.seconds) best = { b, s, seconds: step.durationSeconds }
    })
  }
  const found = best as { b: number; s: number; seconds: number } | null
  if (!found) return null
  const { b, s } = found
  const blocks: WorkoutBlock[] = JSON.parse(JSON.stringify(w.blocks))
  blocks[b].steps[s].durationSeconds += minutes * 60
  return { blocks }
}

function isEasy(step: WorkoutStep): boolean {
  const max = step.target.max
  switch (step.target.type) {
    case 'open': return true
    case 'hr_zone':
    case 'power_zone': return max !== null && max <= 2
    case 'ftp_percent': return max !== null && max <= 75
    case 'rpe': return max !== null && max <= 4
    default: return false
  }
}

function tssAfter(w: PlannedWorkout, patch: PlannedWorkoutInput, profile: LoadProfile | null): number {
  const copy = new PlannedWorkout({ ...w, blocks: JSON.parse(JSON.stringify(w.blocks)) })
  copy.update(patch, profile)
  return copy.plannedTss ?? 0
}

// ─── Días disponibles ────────────────────────────────────────────────────────

const DAY_PATTERNS: Array<[RegExp, number]> = [
  [/\blunes\b/, 1], [/\bmartes\b/, 2], [/\bmi[eé]rcoles\b/, 3], [/\bjueves\b/, 4],
  [/\bviernes\b/, 5], [/\bs[aá]bados?\b/, 6], [/\bdomingos?\b/, 7],
]
const DAY_WORD = 'lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bados?|domingos?'

// "martes, jueves, sábado y domingo", "de lunes a viernes", "fines de semana", "entre semana", "todos los días".
// null si no se reconoce ningún día.
export function parseAvailableWeekdays(text: string | null | undefined): number[] | null {
  if (!text) return null
  const t = text.toLowerCase()
  if (/todos los d[ií]as|cualquier d[ií]a|a diario/.test(t)) return [1, 2, 3, 4, 5, 6, 7]
  const days = new Set<number>()
  if (/fin(es)? de semana/.test(t)) { days.add(6); days.add(7) }
  if (/entre semana|laborables/.test(t)) [1, 2, 3, 4, 5].forEach(d => days.add(d))
  for (const m of t.matchAll(new RegExp(`(${DAY_WORD})\\s*(?:a|al|-|hasta)\\s*(?:el\\s+)?(${DAY_WORD})`, 'g'))) {
    const from = dayNumber(m[1])
    const to = dayNumber(m[2])
    if (from && to) for (let d = from; d !== to; d = (d % 7) + 1) days.add(d)
    if (to) days.add(to)
  }
  for (const [re, n] of DAY_PATTERNS) if (re.test(t)) days.add(n)
  return days.size ? [...days].sort((a, b) => a - b) : null
}

function dayNumber(word: string): number | null {
  return DAY_PATTERNS.find(([re]) => re.test(word))?.[1] ?? null
}

// ─── Utilidades ──────────────────────────────────────────────────────────────

function priority(w: PlannedWorkout): number {
  return QUALITY_PRIORITY[w.focus] ?? (w.focus === 'endurance' ? 5 : 9)
}

function weekday(key: string): number {
  const d = new Date(`${key}T12:00:00Z`).getUTCDay()
  return d === 0 ? 7 : d
}

function daysInclusive(from: string, to: string): number {
  let n = 0
  for (let d = from; d <= to; d = addDays(d, 1)) n++
  return n
}

function changeDate(c: ReplanChange): string {
  return c.kind === 'move' ? c.to : c.kind === 'extend' ? c.workout.date : c.workout.date
}
