import { PlannedWorkout, PlanSource, ENVIRONMENTS, WorkoutEnvironment, PlanValidationError } from '../../domain/planning/PlannedWorkout'
import { PlannedWorkoutRepository } from '../../domain/planning/PlannedWorkoutRepository'
import { CyclistProfileRepository } from '../../domain/profile/CyclistProfileRepository'
import { FTP_PROTOCOLS, FitnessTestError, PROTOCOLS, parseProtocol, protocolBlocks } from '../../domain/testing/fitnessTest'

export interface ScheduleTestResult {
  workout: PlannedWorkout
  warnings: string[]
}

// Puts a fitness test in the plan as a structured session (focus 'test' with its protocol)
export class ScheduleFitnessTest {
  constructor(
    private readonly plannedWorkouts: PlannedWorkoutRepository,
    private readonly profiles: CyclistProfileRepository
  ) {}

  // Throws FitnessTestError or PlanValidationError
  async execute(
    userId: string,
    input: { protocol: unknown; date: unknown; environment?: unknown },
    source: PlanSource
  ): Promise<ScheduleTestResult> {
    const protocol = parseProtocol(input.protocol)
    const info = PROTOCOLS[protocol]
    if (!info.schedulable) {
      throw new FitnessTestError('La FC en reposo no es una sesión: se mide al despertar varios días (check-in diario) y se registra el resultado')
    }
    let environment: WorkoutEnvironment = info.environment
    if (input.environment !== undefined && input.environment !== null) {
      if (!ENVIRONMENTS.includes(input.environment as WorkoutEnvironment)) {
        throw new PlanValidationError(`Entorno no válido: ${String(input.environment)} (valores: ${ENVIRONMENTS.join(', ')})`)
      }
      environment = input.environment as WorkoutEnvironment
    }

    const profile = await this.profiles.findByUserId(userId)
    const workout = PlannedWorkout.create(
      userId,
      {
        date: input.date,
        title: info.title,
        focus: 'test',
        environment,
        description: info.instructions,
        blocks: protocolBlocks(protocol, profile?.ftp ?? null),
        notes: `Resultado: ${info.input}.`,
      },
      source,
      profile
    )
    workout.setTestProtocol(protocol)

    const warnings: string[] = []
    if (FTP_PROTOCOLS.includes(protocol)) {
      warnings.push('Necesita potenciómetro o rodillo con potencia: en la bici estática solo con pulsómetro no sirve (para la FC, usa el test de FC máxima).')
    }
    if (protocol === 'max_hr' && !profile?.restingHr) {
      warnings.push('Sin FC en reposo en el perfil no se calculan las zonas de FC: regístrala también (check-in al despertar).')
    }
    const sameDay = (await this.plannedWorkouts.findBetween(userId, workout.date, workout.date)).filter(w => w.focus !== 'rest')
    if (sameDay.length) {
      warnings.push(`Ese día ya hay ${sameDay.map(w => `"${w.title}"`).join(', ')} en el plan: el test debería ser la única sesión del día (mueve o quita la otra).`)
    }

    await this.plannedWorkouts.saveMany([workout])
    return { workout, warnings }
  }
}
