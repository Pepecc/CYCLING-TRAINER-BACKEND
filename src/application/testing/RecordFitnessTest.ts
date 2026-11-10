import { PlannedWorkout, PlannedWorkoutNotFoundError } from '../../domain/planning/PlannedWorkout'
import { PlannedWorkoutRepository } from '../../domain/planning/PlannedWorkoutRepository'
import { CyclistProfile, CyclistProfileFields } from '../../domain/profile/CyclistProfile'
import { CyclistProfileRepository } from '../../domain/profile/CyclistProfileRepository'
import { CheckInRepository } from '../../domain/wellness/CheckInRepository'
import { FitnessTestRepository } from '../../domain/testing/FitnessTestRepository'
import {
  FIELD_LABELS, FitnessTestError, PROTOCOLS, TestOutcome, TestProtocol,
  computeTestOutcome, createTestResult, parseProtocol, parseTestDate,
} from '../../domain/testing/fitnessTest'
import { addDays } from '../../domain/training/calendar'
import { UpdateProfile } from '../profile/UpdateProfile'

export interface ZoneRow { zone: string; name: string; min: number; max: number | null }

export interface RecordTestResult {
  saved: boolean
  date: string
  outcome: TestOutcome
  zonesBefore: ZoneRow[] | null
  zonesAfter: ZoneRow[] | null
  plannedWorkout: PlannedWorkout | null   // test del plan enlazado (marcado como hecho al guardar)
  note: string | null                     // de dónde sale el dato (p. ej. media de los check-ins)
}

export interface RecordTestInput {
  protocol?: unknown
  value?: unknown            // dato medido (potencia o FC); en resting_hr, por defecto la media de los check-ins
  date?: unknown
  plannedWorkoutId?: unknown
  notes?: unknown
}

const RESTING_HR_DAYS = 7
const MIN_CHECKINS = 3

// Records a fitness test: preview (save false) or update the profile — and with it the zones and the planned TSS
export class RecordFitnessTest {
  constructor(
    private readonly tests: FitnessTestRepository,
    private readonly plannedWorkouts: PlannedWorkoutRepository,
    private readonly profiles: CyclistProfileRepository,
    private readonly checkIns: CheckInRepository,
    private readonly updateProfile: UpdateProfile
  ) {}

  // Throws FitnessTestError, PlannedWorkoutNotFoundError or ProfileValidationError
  async execute(userId: string, input: RecordTestInput, save: boolean): Promise<RecordTestResult> {
    let planned: PlannedWorkout | null = null
    if (typeof input.plannedWorkoutId === 'string' && input.plannedWorkoutId.trim()) {
      planned = await this.plannedWorkouts.findById(userId, input.plannedWorkoutId.trim())
      if (!planned) throw new PlannedWorkoutNotFoundError()
      if (planned.focus !== 'test') throw new FitnessTestError('Ese entreno del plan no es un test')
    }

    const date = parseTestDate(input.date ?? planned?.date)
    const protocolRaw = input.protocol ?? planned?.testProtocol
    if (protocolRaw === undefined || protocolRaw === null) {
      throw new FitnessTestError('Indica qué test es (ftp_20min, ftp_8min, ramp, max_hr o resting_hr)')
    }
    const protocol = parseProtocol(protocolRaw)

    // Without an explicit planned workout, link the test scheduled that day (if any)
    if (!planned) planned = await this.findScheduled(userId, date, protocol)

    let value = input.value
    let note: string | null = null
    if ((value === undefined || value === null || value === '') && protocol === 'resting_hr') {
      const avg = await this.morningHrAverage(userId, date)
      if (avg) {
        value = avg.value
        note = `Media de la FC al despertar de ${avg.days} check-ins de los últimos ${RESTING_HR_DAYS} días.`
      }
    }

    const profile = (await this.profiles.findByUserId(userId)) ?? CyclistProfile.create(userId)
    const outcome = computeTestOutcome(protocol, value, profile)
    const after = new CyclistProfile({ ...profile, userId, [outcome.field]: outcome.value })

    const result: RecordTestResult = {
      saved: false,
      date,
      outcome,
      zonesBefore: zonesOf(profile, outcome.field),
      zonesAfter: zonesOf(after, outcome.field),
      plannedWorkout: planned,
      note,
    }
    if (!save) return result

    await this.updateProfile.execute({ userId, [outcome.field]: outcome.value } as { userId: string } & Partial<CyclistProfileFields>)
    const notes = typeof input.notes === 'string' && input.notes.trim() ? input.notes.trim().slice(0, 500) : null
    await this.tests.save(createTestResult(userId, date, outcome, planned?.id ?? null, notes))

    if (planned) {
      const line = `Resultado: ${outcome.measured} ${PROTOCOLS[protocol].unit} → ${FIELD_LABELS[outcome.field]} ${outcome.value} ${PROTOCOLS[protocol].unit === 'W' ? 'W' : 'ppm'}.`
      const previousNotes = (planned.notes ?? '').replace(/^Resultado: .*$/m, '').trim()
      const updatedProfile = await this.profiles.findByUserId(userId)
      planned.update(
        { status: planned.status === 'planned' || planned.status === 'skipped' ? 'done' : undefined, notes: [line, previousNotes].filter(Boolean).join('\n') },
        updatedProfile
      )
      await this.plannedWorkouts.saveMany([planned])
    }
    return { ...result, saved: true }
  }

  private async findScheduled(userId: string, date: string, protocol: TestProtocol): Promise<PlannedWorkout | null> {
    const sameDay = await this.plannedWorkouts.findBetween(userId, date, date)
    return sameDay.find(w => w.focus === 'test' && w.testProtocol === protocol)
      ?? sameDay.find(w => w.focus === 'test' && w.testProtocol === null)
      ?? null
  }

  private async morningHrAverage(userId: string, date: string): Promise<{ value: number; days: number } | null> {
    const list = (await this.checkIns.findBetween(userId, addDays(date, -(RESTING_HR_DAYS - 1)), date))
      .filter(c => c.morningHr !== null)
    if (list.length < MIN_CHECKINS) return null
    return { value: Math.round(list.reduce((s, c) => s + c.morningHr!, 0) / list.length), days: list.length }
  }
}

function zonesOf(p: CyclistProfile, field: TestOutcome['field']): ZoneRow[] | null {
  if (field === 'ftp') {
    const z = p.powerZones
    return z ? Object.entries(z).map(([k, v]) => ({ zone: k.toUpperCase(), name: v.name, min: v.min, max: v.max })) : null
  }
  return p.heartRateZones?.map(z => ({ zone: z.zone, name: z.name, min: z.min, max: z.max })) ?? null
}
