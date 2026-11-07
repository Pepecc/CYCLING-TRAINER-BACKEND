import {
  ImportDraft, ImportFormatError, ImportParseResult, PlanImportParser, MAX_IMPORT_WORKOUTS,
} from '../../domain/planning/PlanImport'
import { PlannedWorkoutInput, StepKind, WorkoutFocus, WorkoutEnvironment } from '../../domain/planning/PlannedWorkout'
import { HR_THRESHOLD_HRR, LoadProfile } from '../../domain/training/trainingMetrics'

// Adaptador del JSON de entrenos de TrainingPeaks (lista de workouts, como la que devuelve su API
// o la exportación de un plan) al modelo propio. Solo se importa la parte planificada: título,
// descripción, día, duración / TSS previstos y la estructura (`structure`).
//
// Estructura de TrainingPeaks:
//   structure.structure[] = bloques { type: step | repetition | rampUp | rampDown, length: { value: N, unit: repetition }, steps[] }
//   step = { name, length: { value, unit: second }, targets: [{ minValue, maxValue, unit? }], intensityClass, openDuration, notes? }
//   Un target sin `unit` usa structure.primaryIntensityMetric (percentOfFtp en los planes de potencia);
//   el de unit roundOrStridePerMinute es la cadencia.

// ─── Tipos de entreno (workoutTypeValueId) ───────────────────────────────────

const TP_BIKE = 2
const TP_REST = 7
const TP_STRENGTH = 9
const TP_RACE = 6
const TP_MTB = 8
const BIKE_TYPES = [TP_BIKE, TP_MTB]

// ─── Límites del dominio que hay que respetar al convertir ───────────────────

const TITLE_MAX = 120
const DESCRIPTION_MAX = 4000
const STEP_NOTES_MAX = 300
const FTP_PCT: [number, number] = [30, 500]
const CADENCE: [number, number] = [30, 160]
const HR_BPM: [number, number] = [60, 230]
const MIN_STEP_SECONDS = 5

type Rec = Record<string, unknown>

const isRec = (v: unknown): v is Rec => !!v && typeof v === 'object' && !Array.isArray(v)
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const isStr = (v: unknown): v is string => typeof v === 'string'

export class TrainingPeaksParser implements PlanImportParser {
  readonly format = 'trainingpeaks'

  canParse(data: unknown): boolean {
    const list = toList(data)
    // A broken entry must not hide the format: it is reported in the preview
    const sample = list?.slice(0, 10) ?? []
    return sample.length > 0 &&
      sample.every(w => isRec(w) && ('workoutDay' in w || 'workoutTypeValueId' in w)) &&
      sample.some(w => isRec(w) && 'workoutDay' in w && 'workoutTypeValueId' in w)
  }

  parse(data: unknown, profile: LoadProfile | null): ImportParseResult {
    const list = toList(data)
    if (!list) throw new ImportFormatError('El fichero de TrainingPeaks debe ser una lista de entrenos')
    if (list.length === 0) throw new ImportFormatError('El fichero no tiene entrenos')
    if (list.length > MAX_IMPORT_WORKOUTS) {
      throw new ImportFormatError(`Como máximo ${MAX_IMPORT_WORKOUTS} entrenos por importación (el fichero tiene ${list.length})`)
    }

    // Same-day workouts keep TrainingPeaks' order (orderOnDay)
    const ordered = list
      .map((raw, index) => ({ raw, index }))
      .sort((a, b) => sortKey(a.raw).localeCompare(sortKey(b.raw)) || a.index - b.index)

    const drafts = ordered.map(({ raw, index }) => {
      try {
        return convertWorkout(raw, index, profile)
      } catch (err) {
        return { externalId: externalIdOf(raw), input: {}, warnings: [], error: `Entrada ${index + 1}: ${(err as Error).message}` }
      }
    })

    const warnings: string[] = []
    if (drafts.some(d => d.warnings.some(w => w.includes('FC máxima')))) {
      warnings.push('Hay objetivos de FC que no se han podido convertir: añade tu FC máxima y en reposo al perfil y vuelve a importar.')
    }
    return { format: this.format, drafts, warnings }
  }
}

function toList(data: unknown): unknown[] | null {
  if (Array.isArray(data)) return data
  if (isRec(data) && Array.isArray(data.workouts)) return data.workouts
  if (isRec(data) && 'workoutDay' in data) return [data]
  return null
}

