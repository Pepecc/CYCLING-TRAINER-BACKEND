import { PlannedWorkoutRepository } from '../../domain/planning/PlannedWorkoutRepository'
import { PlannedWorkout } from '../../domain/planning/PlannedWorkout'
import { ProtectedRange, ReplanResult, parseAvailableWeekdays, replanWeek } from '../../domain/planning/replanWeek'
import { CyclistProfileRepository } from '../../domain/profile/CyclistProfileRepository'
import { SeasonPlan } from '../../domain/events/seasonPlan'
import { addDays, dayKey, formatDayKey, mondayKey } from '../../domain/training/calendar'
import { LoadProfile } from '../../domain/training/trainingMetrics'
import { GetSeasonPlan } from '../events/GetSeasonPlan'
import { ReconcilePlan } from './ReconcilePlan'

export interface ReplanWeekResult extends ReplanResult {
  saved: boolean
  linked: boolean          // los estados se han actualizado con Wahoo
}

const NOTES_MAX = 1000

// Propone (y con save aplica) la replanificación de la semana actual tras saltarse entrenos
export class ReplanWeek {
  constructor(
    private readonly plannedWorkouts: PlannedWorkoutRepository,
    private readonly profiles: CyclistProfileRepository,
    private readonly reconcile: ReconcilePlan,
    private readonly getSeasonPlan: GetSeasonPlan
  ) {}

  async execute(userId: string, save: boolean): Promise<ReplanWeekResult> {
    const today = dayKey(new Date())
    const monday = mondayKey(today)
    const sunday = addDays(monday, 6)

    const outcome = await this.reconcile.execute(userId, monday, today)
    const [week, profile, season] = await Promise.all([
      this.plannedWorkouts.findBetween(userId, monday, sunday),
      this.profiles.findByUserId(userId),
      this.loadSeason(userId),
    ])
    week.forEach(w => w.recalculateLoad(profile))

    const trainedToday = week.some(w => w.completion?.date === today)
      || outcome.unplanned.some(a => dayKey(new Date(a.startedAt)) === today)

    const result = replanWeek({
      today,
      week,
      availableWeekdays: parseAvailableWeekdays(profile?.availableDays),
      weekType: season?.weeks.find(w => w.monday === monday)?.type ?? null,
      protectedRanges: season ? protectedRanges(season) : [],
      trainedToday,
      profile,
    })
    if (!outcome.linked) {
      result.notes.push('Wahoo no está conectado o no tiene entrenos: solo se tienen en cuenta los entrenos marcados a mano como saltados.')
    }

    if (save) await this.apply(userId, result, profile)
    return { ...result, saved: save, linked: outcome.linked }
  }

  private async apply(userId: string, result: ReplanResult, profile: LoadProfile | null): Promise<void> {
    const toSave: PlannedWorkout[] = []
    const toDelete: PlannedWorkout[] = []
    for (const c of result.changes) {
      if (c.kind === 'move') {
        const note = `Movido desde el ${formatDayKey(c.from, { weekday: 'long', day: 'numeric', month: 'long' })} (no se hizo).`
        c.workout.update({ date: c.to, status: 'planned', notes: appendNote(c.workout.notes, note) }, profile)
        toSave.push(c.workout)
        if (c.replaces) toDelete.push(c.replaces)
      } else if (c.kind === 'extend') {
        const note = `Ampliado ${c.addMinutes} min para recuperar parte de "${c.recovers.title}".`
        c.workout.update({ ...c.patch, notes: appendNote(c.workout.notes, note) }, profile)
        toSave.push(c.workout)
      }
    }
    if (toSave.length) await this.plannedWorkouts.saveMany(toSave)
    for (const w of toDelete) await this.plannedWorkouts.delete(userId, w.id)
  }

  private async loadSeason(userId: string): Promise<SeasonPlan | null> {
    try {
      return await this.getSeasonPlan.execute(userId)
    } catch (err) {
      console.error('Season plan for the week replanning failed:', err)
      return null
    }
  }
}

// Days where no new quality session goes: A taper, B mini-taper, race days and recovery; the day after a C
function protectedRanges(season: SeasonPlan): ProtectedRange[] {
  const ranges: ProtectedRange[] = []
  for (const r of season.races) {
    ranges.push({ from: r.date, to: r.endDate, reason: `carrera ${r.name}` })
    if (r.taper) ranges.push({ ...r.taper, reason: `${r.priority === 'A' ? 'taper' : 'mini-taper'} de ${r.name}` })
    if (r.recovery) ranges.push({ ...r.recovery, reason: `recuperación de ${r.name}` })
  }
  return ranges
}

function appendNote(current: string | null, note: string): string {
  const text = current ? `${current}\n${note}` : note
  return text.length > NOTES_MAX ? text.slice(text.length - NOTES_MAX) : text
}
