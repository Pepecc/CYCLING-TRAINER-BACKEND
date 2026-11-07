// Importa un plan desde un fichero JSON (TrainingPeaks o formato propio) sin pasar por la interfaz.
// Usa los mismos casos de uso que POST /api/plan/import/preview y POST /api/plan/import.
//
// Uso: npm run plan:import -- <fichero.json> --user <email o uid> [--save] [--replace] [--allow-production]
//   sin --save   solo muestra la vista previa (no guarda nada)
//   --save       guarda los entrenos válidos; los que ya están en el plan se saltan
//   --replace    con --save, sobrescribe los que ya están (conservan su id y su estado)
import 'dotenv/config'
import fs from 'fs'

import { getFirestore } from '../src/infrastructure/firebase/firebaseAdmin'
import { FirestorePlannedWorkoutRepository } from '../src/infrastructure/persistence/firestore/FirestorePlannedWorkoutRepository'
import { FirestoreProfileRepository } from '../src/infrastructure/persistence/firestore/FirestoreProfileRepository'
import { TrainingPeaksParser } from '../src/infrastructure/import/TrainingPeaksParser'
import { NativePlanParser } from '../src/infrastructure/import/NativePlanParser'
import { PreviewPlanImport } from '../src/application/planning/PreviewPlanImport'
import { ImportPlannedWorkouts } from '../src/application/planning/ImportPlannedWorkouts'

function arg(name: string): string | null {
  const i = process.argv.indexOf(name)
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : null
}

async function main(): Promise<void> {
  const file = process.argv.slice(2).find(a => !a.startsWith('--') && a !== arg('--user'))
  const user = arg('--user')
  const save = process.argv.includes('--save')
  const replace = process.argv.includes('--replace')
  if (!file || !user) {
    throw new Error('Uso: npm run plan:import -- <fichero.json> --user <email o uid> [--save] [--replace]')
  }
  if (!process.env.FIRESTORE_EMULATOR_HOST && !process.argv.includes('--allow-production')) {
    throw new Error('FIRESTORE_EMULATOR_HOST no está configurada. Para importar en el Firestore real, añade --allow-production')
  }

  const db = getFirestore()
  let userId = user
  if (user.includes('@')) {
    const snap = await db.collection('users').where('email', '==', user).limit(1).get()
    if (snap.empty) throw new Error(`No hay ningún usuario con el email ${user}`)
    userId = snap.docs[0].id
  } else if (!(await db.collection('users').doc(user).get()).exists) {
    throw new Error(`No existe el usuario ${user}`)
  }

  const plannedWorkouts = new FirestorePlannedWorkoutRepository(db)
  const profiles = new FirestoreProfileRepository(db)
  const preview = new PreviewPlanImport([new TrainingPeaksParser(), new NativePlanParser()], plannedWorkouts, profiles)
  const data = JSON.parse(fs.readFileSync(file, 'utf-8'))
  const result = await preview.fromFile(userId, data)

  for (const item of result.items) {
    const w = item.workout
    const head = w
      ? `${w.date}  ${w.title}  [${w.focus}${w.environment !== 'any' ? `, ${w.environment}` : ''}]` +
        `${w.durationMinutes !== null ? `  ${w.durationMinutes} min` : ''}${w.plannedTss !== null ? `  TSS ${w.plannedTss}` : ''}`
      : `#${item.index + 1}`
    const mark = !item.valid ? '✗' : item.duplicateOf ? '=' : '✓'
    console.log(`${mark} ${head}`)
    if (w?.structure) console.log(`    ${w.structure}`)
    if (item.error) console.log(`    error: ${item.error}`)
    for (const warning of item.warnings) console.log(`    aviso: ${warning}`)
    if (item.duplicateOf) console.log(`    ya está en el plan (${item.duplicateOf})`)
  }

  console.log(
    `\nFormato: ${result.format} · ${result.total} entrenos (${result.valid} válidos, ${result.invalid} con errores, ` +
    `${result.duplicates} ya en el plan) · ${result.from ?? '-'} → ${result.to ?? '-'} · ${result.totalHours} h · TSS ${result.totalTss}`
  )
  for (const warning of result.warnings) console.log(`Aviso: ${warning}`)

  if (!save) {
    console.log('\nVista previa: no se ha guardado nada. Añade --save para importar los válidos.')
    return
  }
  const drafts = result.items.filter(i => i.valid).map(i => i.draft)
  if (drafts.length === 0) {
    console.log('\nNo hay entrenos válidos que importar.')
    return
  }
  const saved = await new ImportPlannedWorkouts(plannedWorkouts, profiles).execute(userId, drafts, replace ? 'replace' : 'skip')
  console.log(`\nImportados: ${saved.created} nuevos, ${saved.updated} sobrescritos, ${saved.skipped} ya estaban.`)
}

main().catch(err => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