function sortKey(raw: unknown): string {
  if (!isRec(raw)) return ''
  const day = isStr(raw.workoutDay) ? raw.workoutDay.slice(0, 10) : ''
  const order = isNum(raw.orderOnDay) ? raw.orderOnDay : 0
  return `${day}#${String(order).padStart(3, '0')}`
}

function externalIdOf(raw: unknown): string | null {
  return isRec(raw) && (isNum(raw.workoutId) || isStr(raw.workoutId)) ? `trainingpeaks:${raw.workoutId}` : null
}

// ─── Esquema ─────────────────────────────────────────────────────────────────
// Comprobación de la forma de cada entreno antes de convertirlo; los errores llevan la ruta del campo.

function checkWorkoutSchema(w: Rec): string[] {
  const errors: string[] = []
  if (!isStr(w.workoutDay) || !/^\d{4}-\d{2}-\d{2}/.test(w.workoutDay)) errors.push('workoutDay debe ser una fecha (AAAA-MM-DD...)')
  if (w.title != null && !isStr(w.title)) errors.push('title debe ser texto')
  if (w.description != null && !isStr(w.description)) errors.push('description debe ser texto')
  if (w.workoutTypeValueId != null && !isNum(w.workoutTypeValueId)) errors.push('workoutTypeValueId debe ser un número')
  for (const key of ['totalTimePlanned', 'tssPlanned']) {
    if (w[key] != null && !isNum(w[key])) errors.push(`${key} debe ser un número`)
  }
  return errors
}

function checkStructureSchema(s: unknown): string[] {
  if (!isRec(s)) return ['structure debe ser un objeto']
  if (!Array.isArray(s.structure)) return ['structure.structure debe ser una lista de bloques']
  const errors: string[] = []
  s.structure.forEach((b, i) => {
    const at = `structure.structure[${i}]`
    if (!isRec(b)) return errors.push(`${at} debe ser un objeto`)
    if (!isStr(b.type)) errors.push(`${at}.type falta`)
    if (b.length != null && (!isRec(b.length) || !isNum(b.length.value))) errors.push(`${at}.length.value debe ser un número`)
    if (!Array.isArray(b.steps) || b.steps.length === 0) return errors.push(`${at}.steps debe ser una lista no vacía`)
    b.steps.forEach((st, j) => {
      const sat = `${at}.steps[${j}]`
      if (!isRec(st)) return errors.push(`${sat} debe ser un objeto`)
      if (!isRec(st.length) || !isNum(st.length.value) || !isStr(st.length.unit)) errors.push(`${sat}.length debe ser { value, unit }`)
      if (st.targets != null && !Array.isArray(st.targets)) errors.push(`${sat}.targets debe ser una lista`)
      if (Array.isArray(st.targets)) {
        st.targets.forEach((t, k) => {
          if (!isRec(t) || (t.minValue != null && !isNum(t.minValue)) || (t.maxValue != null && !isNum(t.maxValue))) {
            errors.push(`${sat}.targets[${k}] debe tener minValue / maxValue numéricos`)
          }
        })
      }
    })
  })
  return errors
}

// ─── Conversión ──────────────────────────────────────────────────────────────

class StructureUnsupported extends Error {}

