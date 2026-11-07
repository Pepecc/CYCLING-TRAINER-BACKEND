import { addDays, daysBetween, mondayKey } from '../training/calendar'
import { RaceEvent, RacePriority } from './RaceEvent'

// Periodización de la temporada a partir de las carreras. No se guarda: se calcula cada vez,
// así que cambiar una carrera actualiza el plan al momento.
//
// Hacia cada carrera A se cuenta hacia atrás desde su fecha (así las fases no se mueven al pasar los días):
//   base · construcción (8 semanas) · pico (2 semanas) · taper (2 semanas) · carrera · recuperación (1 semana)
// Si queda menos margen, las primeras fases se recortan (con poco tiempo ya no hay base).
// Carreras B: mini-taper de 3 días y 2 días de recuperación. Carreras C: se corren como entreno.

export type SeasonPhaseKind = 'base' | 'build' | 'peak' | 'taper' | 'race' | 'recovery' | 'general'

export type WeekType = 'load' | 'deload' | 'peak' | 'taper' | 'race' | 'recovery' | 'general'

export interface DateRange {
  from: string
  to: string
}

export interface SeasonPhase extends DateRange {
  kind: SeasonPhaseKind
  raceId: string | null   // carrera A hacia la que va (o de la que se recupera); null en 'general'
}

export interface RaceWindow {
  raceId: string
  name: string
  priority: RacePriority
  date: string
  endDate: string
  daysToRace: number
  taper: DateRange | null      // A: taper · B: mini-taper · C: ninguno
  recovery: DateRange | null
  warnings: string[]
}

export interface SeasonWeek {
  monday: string
  phase: SeasonPhaseKind
  type: WeekType
  loadPercent: number          // carga orientativa respecto a una semana normal de entreno (100)
  races: Array<{ id: string; name: string; priority: RacePriority; date: string }>
}

export interface SeasonPlan {
  today: string
  horizonEnd: string
  targetRace: RaceEvent | null   // próxima carrera A
  currentPhase: SeasonPhase | null
  phases: SeasonPhase[]
  races: RaceWindow[]
  weeks: SeasonWeek[]
  warnings: string[]
}

// ─── Parámetros ──────────────────────────────────────────────────────────────

export const TAPER_DAYS = 14
export const PEAK_DAYS = 14
export const BUILD_DAYS = 56
export const MIN_RUNWAY_DAYS = 56          // menos de 8 semanas hasta una A: aviso de poco margen
const GENERAL_HORIZON_DAYS = 12 * 7        // sin carrera A, se muestran 12 semanas
const MAX_WEEKS = 60
const B_MINI_TAPER_DAYS = 3
const DELOAD_EVERY = 4                     // 3 semanas de carga + 1 de descarga

// Recuperación tras una carrera (las vueltas por etapas, algo más)
function recoveryDays(race: RaceEvent): number {
  const stage = race.days >= 3
  switch (race.priority) {
    case 'A': return stage ? 10 : 7
    case 'B': return stage ? 4 : 2
    case 'C': return 1
  }
}

const LOAD_PERCENT: Record<WeekType, number> = {
  load: 100,
  deload: 60,
  peak: 90,
  taper: 70,
  race: 50,
  recovery: 40,
  general: 90,
}
const BUILD_LOAD_PERCENT = 110
const BUILD_DELOAD_PERCENT = 65
const B_RACE_WEEK_REDUCTION = 15
const B_REDUCED_WEEKS: WeekType[] = ['load', 'deload', 'peak', 'general']

// ─── Cálculo ─────────────────────────────────────────────────────────────────

