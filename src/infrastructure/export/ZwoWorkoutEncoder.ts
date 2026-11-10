import type { PlannedWorkout, WorkoutStep } from '../../domain/planning/PlannedWorkout'
import {
  ExportProfile, ExportedFile, WorkoutFileEncoder, HR_ZONE_FTP_FRACTION, POWER_ZONE_PCT,
  hrZonesBpm, targetText, exportFileName,
} from '../../domain/planning/workoutExport'

// Fichero .zwo (XML de Zwift, que también leen otras apps de rodillo). Solo admite potencia en fracción del FTP:
// los objetivos de FC y RPE se pasan a una potencia orientativa y el texto del paso dice el objetivo original.

const FALLBACK = 0.6

// [low, high] as a fraction of FTP, or null for a free ride
function powerRange(s: WorkoutStep, profile: ExportProfile | null): [number, number] | null {
  const t = s.target
  const lo = t.min ?? 0
  const hi = t.max ?? lo
  switch (t.type) {
    case 'power_zone':
      return [POWER_ZONE_PCT[lo - 1][0] / 100, Math.min(POWER_ZONE_PCT[hi - 1][1], 160) / 100]
    case 'ftp_percent':
      return [lo / 100, hi / 100]
    case 'power_w':
      return profile?.ftp ? [lo / profile.ftp, hi / profile.ftp] : [FALLBACK, FALLBACK]
    case 'hr_zone':
      return [HR_ZONE_FTP_FRACTION[lo - 1], HR_ZONE_FTP_FRACTION[hi - 1]]
    case 'hr_bpm': {
      const zones = hrZonesBpm(profile)
      if (!zones) return [FALLBACK, FALLBACK]
      const zoneOf = (bpm: number) => Math.max(0, zones.findIndex(([, max]) => bpm <= max))
      return [HR_ZONE_FTP_FRACTION[zoneOf(lo)], HR_ZONE_FTP_FRACTION[zoneOf(hi)]]
    }
    case 'rpe':
      return [0.4 + 0.065 * lo, 0.4 + 0.065 * hi]
    case 'open':
    default:
      return null
  }
}

const f2 = (x: number) => (Math.round(x * 100) / 100).toFixed(2)
const mid = ([a, b]: [number, number]) => (a + b) / 2

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function stepMessage(s: WorkoutStep): string | null {
  const parts = [targetText(s.target), s.notes].filter(Boolean)
  return parts.length ? parts.join(' · ') : null
}

function cadenceAttr(s: WorkoutStep): string {
  if (!s.cadenceMin) return ''
  return ` Cadence="${Math.round((s.cadenceMin + (s.cadenceMax ?? s.cadenceMin)) / 2)}"`
}

function element(s: WorkoutStep, profile: ExportProfile | null): string {
  const range = powerRange(s, profile)
  const msg = stepMessage(s)
  const text = msg ? `<textevent timeoffset="0" message="${esc(msg)}"/>` : ''
  const d = s.durationSeconds
  let open: string
  if (!range) open = `<FreeRide Duration="${d}"${cadenceAttr(s)}`
  else if (s.kind === 'warmup') open = `<Warmup Duration="${d}" PowerLow="${f2(range[0])}" PowerHigh="${f2(range[1])}"${cadenceAttr(s)}`
  else if (s.kind === 'cooldown') open = `<Cooldown Duration="${d}" PowerLow="${f2(range[1])}" PowerHigh="${f2(range[0])}"${cadenceAttr(s)}`
  else open = `<SteadyState Duration="${d}" Power="${f2(mid(range))}"${cadenceAttr(s)}`
  const tag = open.slice(1, open.indexOf(' '))
  return text ? `${open}>${text}</${tag}>` : `${open}/>`
}

export class ZwoWorkoutEncoder implements WorkoutFileEncoder {
  readonly format = 'zwo' as const

  encode(w: PlannedWorkout, profile: ExportProfile | null): ExportedFile {
    const warnings: string[] = []
    const steps = w.blocks.flatMap(b => b.steps)
    if (steps.some(s => s.target.type === 'hr_zone' || s.target.type === 'hr_bpm')) {
      warnings.push('El formato .zwo solo admite potencia: los objetivos de FC se han pasado a un % del FTP orientativo (el texto de cada paso dice la zona de FC). Para la estática con pulsómetro, usa el .fit.')
    }
    if (steps.some(s => s.target.type === 'power_w') && !profile?.ftp) {
      warnings.push('Sin FTP en el perfil, los pasos en vatios no se pueden pasar a % del FTP: van al 60 %.')
    }

    const lines: string[] = []
    for (const b of w.blocks) {
      const [on, off] = b.steps
      const onRange = on ? powerRange(on, profile) : null
      const offRange = off ? powerRange(off, profile) : null
      if (b.repeat > 1 && b.steps.length === 2 && onRange && offRange) {
        // Native intervals: "repeat × (on + off)"
        const msg = stepMessage(on)
        const text = msg ? `<textevent timeoffset="0" message="${esc(msg)}"/>` : ''
        const open = `<IntervalsT Repeat="${b.repeat}" OnDuration="${on.durationSeconds}" OffDuration="${off.durationSeconds}" ` +
          `OnPower="${f2(mid(onRange))}" OffPower="${f2(mid(offRange))}"${cadenceAttr(on)}`
        lines.push(text ? `${open}>${text}</IntervalsT>` : `${open}/>`)
        continue
      }
      for (let i = 0; i < b.repeat; i++) for (const s of b.steps) lines.push(element(s, profile))
    }

    const description = [w.description, w.notes].filter(Boolean).join('\n\n')
    const xml = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<workout_file>',
      '  <author>Cycling Coach</author>',
      `  <name>${esc(w.title)}</name>`,
      `  <description>${esc(description)}</description>`,
      '  <sportType>bike</sportType>',
      '  <tags/>',
      '  <workout>',
      ...lines.map(l => `    ${l}`),
      '  </workout>',
      '</workout_file>',
      '',
    ].join('\n')

    return {
      filename: exportFileName(w, 'zwo'),
      contentType: 'application/xml; charset=utf-8',
      data: Buffer.from(xml, 'utf8'),
      warnings,
    }
  }
}
