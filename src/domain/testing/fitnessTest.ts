import { randomUUID } from 'crypto'
import type { WorkoutBlock, WorkoutEnvironment, WorkoutStep, StepTarget } from '../planning/PlannedWorkout'
import { addDays, dayKey } from '../training/calendar'

// Tests de rendimiento que actualizan el perfil (FTP o FC) y, con él, las zonas.
// Potencia: 20 min (95 %), 2 × 8 min (90 %) o rampa (75 % del mejor minuto). FC: máxima y en reposo.

export type TestProtocol = 'ftp_20min' | 'ftp_8min' | 'ramp' | 'max_hr' | 'resting_hr'
export type TestedField = 'ftp' | 'maxHr' | 'restingHr'

export const TEST_PROTOCOLS: TestProtocol[] = ['ftp_20min', 'ftp_8min', 'ramp', 'max_hr', 'resting_hr']
export const FTP_PROTOCOLS: TestProtocol[] = ['ftp_20min', 'ftp_8min', 'ramp']

export interface ProtocolInfo {
  title: string
  field: TestedField
  factor: number                     // resultado = valor medido × factor
  input: string                      // qué hay que medir
  unit: 'W' | 'ppm'
  range: [number, number]            // valores medidos admitidos
  environment: WorkoutEnvironment    // dónde se hace
  schedulable: boolean               // tiene sesión estructurada que se puede poner en el plan
  instructions: string
}

export const PROTOCOLS: Record<TestProtocol, ProtocolInfo> = {
  ftp_20min: {
    title: 'Test FTP 20 min',
    field: 'ftp', factor: 0.95, unit: 'W', range: [60, 800], environment: 'outdoor', schedulable: true,
    input: 'potencia media de los 20 minutos del test',
    instructions: 'Tras el calentamiento y las activaciones, 20 minutos al máximo sostenible con ritmo constante (sin salir demasiado fuerte). ' +
      'Mejor en una subida larga o un llano sin cruces, y con potenciómetro. FTP = 95 % de la potencia media de los 20 minutos.',
  },
  ftp_8min: {
    title: 'Test FTP 2 × 8 min',
    field: 'ftp', factor: 0.90, unit: 'W', range: [60, 900], environment: 'outdoor', schedulable: true,
    input: 'media de la potencia media de las dos series de 8 minutos',
    instructions: 'Dos series de 8 minutos al máximo sostenible con 10 minutos suaves entre ellas. ' +
      'Más llevadero que el de 20 minutos; algo menos preciso en ciclistas de fondo. FTP = 90 % de la media de las dos series.',
  },
  ramp: {
    title: 'Test de rampa',
    field: 'ftp', factor: 0.75, unit: 'W', range: [100, 1200], environment: 'indoor', schedulable: true,
    input: 'potencia media del mejor minuto (el último que completaste entero)',
    instructions: 'Escalones de 1 minuto que suben hasta que no puedas mantener la potencia. Necesita rodillo o bici con potencia ' +
      '(en la estática solo con pulsómetro no sirve). FTP = 75 % del mejor minuto. Tiende a sobrestimar el FTP en ciclistas muy anaeróbicos.',
  },
  max_hr: {
    title: 'Test de FC máxima',
    field: 'maxHr', factor: 1, unit: 'ppm', range: [120, 230], environment: 'indoor', schedulable: true,
    input: 'FC más alta que marcó el pulsómetro',
    instructions: 'Solo si estás sano, descansado y sin molestias. Calentamiento largo, bloques progresivos y un último minuto a tope: ' +
      'la FC máxima suele salir al final del esfuerzo o justo después. Actualiza la FC máxima y con ella las zonas de FC.',
  },
  resting_hr: {
    title: 'FC en reposo',
    field: 'restingHr', factor: 1, unit: 'ppm', range: [30, 110], environment: 'any', schedulable: false,
    input: 'FC en reposo: media de varias mañanas, tumbado y nada más despertar',
    instructions: 'Mide la FC al despertar, antes de levantarte, varios días seguidos y usa la media (los check-ins diarios la recogen). ' +
      'Actualiza la FC en reposo y con ella las zonas de FC.',
  },
}

