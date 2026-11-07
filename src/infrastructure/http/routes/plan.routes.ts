import { Router, Request, Response } from 'express'
import { authMiddleware, AuthRequest } from '../middleware/auth'
import { SavePlannedWorkouts } from '../../../application/planning/SavePlannedWorkouts'
import { UpdatePlannedWorkout } from '../../../application/planning/UpdatePlannedWorkout'
import { DeletePlannedWorkout } from '../../../application/planning/DeletePlannedWorkout'
import { GetTrainingPlan } from '../../../application/planning/GetTrainingPlan'
import { PlannedWorkoutInput, PlanValidationError, PlannedWorkoutNotFoundError } from '../../../domain/planning/PlannedWorkout'

interface PlanContainer {
  savePlannedWorkouts: SavePlannedWorkouts
  updatePlannedWorkout: UpdatePlannedWorkout
  deletePlannedWorkout: DeletePlannedWorkout
  getTrainingPlan: GetTrainingPlan
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
  if (err instanceof PlanValidationError) {
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
  router.get('/', async (req, res: Response) => {
    try {
      const { userId } = req as unknown as AuthRequest
      const from = typeof req.query.from === 'string' ? req.query.from : null
      const to = typeof req.query.to === 'string' ? req.query.to : null
      res.json(await c.getTrainingPlan.execute(userId, from, to))
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

  router.patch('/:id', async (req: Request<{ id: string }>, res: Response) => {
    try {
      const { userId } = req as unknown as AuthRequest
      const workout = await c.updatePlannedWorkout.execute(userId, req.params.id, pickInput(req.body))
      res.json({ workout })
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
