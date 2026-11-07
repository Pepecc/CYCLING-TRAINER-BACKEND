import { addDays, mondayKey } from './calendar'

// CTL (forma, media exponencial de 42 días del TSS diario), ATL (fatiga, 7 días) y TSB (frescura = CTL − ATL).
// El TSB de un día es el del final de ese día; la frescura con la que se llega a una carrera es la del día anterior.

export const CTL_DAYS = 42
export const ATL_DAYS = 7
// Historial que necesita el CTL para no arrancar en 0 (≈ 3 constantes de tiempo)
export const FITNESS_WARMUP_DAYS = 120

const CTL_K = 1 - Math.exp(-1 / CTL_DAYS)
const ATL_K = 1 - Math.exp(-1 / ATL_DAYS)

export interface Fitness {
  ctl: number
  atl: number
}

export function stepFitness(f: Fitness, tss: number): Fitness {
  return { ctl: f.ctl + CTL_K * (tss - f.ctl), atl: f.atl + ATL_K * (tss - f.atl) }
}

export function interpretTsb(tsb: number): string {
  if (tsb > 25)  return 'Forma pico — fresco y listo para competir'
  if (tsb > 10)  return 'Buena forma — descansado, buen momento para esfuerzos duros'
  if (tsb > -10) return 'En forma estable — equilibrio carga/recuperación'
  if (tsb > -20) return 'En carga — algo de fatiga acumulada, normal en bloque de trabajo'
  if (tsb > -30) return 'Carga alta — monitorizar recuperación, evitar esfuerzos máximos'
  return 'Sobreentrenamiento — recuperación urgente necesaria'
}

// ─── Proyección ──────────────────────────────────────────────────────────────

// actual: entrenos de Wahoo · planned: plan detallado (sesiones pendientes; un día sin sesiones es descanso)
// season: más allá del plan detallado, TSS medio semanal reciente × % de carga de la semana en el plan de temporada
export type LoadOrigin = 'actual' | 'planned' | 'season'

export interface FitnessPoint {
  date: string
  tss: number
  ctl: number
  atl: number
  tsb: number
  origin: LoadOrigin
}

export interface ProjectionInput {
  today: string
  historyStart: string                  // desde aquí se acumula la carga real (antes, CTL = ATL = 0)
  actualDaily: Map<string, number>      // TSS real por día, hasta hoy incluido
  plannedDaily: Map<string, number>     // TSS de las sesiones pendientes por día, desde hoy
  planEnd: string | null                // último día cubierto por el plan detallado
  horizon: string                       // último día de la proyección
  seasonWeeks: Array<{ monday: string; loadPercent: number }>
  baseWeeklyTss: number | null          // TSS de una semana normal (100 %); null = sin datos
}

export interface ProjectionSeries {
  history: FitnessPoint[]       // días anteriores a hoy (todo el historial acumulado)
  projection: FitnessPoint[]    // de hoy al horizonte
}

// % de carga si el plan de temporada no llega a esa semana (semana normal de preparación general)
const DEFAULT_SEASON_PERCENT = 90

export function projectFitness(input: ProjectionInput): ProjectionSeries {
  const history: FitnessPoint[] = []
  const projection: FitnessPoint[] = []
  const seasonPercent = new Map(input.seasonWeeks.map(w => [w.monday, w.loadPercent]))
  let f: Fitness = { ctl: 0, atl: 0 }

  for (let d = input.historyStart; d <= input.horizon; d = addDays(d, 1)) {
    let tss: number
    let origin: LoadOrigin
    if (d < input.today) {
      tss = input.actualDaily.get(d) ?? 0
      origin = 'actual'
    } else if (d === input.today) {
      const pending = input.plannedDaily.get(d) ?? 0
      tss = (input.actualDaily.get(d) ?? 0) + pending
      origin = pending > 0 ? 'planned' : 'actual'
    } else if (input.planEnd && d <= input.planEnd) {
      tss = input.plannedDaily.get(d) ?? 0
      origin = 'planned'
    } else {
      const pct = seasonPercent.get(mondayKey(d)) ?? DEFAULT_SEASON_PERCENT
      tss = input.baseWeeklyTss ? (input.baseWeeklyTss * pct) / 100 / 7 : 0
      origin = 'season'
    }
    f = stepFitness(f, tss)
    const point = { date: d, tss: Math.round(tss), ctl: round1(f.ctl), atl: round1(f.atl), tsb: round1(f.ctl - f.atl), origin }
    if (d < input.today) history.push(point)
    else projection.push(point)
  }
  return { history, projection }
}

// ─── Valoración ──────────────────────────────────────────────────────────────

export interface RaceCheckpoint {
  raceId: string
  name: string
  priority: 'A' | 'B' | 'C'
  date: string
  ctl: number            // forma con la que se llega (final del día anterior)
  atl: number
  tsb: number            // frescura con la que se llega
  targetTsb: [number, number] | null
  assessment: string
}

export interface ProjectionAssessment {
  races: RaceCheckpoint[]
  peakCtl: { date: string; ctl: number } | null
  minTsb: { date: string; tsb: number } | null
  warnings: string[]
}

