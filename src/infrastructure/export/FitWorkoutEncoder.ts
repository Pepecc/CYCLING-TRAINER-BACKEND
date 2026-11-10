import type { PlannedWorkout, StepKind, WorkoutStep } from '../../domain/planning/PlannedWorkout'
import {
  ExportProfile, ExportedFile, WorkoutFileEncoder, ResolvedTarget,
  resolveTarget, targetText, exportFileName, STEP_LABELS,
} from '../../domain/planning/workoutExport'

// Fichero FIT de tipo "workout" (entreno estructurado), el formato que cargan el ELEMNT y los Garmin.
// Codificado a mano según el FIT protocol (sin dependencias): cabecera de 14 bytes, mensajes file_id, workout
// y workout_step, y CRC-16 al final. Las repeticiones usan un paso "repeat_until_steps_cmplt".

const FIT_EPOCH_S = 631065600            // 1989-12-31T00:00:00Z
const PROFILE_VERSION = 2132
const PROTOCOL_VERSION = 0x20            // 2.0

// Base types
const ENUM = 0x00, UINT16 = 0x84, UINT32 = 0x86, UINT32Z = 0x8c, STRING = 0x07

// Global message numbers
const MSG_FILE_ID = 0, MSG_WORKOUT = 26, MSG_WORKOUT_STEP = 27

// Enums of the FIT profile
const FILE_WORKOUT = 5
const MANUFACTURER_DEVELOPMENT = 255
const SPORT_CYCLING = 2
const SUB_SPORT = { generic: 0, indoor: 6, road: 7 }
const DURATION_TIME = 0, DURATION_REPEAT = 6
const TARGET_HR = 1, TARGET_OPEN = 2, TARGET_POWER = 4
const INTENSITY: Record<StepKind, number> = { work: 0, steady: 0, warmup: 2, cooldown: 3, recovery: 4 }

const STEP_NAME_BYTES = 32
const NOTES_BYTES = 64
const WORKOUT_NAME_BYTES = 40

type Field = [num: number, size: number, baseType: number]

const INVALID: Record<number, number> = { [ENUM]: 0xff, [UINT16]: 0xffff, [UINT32]: 0xffffffff, [UINT32Z]: 0 }

class FitWriter {
  private readonly bytes: number[] = []
  private readonly defs = new Map<number, Field[]>()

  define(local: number, globalNum: number, fields: Field[]): void {
    this.defs.set(local, fields)
    this.bytes.push(0x40 | local, 0, 0)                        // header, reserved, little endian
    this.u16(globalNum)
    this.bytes.push(fields.length)
    for (const [num, size, type] of fields) this.bytes.push(num, size, type)
  }

  // One value per field of the definition; null = invalid value
  write(local: number, values: Array<number | string | null>): void {
    const fields = this.defs.get(local)!
    this.bytes.push(local)
    fields.forEach(([, size, type], i) => {
      const v = values[i]
      if (type === STRING) return this.str(typeof v === 'string' ? v : '', size)
      const n = typeof v === 'number' ? v : INVALID[type]
      if (size === 1) this.bytes.push(n & 0xff)
      else if (size === 2) this.u16(n)
      else this.u32(n)
    })
  }

  finish(): Buffer {
    const header = Buffer.alloc(14)
    header.writeUInt8(14, 0)
    header.writeUInt8(PROTOCOL_VERSION, 1)
    header.writeUInt16LE(PROFILE_VERSION, 2)
    header.writeUInt32LE(this.bytes.length, 4)
    header.write('.FIT', 8, 'ascii')
    header.writeUInt16LE(crc16(header.subarray(0, 12)), 12)
    const data = Buffer.from(this.bytes)
    const crc = Buffer.alloc(2)
    crc.writeUInt16LE(crc16(Buffer.concat([header, data])), 0)
    return Buffer.concat([header, data, crc])
  }

  private u16(n: number): void { this.bytes.push(n & 0xff, (n >>> 8) & 0xff) }
  private u32(n: number): void { this.bytes.push(n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff) }

  // UTF-8, cut on a character boundary, null-terminated and padded to the field size
  private str(s: string, size: number): void {
    let out = Buffer.alloc(0)
    for (const ch of s) {
      const next = Buffer.concat([out, Buffer.from(ch, 'utf8')])
      if (next.length > size - 1) break
      out = next
    }
    const padded = Buffer.alloc(size)
    out.copy(padded)
    this.bytes.push(...padded)
  }
}

const CRC_TABLE = [
  0x0000, 0xcc01, 0xd801, 0x1400, 0xf001, 0x3c00, 0x2800, 0xe401,
  0xa001, 0x6c00, 0x7800, 0xb401, 0x5000, 0x9c01, 0x8801, 0x4400,
]

export function crc16(buf: Uint8Array): number {
  let crc = 0
  for (const byte of buf) {
    let tmp = CRC_TABLE[crc & 0xf]
    crc = (crc >> 4) & 0x0fff
    crc = crc ^ tmp ^ CRC_TABLE[byte & 0xf]
    tmp = CRC_TABLE[crc & 0xf]
    crc = (crc >> 4) & 0x0fff
    crc = crc ^ tmp ^ CRC_TABLE[(byte >> 4) & 0xf]
  }
  return crc
}