export function buildSeasonPlan(allRaces: RaceEvent[], today: string): SeasonPlan {
  const races = [...allRaces].sort((a, b) => a.date.localeCompare(b.date) || a.priority.localeCompare(b.priority))
  const upcoming = races.filter(r => r.endDate >= today)
  const aRaces = upcoming.filter(r => r.priority === 'A')
  const warnings: string[] = []
  const phases: SeasonPhase[] = []

  const push = (kind: SeasonPhaseKind, from: string, to: string, raceId: string | null) => {
    if (to < from) return
    const last = phases[phases.length - 1]
    if (last && last.kind === kind && last.raceId === raceId && addDays(last.to, 1) === from) last.to = to
    else phases.push({ kind, from, to, raceId })
  }

  let cursor = today

  // Recuperándose de una carrera A reciente
  const recentA = races.filter(r => r.priority === 'A' && r.endDate < today).pop()
  if (recentA) {
    const recoveryEnd = addDays(recentA.endDate, recoveryDays(recentA))
    if (recoveryEnd >= today) {
      const nextA = aRaces[0]
      const end = nextA && nextA.date <= recoveryEnd ? addDays(nextA.date, -1) : recoveryEnd
      push('recovery', today, end, recentA.id)
      cursor = addDays(end, 1)
    }
  }

  aRaces.forEach((race, i) => {
    const prev = i > 0 ? aRaces[i - 1] : null
    const runway = daysBetween(cursor, race.date)

    if (runway < MIN_RUNWAY_DAYS && race.date > today) {
      warnings.push(prev
        ? `Entre ${prev.name} y ${race.name} hay ${weeksText(daysBetween(prev.endDate, race.date))}: no da para un ciclo completo. Tras recuperar, mantener la forma y afinar.`
        : `Quedan ${weeksText(runway)} para ${race.name}: poco margen para un ciclo completo. Se prioriza la parte específica y el taper.`)
    }

    const taperFrom = addDays(race.date, -TAPER_DAYS)
    const peakFrom = addDays(taperFrom, -PEAK_DAYS)
    const buildFrom = addDays(peakFrom, -BUILD_DAYS)
    const segments: Array<[SeasonPhaseKind, string, string]> = [
      ['base', cursor, addDays(buildFrom, -1)],
      ['build', buildFrom, addDays(peakFrom, -1)],
      ['peak', peakFrom, addDays(taperFrom, -1)],
      ['taper', taperFrom, addDays(race.date, -1)],
      ['race', race.date, race.endDate],
    ]
    for (const [kind, from, to] of segments) push(kind, from < cursor ? cursor : from, to, race.id)

    // Recuperación, recortada si la siguiente A está muy cerca
    const next = aRaces[i + 1]
    let recoveryEnd = addDays(race.endDate, recoveryDays(race))
    if (next && next.date <= recoveryEnd) {
      recoveryEnd = addDays(next.date, -1)
      warnings.push(`${race.name} y ${next.name} están muy juntas (${daysBetween(race.endDate, next.date)} días): no hay tiempo de recuperar del todo entre ellas.`)
    }
    const recoveryFrom = addDays(race.endDate, 1)
    push('recovery', recoveryFrom < cursor ? cursor : recoveryFrom, recoveryEnd, race.id)
    cursor = addDays(recoveryEnd, 1) > cursor ? addDays(recoveryEnd, 1) : cursor
  })

  // Después de la última A (o sin ninguna A): preparación general hasta cubrir las demás carreras
  const lastRace = upcoming[upcoming.length - 1]
  let horizonEnd = phases.length ? phases[phases.length - 1].to : addDays(today, GENERAL_HORIZON_DAYS - 1)
  if (aRaces.length === 0) {
    warnings.push('No hay ninguna carrera A: el plan es de preparación general. Define el objetivo principal para periodizar hacia él.')
  }
  if (lastRace) {
    const lastEnd = addDays(lastRace.endDate, recoveryDays(lastRace))
    if (lastEnd > horizonEnd) horizonEnd = lastEnd
  }
  if (phases.length === 0 || horizonEnd > phases[phases.length - 1].to) {
    push('general', cursor, horizonEnd, null)
  }

  const raceWindows = upcoming.map(r => raceWindow(r, today, phases, upcoming))
  raceWindows.forEach(w => warnings.push(...w.warnings.map(msg => `${w.name}: ${msg}`)))

  return {
    today,
    horizonEnd,
    targetRace: aRaces.find(r => r.endDate >= today) ?? null,
    currentPhase: phaseAt(phases, today),
    phases,
    races: raceWindows,
    weeks: buildWeeks(phases, upcoming, today, horizonEnd),
    warnings,
  }
}

export function phaseAt(phases: SeasonPhase[], key: string): SeasonPhase | null {
  return phases.find(p => p.from <= key && key <= p.to) ?? null
}

