import { Router, Request, Response } from 'express'
import { authMiddleware, AuthRequest } from '../middleware/auth'
import { SavePlannedWorkouts } from '../../../application/planning/SavePlannedWorkouts'
import { UpdatePlannedWorkout } from '../../../application/planning/UpdatePlannedWorkout'
import { DeletePlannedWorkout } from '../../../application/planning/DeletePlannedWorkout'
import { GetTrainingPlan } from '../../../application/planning/GetTrainingPlan'
import { PlannedWorkoutInput, PlanValidationError, PlannedWorkoutNotFoundError } from '../../../domain/planning/PlannedWorkout'
import { ImportFormatError } from '../../../domain/planning/PlanImport'
import { ImageValidationError } from '../../../domain/chat/ImageAttachment'
import { PreviewPlanImport } from '../../../application/planning/PreviewPlanImport'
import { ImportPlannedWorkouts } from '../../../application/planning/ImportPlannedWorkouts'
import { ExtractPlanFromImage } from '../../../application/planning/ExtractPlanFromImage'
import { rateLimit } from '../middleware/rateLimit'
import { AdaptPlannedWorkout } from '../../../application/planning/AdaptPlannedWorkout'
import { AdaptationNotPossibleError } from '../../../domain/planning/adaptWorkout'
import { ReconcilePlan } from '../../../application/planning/ReconcilePlan'
import { ReplanWeek } from '../../../application/planning/ReplanWeek'
import { GetFormProjection } from '../../../application/planning/GetFormProjection'
import { WahooWorkout } from '../../../domain/wahoo/WahooWorkout'
import { addDays, dayKey } from '../../../domain/training/calendar'

interface PlanContainer {
  adaptPlannedWorkout: AdaptPlannedWorkout
  savePlannedWorkouts: SavePlannedWorkouts
  updatePlannedWorkout: UpdatePlannedWorkout
  deletePlannedWorkout: DeletePlannedWorkout
  getTrainingPlan: GetTrainingPlan
  previewPlanImport: PreviewPlanImport
  importPlannedWorkouts: ImportPlannedWorkouts
  extractPlanFromImage: ExtractPlanFromImage
  reconcilePlan: ReconcilePlan
  replanWeek: ReplanWeek
  getFormProjection: GetFormProjection
}

// Workouts done outside the plan, for the calendar (planned vs done)
function unplannedToJson(a: WahooWorkout) {
  return { id: a.id, name: a.name, date: dayKey(new Date(a.startedAt)), startedAt: a.startedAt, durationMinutes: a.durationMinutes, location: a.location }
}

const EDITABLE_FIELDS: Array<keyof PlannedWorkoutInput> = [
  'date', 'title', 'focus', 'environment', 'description', 'blocks', 'durationMinutes', 'tss', 'status', 'notes',
]

function pickInput(body: unknown): PlannedWorkoutInput {
  const src = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>
  const input: PlannedWorkoutInput = {}
  for (const key of EDITABLE_FIELDS) {
    if (key in src) input[key] = src[key]
  }
  return input
}

function sendError(res: Response, err: unknown): void {
  if (err instanceof AdaptationNotPossibleError) {
    res.status(422).json({ error: err.message, minimumMinutes: err.minimumMinutes })
  } else if (err instanceof PlanValidationError || err instanceof ImportFormatError || err instanceof ImageValidationError) {
    res.status(400).json({ error: err.message })
  } else if (err instanceof PlannedWorkoutNotFoundError) {
    res.status(404).json({ error: err.message })
  } else {
    console.error(err)
    res.status(500).json({ error: 'Error interno del servidor' })
  }
}