// [target_type, target_value, custom_low, custom_high]; a single value is widened to a small range
function encodeTarget(t: ResolvedTarget): [number, number | null, number | null, number | null] {
  const widen = (lo: number, hi: number, by: number) => (lo === hi ? [Math.max(0, lo - by), hi + by] : [lo, hi])
  switch (t.kind) {
    case 'ftp_percent': {        // 0-1000 = % of the device's FTP
      const [lo, hi] = widen(t.low, t.high, 2)
      return [TARGET_POWER, 0, lo, hi]
    }
    case 'watts': {              // > 1000 = watts + 1000
      const [lo, hi] = widen(t.low, t.high, 5)
      return [TARGET_POWER, 0, lo + 1000, hi + 1000]
    }
    case 'bpm': {                // > 100 = bpm + 100
      const [lo, hi] = widen(t.low, t.high, 3)
      return [TARGET_HR, 0, lo + 100, hi + 100]
    }
    case 'hr_zone':
      return [TARGET_HR, t.zone, null, null]
    case 'open':
      return [TARGET_OPEN, 0, null, null]
  }
}

function stepNotes(s: WorkoutStep): string {
  const parts = [targetText(s.target), s.cadenceMin ? `${s.cadenceMin}${s.cadenceMax && s.cadenceMax !== s.cadenceMin ? `-${s.cadenceMax}` : ''} rpm` : null, s.notes]
  return parts.filter(Boolean).join(' · ')
}

export class FitWorkoutEncoder implements WorkoutFileEncoder {
  readonly format = 'fit' as const

  encode(w: PlannedWorkout, profile: ExportProfile | null): ExportedFile {
    const warnings: string[] = []
    const steps = w.blocks.flatMap(b => b.steps)
    if (steps.some(s => s.target.type === 'rpe')) {
      warnings.push('Los pasos por RPE van sin objetivo en el dispositivo: el esfuerzo se indica en el texto del paso.')
    }
    if (steps.some(s => s.target.type === 'hr_zone') && !(profile?.maxHr && profile.restingHr)) {
      warnings.push('Sin FC máxima y en reposo en el perfil, los pasos por zona de FC usan las zonas configuradas en el dispositivo.')
    }
    if (steps.some(s => s.target.type === 'power_zone' || s.target.type === 'ftp_percent')) {
      warnings.push('Los objetivos de potencia van en % del FTP: el dispositivo usa el FTP que tenga configurado (revisa que coincide con el del perfil).')
    }

    const fit = new FitWriter()
    fit.define(0, MSG_FILE_ID, [[0, 1, ENUM], [1, 2, UINT16], [2, 2, UINT16], [3, 4, UINT32Z], [4, 4, UINT32]])
    const created = Math.floor(Date.now() / 1000) - FIT_EPOCH_S
    fit.write(0, [FILE_WORKOUT, MANUFACTURER_DEVELOPMENT, 1, (created % 0xfffffffe) + 1, created])

    // Steps first, to know how many there are
    type Row = Array<number | string | null>
    const rows: Row[] = []
    for (const block of w.blocks) {
      const first = rows.length
      for (const s of block.steps) {
        const [type, value, low, high] = encodeTarget(resolveTarget(s.target, profile))
        const name = block.name && block.repeat === 1 && block.steps.length === 1 ? block.name : STEP_LABELS[s.kind]
        rows.push([rows.length, name, DURATION_TIME, s.durationSeconds * 1000, type, value, low, high, INTENSITY[s.kind], stepNotes(s)])
      }
      if (block.repeat > 1) {
        // Back to the block's first step until it has been done `repeat` times
        rows.push([rows.length, block.name ?? `${block.repeat} repeticiones`, DURATION_REPEAT, first, null, block.repeat, null, null, null, ''])
      }
    }

    const sub = w.environment === 'indoor' ? SUB_SPORT.indoor : w.environment === 'outdoor' ? SUB_SPORT.road : SUB_SPORT.generic
    fit.define(1, MSG_WORKOUT, [[4, 1, ENUM], [11, 1, ENUM], [6, 2, UINT16], [8, WORKOUT_NAME_BYTES, STRING]])
    fit.write(1, [SPORT_CYCLING, sub, rows.length, w.title])

    fit.define(2, MSG_WORKOUT_STEP, [
      [254, 2, UINT16],              // message_index
      [0, STEP_NAME_BYTES, STRING],  // wkt_step_name
      [1, 1, ENUM],                  // duration_type
      [2, 4, UINT32],                // duration_value (ms, or the step to repeat from)
      [3, 1, ENUM],                  // target_type
      [4, 4, UINT32],                // target_value (zone, or repetitions)
      [5, 4, UINT32],                // custom_target_value_low
      [6, 4, UINT32],                // custom_target_value_high
      [7, 1, ENUM],                  // intensity
      [8, NOTES_BYTES, STRING],      // notes
    ])
    rows.forEach(r => fit.write(2, r))

    return {
      filename: exportFileName(w, 'fit'),
      contentType: 'application/vnd.ant.fit',
      data: fit.finish(),
      warnings,
    }
  }
}