function raceWindow(race: RaceEvent, today: string, phases: SeasonPhase[], upcoming: RaceEvent[]): RaceWindow {
  const warnings: string[] = []
  let taper: DateRange | null = null
  const recovery: DateRange = { from: addDays(race.endDate, 1), to: addDays(race.endDate, recoveryDays(race)) }

  if (race.priority === 'A') {
    taper = { from: addDays(race.date, -TAPER_DAYS), to: addDays(race.date, -1) }
  } else {
    // Fase de la carrera A en la que cae una B o una C
    const phase = phaseAt(phases, race.date)
    const aName = (id: string | null) => upcoming.find(r => r.id === id)?.name ?? 'la carrera A'
    if (phase?.kind === 'taper' || phase?.kind === 'race') {
      warnings.push(`cae en el taper de ${aName(phase.raceId)}. ${race.priority === 'B' ? 'Mejor córrela como C (sin apretar) o descártala.' : 'Si la corres, sin apretar.'}`)
    } else if (phase?.kind === 'recovery') {
      warnings.push(`cae en la recuperación de ${aName(phase.raceId)}. Mejor no correrla o hacerla muy suave.`)
    }

    if (race.priority === 'B') {
      taper = { from: addDays(race.date, -B_MINI_TAPER_DAYS), to: addDays(race.date, -1) }
      const close = upcoming.find(o => o.id !== race.id && o.priority === 'B'
        && o.date > race.date && daysBetween(race.endDate, o.date) <= B_MINI_TAPER_DAYS + recoveryDays(race))
      if (close) warnings.push(`está muy cerca de ${close.name}: no hay tiempo para recuperar y hacer otro mini-taper. Elige cuál apretar.`)
    }
  }

  return {
    raceId: race.id,
    name: race.name,
    priority: race.priority,
    date: race.date,
    endDate: race.endDate,
    daysToRace: daysBetween(today, race.date),
    taper,
    recovery,
    warnings,
  }
}

function buildWeeks(phases: SeasonPhase[], races: RaceEvent[], today: string, horizonEnd: string): SeasonWeek[] {
  const weeks: SeasonWeek[] = []
  for (let monday = mondayKey(today); monday <= horizonEnd && weeks.length < MAX_WEEKS; monday = addDays(monday, 7)) {
    const sunday = addDays(monday, 6)

    // Fase predominante de la semana (en empate, la posterior)
    const days = new Map<SeasonPhase, number>()
    for (let d = monday; d <= sunday; d = addDays(d, 1)) {
      const p = phaseAt(phases, d)
      if (p) days.set(p, (days.get(p) ?? 0) + 1)
    }
    let phase: SeasonPhase | null = null
    for (const [p, n] of days) if (!phase || n >= days.get(phase)!) phase = p
    if (!phase) continue

    const weekRaces = races.filter(r => r.date <= sunday && r.endDate >= monday)
    const hasA = weekRaces.some(r => r.priority === 'A')

    let type: WeekType
    let loadPercent: number
    switch (phase.kind) {
      case 'base':
      case 'build': {
        // Descarga cada 4 semanas, contando hacia atrás desde el final de la fase (no se mueve con los días)
        const fromEnd = Math.floor(daysBetween(monday, mondayKey(phase.to)) / 7)
        const deload = fromEnd % DELOAD_EVERY === DELOAD_EVERY - 1
        type = deload ? 'deload' : 'load'
        loadPercent = phase.kind === 'build'
          ? (deload ? BUILD_DELOAD_PERCENT : BUILD_LOAD_PERCENT)
          : LOAD_PERCENT[type]
        break
      }
      case 'peak':     type = 'peak'; loadPercent = LOAD_PERCENT.peak; break
      case 'taper':    type = hasA ? 'race' : 'taper'; loadPercent = LOAD_PERCENT[type]; break
      case 'race':     type = 'race'; loadPercent = LOAD_PERCENT.race; break
      case 'recovery': type = 'recovery'; loadPercent = LOAD_PERCENT.recovery; break
      default:         type = 'general'; loadPercent = LOAD_PERCENT.general
    }
    if (hasA && type !== 'recovery') {
      type = 'race'
      loadPercent = LOAD_PERCENT.race
    } else if (weekRaces.some(r => r.priority === 'B') && B_REDUCED_WEEKS.includes(type)) {
      // Mini-taper de la B (en taper o recuperación de una A ya se va suave: se corre como C)
      loadPercent -= B_RACE_WEEK_REDUCTION
    }

    weeks.push({
      monday,
      phase: phase.kind,
      type,
      loadPercent,
      races: weekRaces.map(r => ({ id: r.id, name: r.name, priority: r.priority, date: r.date })),
    })
  }
  return weeks
}

function weeksText(days: number): string {
  const weeks = Math.floor(days / 7)
  if (weeks < 1) return `${days} días`
  return weeks === 1 ? '1 semana' : `${weeks} semanas`
}