// Frescura recomendada al llegar: A con taper completo; B con mini-taper; C se corre como entreno
export const TARGET_TSB: Record<'A' | 'B', [number, number]> = { A: [5, 25], B: [-5, 15] }
export const MAX_CTL_RAMP_PER_WEEK = 7
export const MIN_SAFE_TSB = -30

export function assessProjection(
  series: ProjectionSeries,
  races: Array<{ id: string; name: string; priority: 'A' | 'B' | 'C'; date: string }>
): ProjectionAssessment {
  const all = [...series.history, ...series.projection]
  const byDate = new Map(all.map(p => [p.date, p]))
  const proj = series.projection
  const warnings: string[] = []

  const checkpoints: RaceCheckpoint[] = []
  for (const r of races) {
    const entry = byDate.get(addDays(r.date, -1))
    if (!entry || !byDate.has(r.date)) continue
    const target = r.priority === 'C' ? null : TARGET_TSB[r.priority]
    let assessment: string
    if (!target) assessment = 'Carrera C: se corre como entreno, sin buscar frescura.'
    else if (entry.tsb < target[0]) {
      assessment = `Llegarías con fatiga (TSB ${fmt(entry.tsb)}; lo recomendable para una ${r.priority} es ${fmt(target[0])} a ${fmt(target[1])}). ` +
        (r.priority === 'A' ? 'Hay que bajar más la carga en el taper.' : 'Conviene un mini-taper más claro.')
    } else if (entry.tsb > target[1]) {
      assessment = `Llegarías demasiado fresco (TSB ${fmt(entry.tsb)}; recomendable ${fmt(target[0])} a ${fmt(target[1])}): se pierde forma. Se puede mantener algo más de carga.`
    } else {
      assessment = `Frescura adecuada (TSB ${fmt(entry.tsb)}, recomendable ${fmt(target[0])} a ${fmt(target[1])}).`
    }
    checkpoints.push({
      raceId: r.id, name: r.name, priority: r.priority, date: r.date,
      ctl: entry.ctl, atl: entry.atl, tsb: entry.tsb, targetTsb: target, assessment,
    })
    if (target && (entry.tsb < target[0] || entry.tsb > target[1])) warnings.push(`${r.name}: ${assessment}`)
  }

  let peakCtl: ProjectionAssessment['peakCtl'] = null
  let minTsb: ProjectionAssessment['minTsb'] = null
  for (const p of proj) {
    if (!peakCtl || p.ctl > peakCtl.ctl) peakCtl = { date: p.date, ctl: p.ctl }
    if (!minTsb || p.tsb < minTsb.tsb) minTsb = { date: p.date, tsb: p.tsb }
  }
  if (minTsb && minTsb.tsb < MIN_SAFE_TSB) {
    warnings.push(`El ${minTsb.date} el TSB bajaría a ${fmt(minTsb.tsb)}: demasiada fatiga acumulada, riesgo de sobrecarga.`)
  }

  // Subida de CTL demasiado rápida en el tramo del plan detallado (una vez, la primera semana que pase)
  for (let i = 7; i < proj.length; i++) {
    if (proj[i].origin !== 'planned') continue
    const before = byDate.get(addDays(proj[i].date, -7))
    if (before && proj[i].ctl - before.ctl > MAX_CTL_RAMP_PER_WEEK) {
      warnings.push(
        `La semana que acaba el ${proj[i].date} el CTL subiría ${fmt(proj[i].ctl - before.ctl)} puntos ` +
        `(más de ${MAX_CTL_RAMP_PER_WEEK} por semana es una subida de carga muy rápida).`
      )
      break
    }
  }

  return { races: checkpoints, peakCtl, minTsb, warnings }
}

export interface WeekFitness {
  monday: string
  tss: number
  ctl: number      // al final de la semana (o del último día proyectado)
  atl: number
  tsb: number
  origin: LoadOrigin   // la que más días tiene
}

export function weeklyFitness(points: FitnessPoint[]): WeekFitness[] {
  const weeks = new Map<string, FitnessPoint[]>()
  for (const p of points) {
    const key = mondayKey(p.date)
    const list = weeks.get(key)
    if (list) list.push(p)
    else weeks.set(key, [p])
  }
  return Array.from(weeks.entries()).map(([monday, ps]) => {
    const last = ps[ps.length - 1]
    const counts = new Map<LoadOrigin, number>()
    ps.forEach(p => counts.set(p.origin, (counts.get(p.origin) ?? 0) + 1))
    const origin = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0]
    return { monday, tss: ps.reduce((a, p) => a + p.tss, 0), ctl: last.ctl, atl: last.atl, tsb: last.tsb, origin }
  })
}

// TSS medio de las últimas `weeks` semanas completas (lunes a domingo) antes de hoy
export function averageWeeklyTss(actualDaily: Map<string, number>, today: string, weeks = 4): number {
  const end = addDays(mondayKey(today), -1)
  const start = addDays(end, -(weeks * 7) + 1)
  let total = 0
  for (const [d, tss] of actualDaily) if (d >= start && d <= end) total += tss
  return Math.round(total / weeks)
}

const round1 = (x: number) => Math.round(x * 10) / 10
const fmt = (x: number) => (x > 0 ? `+${Math.round(x)}` : String(Math.round(x)))