function convertWorkout(raw: unknown, index: number, profile: LoadProfile | null): ImportDraft {
  if (!isRec(raw)) throw new Error('no es un objeto')
  const externalId = externalIdOf(raw)
  const schemaErrors = checkWorkoutSchema(raw)
  if (schemaErrors.length) return { externalId, input: {}, warnings: [], error: `Entrada ${index + 1}: ${schemaErrors.join('; ')}` }

  const warnings: string[] = []
  const type = isNum(raw.workoutTypeValueId) ? raw.workoutTypeValueId : null
  const isBike = type !== null && BIKE_TYPES.includes(type)
  const date = (raw.workoutDay as string).slice(0, 10)

  // Title
  let title = (isStr(raw.title) ? raw.title : '').replace(/\s+/g, ' ').trim()
  if (!title) title = type === TP_REST ? 'Descanso' : type === TP_STRENGTH ? 'Fuerza' : 'Entreno'
  if (title.length > TITLE_MAX) {
    warnings.push(`Título recortado a ${TITLE_MAX} caracteres`)
    title = title.slice(0, TITLE_MAX - 1).trimEnd() + '…'
  }

  // Description (+ coach comments)
  const parts = [isStr(raw.description) ? raw.description.trim() : '']
  if (isStr(raw.coachComments) && raw.coachComments.trim()) parts.push(`Comentarios del entrenador: ${raw.coachComments.trim()}`)
  let description: string | null = parts.filter(Boolean).join('\n\n') || null
  if (description && description.length > DESCRIPTION_MAX) {
    warnings.push(`Descripción recortada a ${DESCRIPTION_MAX} caracteres`)
    description = description.slice(0, DESCRIPTION_MAX - 1).trimEnd() + '…'
  }

  // Structure
  let blocks: ConvertedBlock[] = []
  if (raw.structure != null && type !== TP_REST) {
    const structureErrors = checkStructureSchema(raw.structure)
    if (structureErrors.length) {
      warnings.push(`Estructura descartada (no tiene el formato esperado: ${structureErrors.slice(0, 3).join('; ')})`)
    } else {
      try {
        blocks = convertStructure(raw.structure as Rec, profile, warnings)
      } catch (err) {
        if (!(err instanceof StructureUnsupported)) throw err
        warnings.push(`Estructura descartada: ${err.message}`)
      }
    }
  }

  if (type !== null && !isBike && ![TP_REST, TP_STRENGTH, TP_RACE].includes(type)) {
    warnings.push(`Tipo ${type} de TrainingPeaks: se importa como "otro"`)
  }
  if (raw.totalTime != null || raw.tssActual != null) {
    warnings.push('Los datos realizados en TrainingPeaks no se importan (solo lo planificado)')
  }

  const focus = inferFocus(type, title, blocks)
  const input: PlannedWorkoutInput = {
    date,
    title,
    focus,
    environment: inferEnvironment(type, `${title} ${description ?? ''}`),
    description,
  }
  if (blocks.length > 0) {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    input.blocks = blocks.map(({ name, repeat, steps }) => ({ name, repeat, steps: steps.map(({ ftpPct, ...step }) => step) }))
  } else if (focus !== 'rest') {
    // No structure (strength, core, free ride): planned duration and TSS from TrainingPeaks
    if (isNum(raw.totalTimePlanned)) input.durationMinutes = Math.min(720, Math.round(raw.totalTimePlanned * 60))
    if (isNum(raw.tssPlanned)) input.tss = Math.min(1000, Math.max(0, Math.round(raw.tssPlanned)))
  }

  return { externalId, input, warnings, error: null }
}

interface ConvertedStep {
  kind: StepKind
  durationSeconds: number
  target: { type: string; min: number | null; max: number | null }
  cadenceMin: number | null
  cadenceMax: number | null
  notes: string | null
  ftpPct: number | null      // centro del objetivo en % FTP (para deducir el tipo de sesión)
}

interface ConvertedBlock {
  name: string | null
  repeat: number
  steps: ConvertedStep[]
}

function convertStructure(s: Rec, profile: LoadProfile | null, warnings: string[]): ConvertedBlock[] {
  const primary = isStr(s.primaryIntensityMetric) ? s.primaryIntensityMetric : 'percentOfFtp'
  const clamped = { value: false }
  const blocks = (s.structure as Rec[]).map(b => {
    const steps = (b.steps as Rec[]).map(st => convertStep(st, primary, profile, warnings, clamped))
    const isRepetition = b.type === 'repetition'
    const repeat = isRepetition && isRec(b.length) && isNum(b.length.value) ? Math.max(1, Math.round(b.length.value)) : 1
    // "active" steps: series inside repetitions, steady riding in single-step blocks below Z3
    for (const step of steps) {
      if (step.kind !== 'work') continue
      if (!isRepetition && steps.length === 1 && step.ftpPct !== null && step.ftpPct <= 75) step.kind = 'steady'
    }
    return { name: null, repeat, steps }
  })
  // A whole session in a single step (often tagged warmUp in TrainingPeaks) is steady riding
  const all = blocks.flatMap(b => b.steps)
  if (all.length === 1 && blocks[0].repeat === 1 && all[0].kind !== 'recovery') all[0].kind = 'steady'
  if (clamped.value) warnings.push(`Algún objetivo de % FTP se ha ajustado al rango ${FTP_PCT[0]}-${FTP_PCT[1]} %`)
  return blocks
}

