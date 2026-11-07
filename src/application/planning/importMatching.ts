import { PlannedWorkout } from '../../domain/planning/PlannedWorkout'
import { PlannedWorkoutRepository } from '../../domain/planning/PlannedWorkoutRepository'

// Detección de entrenos ya guardados al importar: primero por id de origen (reimportar el mismo
// fichero de TrainingPeaks) y, si no, por fecha + título (p. ej. la misma tabla subida dos veces en foto).

export const normalizeTitle = (t: string): string =>
  t.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim()

export interface ImportCandidate {
  externalId: string | null
  date: string
  title: string
}

export async function findExisting(
  repo: PlannedWorkoutRepository,
  userId: string,
  candidates: ImportCandidate[]
): Promise<Array<PlannedWorkout | null>> {
  if (candidates.length === 0) return []
  const dates = candidates.map(c => c.date).sort()
  const existing = await repo.findBetween(userId, dates[0], dates[dates.length - 1])

  const byExternal = new Map<string, PlannedWorkout>()
  const byDayTitle = new Map<string, PlannedWorkout>()
  for (const w of existing) {
    if (w.externalId) byExternal.set(w.externalId, w)
    const key = `${w.date}|${normalizeTitle(w.title)}`
    if (!byDayTitle.has(key)) byDayTitle.set(key, w)
  }

  return candidates.map(c =>
    (c.externalId ? byExternal.get(c.externalId) : undefined) ??
    byDayTitle.get(`${c.date}|${normalizeTitle(c.title)}`) ??
    null
  )
}
