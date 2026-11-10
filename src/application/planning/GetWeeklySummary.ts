import { PlanValidationError } from '../../domain/planning/PlannedWorkout'
import { WorkoutRepository } from '../../domain/wahoo/WorkoutRepository'
import { CyclistProfileRepository } from '../../domain/profile/CyclistProfileRepository'
import { SeasonPlan } from '../../domain/events/seasonPlan'
import { addDays, dayKey, mondayKey } from '../../domain/training/calendar'
import { workoutTss } from '../../domain/training/trainingMetrics'
import { FITNESS_WARMUP_DAYS, Fitness, averageWeeklyTss, stepFitness } from '../../domain/training/fitness'
import { ActualSession, FitnessSnapshot, WeeklySummary, buildWeeklySummary } from '../../domain/planning/weeklySummary'
import { GetSeasonPlan } from '../events/GetSeasonPlan'
import { GetDailyCheckIns } from '../wellness/GetDailyCheckIns'
import { GetTrainingPlan } from './GetTrainingPlan'
import { ReconcilePlan } from './ReconcilePlan'

const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/
const MAX_PAST_DAYS = 366

// Weekly summary: planned vs done, check-ins, form and a recommendation for the next week
export class GetWeeklySummary {
  constructor(
    private readonly reconcile: ReconcilePlan,
    private readonly getPlan: GetTrainingPlan,
    private readonly workouts: WorkoutRepository,
    private readonly profiles: CyclistProfileRepository,
    private readonly getCheckIns: GetDailyCheckIns,
    private readonly getSeasonPlan: GetSeasonPlan
  ) {}

  // week: any day of the week (default: the current one). Throws PlanValidationError.
  async execute(userId: string, week?: string | null): Promise<WeeklySummary> {
    const today = dayKey(new Date())
    if (week && (!DATE_KEY.test(week) || Number.isNaN(Date.parse(`${week}T12:00:00Z`)))) {
      throw new PlanValidationError(`Fecha no válida: ${week} (formato AAAA-MM-DD)`)
    }
    const monday = mondayKey(week || today)
    if (monday > mondayKey(today)) throw new PlanValidationError('El resumen es de la semana actual o de semanas pasadas')
    if (monday < addDays(today, -MAX_PAST_DAYS)) throw new PlanValidationError('El resumen solo llega a las semanas del último año')
    const sunday = addDays(monday, 6)
    const lastDay = sunday < today ? sunday : today

    // Fresh statuses first (it also syncs Wahoo); the summary must work without Wahoo
    let linked = false
    try {
      linked = (await this.reconcile.execute(userId, monday, lastDay)).linked
    } catch (err) {
      console.error('Weekly summary reconciliation failed:', err)
    }

    const historyStart = addDays(monday, -FITNESS_WARMUP_DAYS)
    const [plan, nextPlan, all, profile, checkIns, season] = await Promise.all([
      this.getPlan.execute(userId, monday, sunday),
      this.getPlan.execute(userId, addDays(monday, 7), addDays(monday, 13)),
      this.workouts.findSince(userId, new Date(`${addDays(historyStart, -1)}T00:00:00Z`)),
      this.profiles.findByUserId(userId),
      this.getCheckIns.execute(userId, monday, lastDay),
      this.loadSeason(userId),
    ])

    // Real load per local day, for CTL / ATL / TSB at the start and the end of the week
    const daily = new Map<string, number>()
    const actuals: ActualSession[] = []
    for (const a of all) {
      const d = dayKey(new Date(a.startedAt))
      if (d < historyStart || d > lastDay) continue
      const tss = workoutTss(a, profile).tss
      daily.set(d, (daily.get(d) ?? 0) + (tss ?? 0))
      if (d >= monday) actuals.push({ id: a.id, date: d, name: a.name, minutes: a.durationMinutes, tss, inPlan: false })
    }
    let f: Fitness = { ctl: 0, atl: 0 }
    let fitnessStart: FitnessSnapshot = { ctl: 0, atl: 0, tsb: 0 }
    for (let d = historyStart; d <= lastDay; d = addDays(d, 1)) {
      f = stepFitness(f, daily.get(d) ?? 0)
      if (d === addDays(monday, -1)) fitnessStart = snapshot(f)
    }

    const nextSessions = nextPlan.workouts.filter(w => w.focus !== 'rest' && w.status !== 'skipped')
    const seasonWeek = (m: string) => season?.weeks.find(w => w.monday === m) ?? null

    return buildWeeklySummary({
      monday,
      today,
      linked,
      planned: plan.workouts,
      actuals: actuals.sort((a, b) => a.date.localeCompare(b.date)),
      wellness: {
        days: checkIns.averages.days,
        fatigue: checkIns.averages.fatigue,
        sleepHours: checkIns.averages.sleepHours,
        feeling: checkIns.averages.feeling,
        soreness: checkIns.averages.soreness,
        levels: checkIns.checkIns.map(c => c.readiness.level),
      },
      fitnessStart,
      fitnessEnd: snapshot(f),
      season: seasonWeek(monday),
      nextSeason: seasonWeek(addDays(monday, 7)),
      nextWeek: {
        sessions: nextSessions.length,
        tss: Math.round(nextSessions.reduce((s, w) => s + (w.plannedTss ?? 0), 0)),
        minutes: nextSessions.reduce((s, w) => s + (w.durationMinutes ?? 0), 0),
      },
      baseWeeklyTss: averageWeeklyTss(daily, monday) || null,
    })
  }

  private async loadSeason(userId: string): Promise<SeasonPlan | null> {
    try {
      return await this.getSeasonPlan.execute(userId)
    } catch (err) {
      console.error('Season plan for the weekly summary failed:', err)
      return null
    }
  }
}

const snapshot = (f: Fitness): FitnessSnapshot => ({
  ctl: Math.round(f.ctl * 10) / 10,
  atl: Math.round(f.atl * 10) / 10,
  tsb: Math.round((f.ctl - f.atl) * 10) / 10,
})