function lengthSeconds(length: Rec): number {
  const value = length.value as number
  switch (String(length.unit).toLowerCase()) {
    case 'second': return value
    case 'minute': return value * 60
    case 'hour': return value * 3600
    default:
      throw new StructureUnsupported(`pasos por distancia u otra unidad (${String(length.unit)}); se usa la duración prevista`)
  }
}

const KIND_BY_CLASS: Record<string, StepKind> = {
  warmup: 'warmup',
  cooldown: 'cooldown',
  rest: 'recovery',
  recovery: 'recovery',
  active: 'work',
}

function convertStep(
  st: Rec, primary: string, profile: LoadProfile | null, warnings: string[], clamped: { value: boolean }
): ConvertedStep {
  const durationSeconds = Math.max(MIN_STEP_SECONDS, Math.round(lengthSeconds(st.length as Rec)))
  const kind = KIND_BY_CLASS[String(st.intensityClass ?? 'active').toLowerCase()] ?? 'work'

  let target: ConvertedStep['target'] = { type: 'open', min: null, max: null }
  let ftpPct: number | null = null
  let cadenceMin: number | null = null
  let cadenceMax: number | null = null

  for (const t of (Array.isArray(st.targets) ? st.targets : []) as Rec[]) {
    const min = isNum(t.minValue) ? t.minValue : null
    const max = isNum(t.maxValue) ? t.maxValue : min
    if (min === null && max === null) continue
    const metric = (isStr(t.unit) ? t.unit : primary).toLowerCase()

    if (metric.includes('stride') || metric.includes('cadence') || metric === 'rpm') {
      cadenceMin = clamp(min ?? max!, CADENCE)
      cadenceMax = clamp(max ?? min!, CADENCE)
      continue
    }
    if (target.type !== 'open') continue  // first intensity target wins

    const converted = convertIntensity(metric, min ?? max!, max ?? min!, profile, warnings, clamped)
    if (converted) {
      target = converted
      if (converted.type === 'ftp_percent') ftpPct = (converted.min! + converted.max!) / 2
    }
  }
  if (cadenceMin !== null && cadenceMax !== null && cadenceMin > cadenceMax) [cadenceMin, cadenceMax] = [cadenceMax, cadenceMin]

  const name = isStr(st.name) ? st.name.replace(/\s+/g, ' ').trim() : ''
  const extra = isStr(st.notes) ? st.notes.replace(/\s+/g, ' ').trim() : ''
  let notes = [name, extra && extra !== name ? extra : ''].filter(Boolean).join(' — ')
  if (st.openDuration === true) notes = [notes, 'duración orientativa (paso abierto)'].filter(Boolean).join(' · ')
  if (notes.length > STEP_NOTES_MAX) notes = notes.slice(0, STEP_NOTES_MAX - 1) + '…'

  return { kind, durationSeconds, target, cadenceMin, cadenceMax, notes: notes || null, ftpPct }
}

function convertIntensity(
  metric: string, min: number, max: number, profile: LoadProfile | null, warnings: string[], clamped: { value: boolean }
): ConvertedStep['target'] | null {
  const lo = Math.min(min, max)
  const hi = Math.max(min, max)

  if (metric.includes('ftp')) {
    const cMin = clamp(lo, FTP_PCT)
    const cMax = clamp(hi, FTP_PCT)
    if (cMin !== lo || cMax !== hi) clamped.value = true
    return { type: 'ftp_percent', min: cMin, max: cMax }
  }
  if (metric.includes('watt') || metric === 'power') {
    return { type: 'power_w', min: clamp(lo, [20, 2000]), max: clamp(hi, [20, 2000]) }
  }
  if (metric.includes('thresholdhr') || metric.includes('maxhr')) {
    const ref = metric.includes('maxhr') ? profile?.maxHr ?? null : thresholdHr(profile)
    if (!ref) {
      addOnce(warnings, 'Objetivos de FC en % sin convertir: faltan la FC máxima y en reposo en el perfil')
      return null
    }
    return { type: 'hr_bpm', min: clamp(Math.round((lo / 100) * ref), HR_BPM), max: clamp(Math.round((hi / 100) * ref), HR_BPM) }
  }
  if (metric.includes('heartrate') || metric.includes('bpm')) {
    return { type: 'hr_bpm', min: clamp(lo, HR_BPM), max: clamp(hi, HR_BPM) }
  }
  if (metric.includes('rpe')) {
    return { type: 'rpe', min: clamp(Math.round(lo), [1, 10]), max: clamp(Math.round(hi), [1, 10]) }
  }
  addOnce(warnings, `Objetivos de tipo "${metric}" (ritmo, velocidad...) no soportados: se importan como libres`)
  return null
}