export const FIELD_LABELS: Record<TestedField, string> = { ftp: 'FTP', maxHr: 'FC máxima', restingHr: 'FC en reposo' }

// Cada cuánto conviene repetir el test de FTP (y tras una descarga, descansado)
export const FTP_TEST_EVERY_DAYS = 56

export class FitnessTestError extends Error {}

export function parseProtocol(value: unknown): TestProtocol {
  if (typeof value !== 'string' || !TEST_PROTOCOLS.includes(value as TestProtocol)) {
    throw new FitnessTestError(`Protocolo de test no válido: ${String(value)} (valores: ${TEST_PROTOCOLS.join(', ')})`)
  }
  return value as TestProtocol
}

// ─── Resultado ───────────────────────────────────────────────────────────────

export interface TestOutcome {
  protocol: TestProtocol
  field: TestedField
  measured: number
  value: number              // nuevo valor del perfil
  previous: number | null    // valor del perfil antes del test
  changePercent: number | null
  warnings: string[]
}

export interface ProfileValues { ftp: number | null; maxHr: number | null; restingHr: number | null }

// Throws FitnessTestError
export function computeTestOutcome(protocol: TestProtocol, measuredRaw: unknown, profile: ProfileValues): TestOutcome {
  const info = PROTOCOLS[protocol]
  const n = typeof measuredRaw === 'string' && measuredRaw.trim() !== '' ? Number(measuredRaw.replace(',', '.')) : measuredRaw
  if (typeof n !== 'number' || !Number.isFinite(n) || n < info.range[0] || n > info.range[1]) {
    throw new FitnessTestError(`Falta el resultado o no es válido: ${info.input}, entre ${info.range[0]} y ${info.range[1]} ${info.unit}`)
  }
  const measured = Math.round(n)
  const value = Math.round(measured * info.factor)
  const previous = profile[info.field]
  const changePercent = previous ? Math.round(((value - previous) / previous) * 1000) / 10 : null

  const warnings: string[] = []
  if (info.field === 'ftp' && (value < 50 || value > 600)) {
    throw new FitnessTestError(`El FTP calculado (${value} W) está fuera de rango (50-600 W): revisa el dato medido`)
  }
  if (info.field === 'ftp' && changePercent !== null && Math.abs(changePercent) > 15) {
    warnings.push(`El FTP cambia un ${Math.abs(changePercent)} %: es mucho para un test. Comprueba que el dato es el del esfuerzo del test (no la media de toda la sesión).`)
  }
  if (info.field === 'maxHr') {
    if (previous && value < previous) {
      warnings.push(`Es más baja que la FC máxima del perfil (${previous} ppm). Si no llegaste al máximo, mejor no actualizarla.`)
    }
    if (profile.restingHr && value <= profile.restingHr + 40) {
      throw new FitnessTestError('La FC máxima no es coherente con la FC en reposo del perfil')
    }
  }
  if (info.field === 'restingHr') {
    if (profile.maxHr && value >= profile.maxHr - 40) {
      throw new FitnessTestError('La FC en reposo no es coherente con la FC máxima del perfil')
    }
    if (previous && Math.abs(value - previous) >= 8) {
      warnings.push(`Cambia ${Math.abs(value - previous)} ppm respecto al perfil: usa la media de varias mañanas, no un solo día.`)
    }
  }
  return { protocol, field: info.field, measured, value, previous, changePercent, warnings }
}

// ─── Historial ───────────────────────────────────────────────────────────────

export interface FitnessTestResultProps {
  id: string
  userId: string
  date: string
  protocol: TestProtocol
  field: TestedField
  measured: number
  value: number
  previous: number | null
  plannedWorkoutId: string | null
  notes: string | null
  createdAt: string
}

export function createTestResult(
  userId: string, date: string, outcome: TestOutcome, plannedWorkoutId: string | null, notes: string | null
): FitnessTestResultProps {
  return {
    id: randomUUID(),
    userId,
    date,
    protocol: outcome.protocol,
    field: outcome.field,
    measured: outcome.measured,
    value: outcome.value,
    previous: outcome.previous,
    plannedWorkoutId,
    notes,
    createdAt: new Date().toISOString(),
  }
}

