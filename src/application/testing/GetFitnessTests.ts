import { PlannedWorkout } from '../../domain/planning/PlannedWorkout'
import { PlannedWorkoutRepository } from '../../domain/planning/PlannedWorkoutRepository'
import { CyclistProfileRepository } from '../../domain/profile/CyclistProfileRepository'
import { FitnessTestRepository } from '../../domain/testing/FitnessTestRepository'
import { FTP_PROTOCOLS, FTP_TEST_EVERY_DAYS, FitnessTestResultProps } from '../../domain/testing/fitnessTest'
import { addDays, dayKey, daysBetween } from '../../domain/training/calendar'
import { GetSeasonPlan } from '../events/GetSeasonPlan'

export interface TestDue {
  due: boolean
  reason: string
  suggestedDate: string | null    // final de la próxima semana de descarga (descansado), si la hay
}

export interface FitnessTestsOverview {
  tests: FitnessTestResultProps[]
  lastFtpTest: FitnessTestResultProps | null
  lastMaxHrTest: FitnessTestResultProps | null
  scheduled: PlannedWorkout[]       // tests programados de hoy en adelante
  ftp: TestDue
  heartRate: TestDue
}

const SCHEDULED_AHEAD_DAYS = 120

export class GetFitnessTests {
  constructor(
    private readonly tests: FitnessTestRepository,
    private readonly plannedWorkouts: PlannedWorkoutRepository,
    private readonly profiles: CyclistProfileRepository,
    private readonly getSeasonPlan: GetSeasonPlan
  ) {}

  async execute(userId: string): Promise<FitnessTestsOverview> {
    const today = dayKey(new Date())
    const [tests, upcoming, profile, suggestedDate] = await Promise.all([
      this.tests.findAll(userId),
      this.plannedWorkouts.findBetween(userId, today, addDays(today, SCHEDULED_AHEAD_DAYS)),
      this.profiles.findByUserId(userId),
      this.nextRestedDay(userId, today),
    ])
    const scheduled = upcoming.filter(w => w.focus === 'test' && w.status === 'planned')
    const lastFtpTest = tests.find(t => FTP_PROTOCOLS.includes(t.protocol)) ?? null
    const lastMaxHrTest = tests.find(t => t.protocol === 'max_hr') ?? null

    const ftpScheduled = scheduled.find(w => w.testProtocol && FTP_PROTOCOLS.includes(w.testProtocol))
    let ftp: TestDue
    if (ftpScheduled) {
      ftp = { due: false, reason: `Test de FTP ya programado el ${ftpScheduled.date}.`, suggestedDate: null }
    } else if (!lastFtpTest) {
      ftp = {
        due: true,
        reason: profile?.ftp
          ? `No hay ningún test de FTP registrado (el FTP del perfil, ${profile.ftp} W, se dio a mano).`
          : 'No hay FTP en el perfil ni ningún test registrado.',
        suggestedDate,
      }
    } else {
      const age = daysBetween(lastFtpTest.date, today)
      ftp = age >= FTP_TEST_EVERY_DAYS
        ? { due: true, reason: `El último test de FTP fue hace ${Math.floor(age / 7)} semanas (conviene cada 6-8).`, suggestedDate }
        : { due: false, reason: `Último test de FTP hace ${Math.floor(age / 7)} semanas: toca dentro de unas ${Math.ceil((FTP_TEST_EVERY_DAYS - age) / 7)}.`, suggestedDate: null }
    }

    const hrScheduled = scheduled.find(w => w.testProtocol === 'max_hr')
    const heartRate: TestDue = hrScheduled
      ? { due: false, reason: `Test de FC máxima programado el ${hrScheduled.date}.`, suggestedDate: null }
      : !profile?.maxHr
        ? { due: true, reason: 'Falta la FC máxima en el perfil: sin ella no hay zonas de FC ni hrTSS.', suggestedDate }
        : !profile.restingHr
          ? { due: true, reason: 'Falta la FC en reposo: regístrala con los check-ins al despertar.', suggestedDate: null }
          : { due: false, reason: lastMaxHrTest ? `FC máxima del test del ${lastMaxHrTest.date}.` : 'FC máxima y en reposo en el perfil.', suggestedDate: null }

    return { tests, lastFtpTest, lastMaxHrTest, scheduled, ftp, heartRate }
  }

  // Saturday of the next deload or recovery week of the season plan (the cyclist arrives rested)
  private async nextRestedDay(userId: string, today: string): Promise<string | null> {
    try {
      const season = await this.getSeasonPlan.execute(userId)
      const week = season.weeks.find(w => (w.type === 'deload' || w.type === 'recovery') && addDays(w.monday, 5) >= today)
      return week ? addDays(week.monday, 5) : null
    } catch (err) {
      console.error('Season plan for the test suggestion failed:', err)
      return null
    }
  }
}
