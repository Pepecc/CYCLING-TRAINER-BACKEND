// One-off migration: free-text `profile.targetEvents` → `users/{uid}/events` (fase 7.6).
// Usage: npm run db:migrate-events [-- --dry-run] [-- --allow-production]
// Idempotent: a race with the same name and date is not created twice. What can't be parsed
// (no recognisable date) stays in `profile.targetEvents` and is reported, to move it by hand or from the chat.
import 'dotenv/config'
import { FieldValue } from 'firebase-admin/firestore'

import { getFirestore } from '../src/infrastructure/firebase/firebaseAdmin'
import { FirestoreRaceEventRepository } from '../src/infrastructure/persistence/firestore/FirestoreRaceEventRepository'
import { RaceEvent, RaceValidationError } from '../src/domain/events/RaceEvent'
import { dayKey } from '../src/domain/training/calendar'

export interface ParsedEvent {
  name: string
  date: string
}

const MONTHS: Record<string, number> = {
  enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6, julio: 7, agosto: 8,
  septiembre: 9, setiembre: 9, octubre: 10, noviembre: 11, diciembre: 12,
}

// 2027-06-19 · 19/06/2027 · 19-6-27 · 19.06.2027 · 19 de junio de 2027 · 19 junio (año siguiente si ya pasó)
const DATE_RE = new RegExp(
  '(\\d{4})-(\\d{1,2})-(\\d{1,2})' +
  '|(\\d{1,2})[/.\\-](\\d{1,2})[/.\\-](\\d{2,4})' +
  `|(\\d{1,2})\\s+(?:de\\s+)?(${Object.keys(MONTHS).join('|')})(?:\\s+(?:de\\s+|del\\s+)?(\\d{4}))?`,
  'gi'
)

const NOTE = 'Importada del perfil: revisa la prioridad, el tipo, la distancia y el desnivel.'

function cleanName(text: string): string {
  let s = text
  let prev = ''
  while (s !== prev) {
    prev = s
    s = s
      .replace(/^[\s,;:|·.()\-–—]+/, '')
      .replace(/^(?:y|e|el|la|los|las)\s+/i, '')
      .replace(/[\s,;:|·(\-–—]+$/, '')
      .replace(/\s+(?:el|el día|día|del|de|en|on)$/i, '')
  }
  return s.trim()
}

function toKey(year: number, month: number, day: number): string | null {
  const key = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
  const d = new Date(`${key}T12:00:00Z`)
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== key ? null : key
}

function matchToKey(m: RegExpExecArray, today: string): string | null {
  if (m[1]) return toKey(+m[1], +m[2], +m[3])
  if (m[4]) {
    const year = m[6].length === 2 ? 2000 + +m[6] : +m[6]
    return toKey(year, +m[5], +m[4])
  }
  const day = +m[7]
  const month = MONTHS[m[8].toLowerCase()]
  if (m[9]) return toKey(+m[9], month, day)
  const thisYear = +today.slice(0, 4)
  const key = toKey(thisYear, month, day)
  return key && key >= today ? key : toKey(thisYear + 1, month, day)
}

// "Quebrantahuesos 19/06/2027, Marcha de Bielsa (B) el 5 de septiembre" → events + leftover text
export function parseLegacyEvents(text: string, today: string): { events: ParsedEvent[]; unparsed: string[] } {
  const events: ParsedEvent[] = []
  const unparsed: string[] = []
  const matches = Array.from(text.matchAll(DATE_RE))
  let cursor = 0

  matches.forEach((m, i) => {
    const start = m.index!
    const end = start + m[0].length
    const date = matchToKey(m, today)
    // The name is the last piece before the date; earlier pieces without a date can't be migrated
    const pieces = text.slice(cursor, start).split(/[,;\n|]/)
    let name = cleanName(pieces.pop() ?? '')
    pieces.map(cleanName).filter(Boolean).forEach(p => unparsed.push(p))
    cursor = end

    if (!name) {
      // "19/06/2027 Quebrantahuesos": the name comes after the date, up to the next separator
      const nextStart = i + 1 < matches.length ? matches[i + 1].index! : text.length
      const after = text.slice(end, nextStart)
      const piece = after.split(/[,;\n|]/)[0]
      name = cleanName(piece)
      cursor = end + piece.length
    }

    if (!date || !name) unparsed.push(m[0] + (name ? ` ${name}` : ''))
    else events.push({ name, date })
  })

  const rest = cleanName(text.slice(cursor))
  if (rest) unparsed.push(rest)
  return { events, unparsed }
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run')
  if (!process.env.FIRESTORE_EMULATOR_HOST && !process.argv.includes('--allow-production')) {
    throw new Error('FIRESTORE_EMULATOR_HOST no está configurada. Para migrar el Firestore real, añade --allow-production')
  }

  const db = getFirestore()
  const repo = new FirestoreRaceEventRepository(db)
  const today = dayKey(new Date())
  const users = await db.collection('users').get()
  let created = 0
  let usersWithEvents = 0

  for (const doc of users.docs) {
    const text = doc.get('profile.targetEvents')
    if (typeof text !== 'string' || !text.trim()) continue
    usersWithEvents++

    const { events, unparsed } = parseLegacyEvents(text, today)
    const existing = await repo.findAll(doc.id)
    const toSave: RaceEvent[] = []
    for (const e of events) {
      if (existing.some(x => x.date === e.date && x.name.toLowerCase() === e.name.toLowerCase())) continue
      try {
        toSave.push(RaceEvent.create(doc.id, { name: e.name, date: e.date, priority: 'A', type: 'other', notes: NOTE }))
      } catch (err) {
        if (!(err instanceof RaceValidationError)) throw err
        unparsed.push(`${e.name} ${e.date} (${err.message})`)
      }
    }

    console.log(`· ${doc.id}: "${text}"`)
    toSave.forEach(e => console.log(`    + ${e.name} — ${e.date} (A)`))
    if (unparsed.length) console.log(`    ! sin migrar: ${unparsed.join(' | ')}`)

    if (dryRun) continue
    await repo.saveMany(toSave)
    created += toSave.length
    await doc.ref.update({ 'profile.targetEvents': unparsed.length ? unparsed.join('; ') : FieldValue.delete() })
  }

  console.log(`\n${dryRun ? '[dry-run] ' : ''}Perfiles con eventos: ${usersWithEvents} · carreras creadas: ${created}`)
  if (created > 0) {
    console.log('Las carreras importadas tienen prioridad A: revísalas desde el chat o el calendario.')
  }
}

if (require.main === module) {
  main().then(() => process.exit(0)).catch(err => {
    console.error(err instanceof Error ? err.message : err)
    process.exit(1)
  })
}