export function parseTestDate(value: unknown): string {
  const today = dayKey(new Date())
  if (value === undefined || value === null || value === '') return today
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T12:00:00Z`))) {
    throw new FitnessTestError('La fecha debe tener el formato AAAA-MM-DD')
  }
  if (value > today) throw new FitnessTestError('El resultado de un test solo se puede registrar el día del test o después')
  if (value < addDays(today, -366)) throw new FitnessTestError('La fecha del test es de hace más de un año')
  return value
}

// ─── Sesiones estructuradas ──────────────────────────────────────────────────

const step = (kind: WorkoutStep['kind'], minutes: number, target: StepTarget, notes: string | null = null): WorkoutStep => ({
  kind, durationSeconds: Math.round(minutes * 60), target, cadenceMin: null, cadenceMax: null, notes,
})
const pz = (min: number, max = min): StepTarget => ({ type: 'power_zone', min, max })
const hz = (min: number, max = min): StepTarget => ({ type: 'hr_zone', min, max })
const ftpPct = (min: number, max = min): StepTarget => ({ type: 'ftp_percent', min, max })
const rpe = (min: number, max = min): StepTarget => ({ type: 'rpe', min, max })

// Structure of the test session (for the plan and the exported file). ftp: to size the ramp without FTP.
export function protocolBlocks(protocol: TestProtocol, ftp: number | null): WorkoutBlock[] {
  const warmup: WorkoutBlock[] = [
    { name: 'Calentamiento', repeat: 1, steps: [step('warmup', 15, pz(1, 2))] },
    { name: 'Activaciones', repeat: 3, steps: [step('work', 1, ftpPct(100, 110), 'Activación, sin vaciarte'), step('recovery', 1, pz(1))] },
    { name: null, repeat: 1, steps: [step('recovery', 5, pz(1))] },
  ]
  const cooldown = (min = 10): WorkoutBlock => ({ name: 'Vuelta a la calma', repeat: 1, steps: [step('cooldown', min, pz(1))] })

  switch (protocol) {
    case 'ftp_20min':
      return [
        ...warmup,
        { name: 'Test', repeat: 1, steps: [step('work', 20, rpe(9, 10), 'Máximo sostenible y constante; los 5 primeros minutos, contenido')] },
        cooldown(),
      ]
    case 'ftp_8min':
      return [
        ...warmup,
        { name: 'Test', repeat: 1, steps: [
          step('work', 8, rpe(9, 10), 'Serie 1: máximo sostenible'),
          step('recovery', 10, pz(1), 'Suave, recupera bien'),
          step('work', 8, rpe(9, 10), 'Serie 2: máximo sostenible'),
        ] },
        cooldown(),
      ]
    case 'ramp': {
      // 1-minute steps until failure: +6 % FTP from 50 %, or +20 W from 100 W without FTP
      const steps: WorkoutStep[] = Array.from({ length: 20 }, (_, i) => ftp
        ? step('work', 1, ftpPct(50 + 6 * i), i === 0 ? 'Sube cada minuto hasta que no puedas mantener la potencia' : null)
        : step('work', 1, { type: 'power_w', min: 100 + 20 * i, max: 100 + 20 * i }, i === 0 ? 'Sube cada minuto hasta que no puedas mantener la potencia' : null))
      return [
        { name: 'Calentamiento', repeat: 1, steps: [step('warmup', 10, pz(1, 2))] },
        { name: 'Rampa', repeat: 1, steps },
        cooldown(),
      ]
    }
    case 'max_hr':
      return [
        { name: 'Calentamiento', repeat: 1, steps: [step('warmup', 15, hz(1, 2))] },
        { name: 'Progresivo', repeat: 1, steps: [
          step('steady', 5, hz(3)),
          step('steady', 4, hz(4)),
          step('work', 3, hz(5), 'Sube la intensidad cada minuto'),
          step('work', 1, rpe(10), 'A tope: la FC máxima suele salir al final'),
        ] },
        cooldown(),
      ]
    case 'resting_hr':
      return []
  }
}