// Plan de entrenamiento (para el calendario del frontend; el coach usa las mismas operaciones vía tools)
export function createPlanRouter(c: PlanContainer): Router {
  const router = Router()
  router.use(authMiddleware)

  // GET /api/plan?from=YYYY-MM-DD&to=YYYY-MM-DD
  // The past days are linked with Wahoo first (status, completion); unplanned = rides outside the plan
  router.get('/', async (req, res: Response) => {
    try {
      const { userId } = req as unknown as AuthRequest
      const from = typeof req.query.from === 'string' ? req.query.from : null
      const to = typeof req.query.to === 'string' ? req.query.to : null
      const range = await c.getTrainingPlan.execute(userId, from, to)   // validates the dates
      let linked = false
      let unplanned: WahooWorkout[] = []
      try {
        const outcome = await c.reconcilePlan.execute(userId, range.from, range.to)
        linked = outcome.linked
        unplanned = outcome.unplanned
      } catch (err) {
        console.error('Plan reconciliation failed:', err)
      }
      const plan = await c.getTrainingPlan.execute(userId, range.from, range.to)
      res.json({ ...plan, linked, unplanned: unplanned.map(unplannedToJson) })
    } catch (err) {
      sendError(res, err)
    }
  })

  // GET /api/plan/form-projection?to=YYYY-MM-DD — CTL/ATL/TSB day by day (history + projection) for the chart
  router.get('/form-projection', async (req, res: Response) => {
    try {
      const { userId } = req as unknown as AuthRequest
      const to = typeof req.query.to === 'string' ? req.query.to : null
      res.json(await c.getFormProjection.execute(userId, to))
    } catch (err) {
      sendError(res, err)
    }
  })

  // POST /api/plan/reconcile { from?, to? } — link with Wahoo now (default: the last 14 days)
  router.post('/reconcile', async (req, res: Response) => {
    try {
      const { userId } = req as unknown as AuthRequest
      const body = (req.body ?? {}) as Record<string, unknown>
      const today = dayKey(new Date())
      const plan = await c.getTrainingPlan.execute(
        userId,
        typeof body.from === 'string' ? body.from : addDays(today, -13),
        typeof body.to === 'string' ? body.to : today
      )
      const outcome = await c.reconcilePlan.execute(userId, plan.from, plan.to)
      res.json({
        range: outcome.range,
        linked: outcome.linked,
        changed: outcome.changed,
        unplanned: outcome.unplanned.map(unplannedToJson),
      })
    } catch (err) {
      sendError(res, err)
    }
  })

  // POST /api/plan/replan-week { save? } — preview (default) or apply the replanning of the current week
  router.post('/replan-week', async (req, res: Response) => {
    try {
      const { userId } = req as unknown as AuthRequest
      const body = (req.body ?? {}) as Record<string, unknown>
      const r = await c.replanWeek.execute(userId, body.save === true)
      res.json({
        ...r,
        changes: r.changes.map(ch => ({
          kind: ch.kind,
          workoutId: ch.workout.id,
          title: ch.workout.title,
          reason: ch.reason,
          ...(ch.kind === 'move' ? { from: ch.from, to: ch.to, replacesId: ch.replaces?.id ?? null, tssDelta: ch.tssDelta } : {}),
          ...(ch.kind === 'extend' ? { date: ch.workout.date, addMinutes: ch.addMinutes, tssDelta: ch.tssDelta } : {}),
          ...(ch.kind === 'drop' ? { date: ch.workout.date } : {}),
        })),
      })
    } catch (err) {
      sendError(res, err)
    }
  })

  // POST /api/plan  { workouts: [...] } o un único entreno
  router.post('/', async (req, res: Response) => {
    try {
      const { userId } = req as unknown as AuthRequest
      const body = req.body as Record<string, unknown> | undefined
      const raw = Array.isArray(body?.workouts) ? body!.workouts as unknown[] : [body]
      const workouts = await c.savePlannedWorkouts.execute(userId, raw.map(pickInput), 'user')
      res.status(201).json({ workouts })
    } catch (err) {
      sendError(res, err)
    }
  })

  // ─── Importar ─────────────────────────────────────────────────────────────
  // 1. Vista previa (no guarda nada): el cuerpo es el JSON del fichero (TrainingPeaks o formato propio)
  //    o, para una foto, { image: { mediaType, data }, hint? } en /import/image.
  // 2. Confirmar: POST /import con los borradores elegidos de la vista previa.

  router.post('/import/preview', async (req, res: Response) => {
    try {
      const { userId } = req as unknown as AuthRequest
      res.json(await c.previewPlanImport.fromFile(userId, req.body))
    } catch (err) {
      sendError(res, err)
    }
  })

  // Reading a photo goes through OpenAI: same per-user limit as the chat
  const imageLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: Number(process.env.CHAT_RATE_LIMIT_PER_MINUTE) || 10,
  })

  router.post('/import/image', imageLimiter, async (req, res: Response) => {
    try {
      const { userId } = req as unknown as AuthRequest
      const body = (req.body ?? {}) as Record<string, unknown>
      res.json(await c.extractPlanFromImage.execute(userId, body.image, body.hint))
    } catch (err) {
      sendError(res, err)
    }
  })

  // { workouts: [{ externalId, input }], onDuplicate: 'skip' | 'replace' }
  router.post('/import', async (req, res: Response) => {
    try {
      const { userId } = req as unknown as AuthRequest
      const body = (req.body ?? {}) as Record<string, unknown>
      if (!Array.isArray(body.workouts)) throw new PlanValidationError('Falta la lista "workouts" con los entrenos a importar')
      const onDuplicate = body.onDuplicate === 'replace' ? 'replace' : 'skip'
      const result = await c.importPlannedWorkouts.execute(userId, body.workouts, onDuplicate)
      res.status(201).json(result)
    } catch (err) {
      sendError(res, err)
    }
  })

  router.patch('/:id', async (req: Request<{ id: string }>, res: Response) => {
    try {
      const { userId } = req as unknown as AuthRequest
      const workout = await c.updatePlannedWorkout.execute(userId, req.params.id, pickInput(req.body))
      res.json({ workout })
    } catch (err) {
      sendError(res, err)
    }
  })

  // ─── Adaptar ──────────────────────────────────────────────────────────────
  // POST /:id/adapt { environment?, availableMinutes?, save? } → vista previa (save false) o guardado.
  // 422 si no cabe en los minutos sin perder el objetivo (con minimumMinutes).
  router.post('/:id/adapt', async (req: Request<{ id: string }>, res: Response) => {
    try {
      const { userId } = req as unknown as AuthRequest
      const body = (req.body ?? {}) as Record<string, unknown>
      const r = await c.adaptPlannedWorkout.execute(
        userId,
        req.params.id,
        { environment: body.environment, availableMinutes: body.availableMinutes },
        body.save === true
      )
      res.json(r)
    } catch (err) {
      sendError(res, err)
    }
  })

  // DELETE /:id/adaptation → vuelve a la versión original
  router.delete('/:id/adaptation', async (req: Request<{ id: string }>, res: Response) => {
    try {
      const { userId } = req as unknown as AuthRequest
      res.json({ workout: await c.adaptPlannedWorkout.restore(userId, req.params.id) })
    } catch (err) {
      sendError(res, err)
    }
  })

  router.delete('/:id', async (req: Request<{ id: string }>, res: Response) => {
    try {
      const { userId } = req as unknown as AuthRequest
      await c.deletePlannedWorkout.execute(userId, req.params.id)
      res.status(204).end()
    } catch (err) {
      sendError(res, err)
    }
  })

  return router
}