// Threshold HR estimated as 85 % of the heart rate reserve (the same threshold the load model uses)
function thresholdHr(profile: LoadProfile | null): number | null {
  const { maxHr, restingHr } = profile ?? {}
  if (!maxHr || !restingHr || restingHr >= maxHr) return null
  return Math.round(restingHr + HR_THRESHOLD_HRR * (maxHr - restingHr))
}

function clamp(v: number, [lo, hi]: [number, number]): number {
  return Math.min(hi, Math.max(lo, v))
}

function addOnce(list: string[], msg: string): void {
  if (!list.includes(msg)) list.push(msg)
}

// ─── Tipo de sesión y entorno ────────────────────────────────────────────────

// Tiempo mínimo por encima de cada umbral (% FTP, centro del objetivo) para clasificar la sesión
const FOCUS_RULES: Array<[WorkoutFocus, number, number]> = [
  ['anaerobic', 121, 120],
  ['vo2max', 106, 180],
  ['threshold', 95, 300],
  ['sweet_spot', 88, 600],
  ['tempo', 76, 600],
]
const SPRINT_PCT = 150
const SPRINT_MAX_SECONDS = 30

function inferFocus(type: number | null, title: string, blocks: ConvertedBlock[]): WorkoutFocus {
  if (type === TP_REST) return 'rest'
  if (type === TP_STRENGTH) return 'strength'
  if (type === TP_RACE) return 'race'
  if (type !== null && !BIKE_TYPES.includes(type)) return 'other'
  if (/\btest|\btets\b|\bftp\b.*\btest/i.test(title)) return 'test'

  const steps = blocks.flatMap(b => b.steps.map(s => ({ ...s, total: s.durationSeconds * b.repeat })))
  const withPower = steps.filter(s => s.ftpPct !== null)
  const main = withPower.filter(s => s.kind !== 'recovery' && s.kind !== 'warmup' && s.kind !== 'cooldown')
  // Only warm-up / recovery steps (e.g. an easy spin tagged as warm-up): classify with all of them
  const measured = main.length > 0 ? main : withPower

  if (measured.length > 0) {
    const isSprint = (s: typeof steps[number]) => s.ftpPct! >= SPRINT_PCT && s.durationSeconds <= SPRINT_MAX_SECONDS
    for (const [focus, pct, minSeconds] of FOCUS_RULES) {
      const time = measured.filter(s => s.ftpPct! >= pct && !isSprint(s)).reduce((a, s) => a + s.total, 0)
      if (time >= minSeconds) return focus
    }
    if (measured.filter(isSprint).reduce((a, s) => a + s.total, 0) >= 20) return 'sprint'
    const avg = withPower.reduce((a, s) => a + s.ftpPct! * s.total, 0) / Math.max(1, withPower.reduce((a, s) => a + s.total, 0))
    return avg < 56 ? 'recovery' : 'endurance'
  }

  // No power targets: guess from the title
  const t = title.toLowerCase()
  if (/vo2|z5|z6/.test(t)) return 'vo2max'
  if (/umbral|z4/.test(t)) return 'threshold'
  if (/tempo|z3/.test(t)) return 'tempo'
  if (/recupera|z1/.test(t)) return 'recovery'
  if (/z2|resistencia|aer[oó]bic|fondo/.test(t)) return 'endurance'
  return blocks.length ? 'endurance' : 'other'
}

function inferEnvironment(type: number | null, text: string): WorkoutEnvironment {
  if (type === TP_MTB) return 'outdoor'
  if (type !== null && !BIKE_TYPES.includes(type)) return 'any'
  const t = text.toLowerCase()
  if (/rodillo|indoor|zwift|bici est[aá]tica|spinning/.test(t)) return 'indoor'
  return 'any'
}
