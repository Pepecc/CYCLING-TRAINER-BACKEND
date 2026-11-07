import { Router, Request, Response } from 'express'
import { authMiddleware, AuthRequest } from '../middleware/auth'
import { SaveRaceEvents } from '../../../application/events/SaveRaceEvents'
import { UpdateRaceEvent } from '../../../application/events/UpdateRaceEvent'
import { DeleteRaceEvent } from '../../../application/events/DeleteRaceEvent'
import { GetRaceEvents } from '../../../application/events/GetRaceEvents'
import { GetSeasonPlan } from '../../../application/events/GetSeasonPlan'
import { RaceEventInput, RaceValidationError, RaceEventNotFoundError } from '../../../domain/events/RaceEvent'

interface EventsContainer {
  saveRaceEvents: SaveRaceEvents
  updateRaceEvent: UpdateRaceEvent
  deleteRaceEvent: DeleteRaceEvent
  getRaceEvents: GetRaceEvents
  getSeasonPlan: GetSeasonPlan
}

const EDITABLE_FIELDS: Array<keyof RaceEventInput> = [
  'name', 'date', 'days', 'priority', 'type', 'distanceKm', 'elevationM', 'location', 'goal', 'notes', 'result',
]

function pickInput(body: unknown): RaceEventInput {
  const src = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>
  const input: RaceEventInput = {}
  for (const key of EDITABLE_FIELDS) {
    if (key in src) input[key] = src[key]
  }
  return input
}

function sendError(res: Response, err: unknown): void {
  if (err instanceof RaceValidationError) {
    res.status(400).json({ error: err.message })
  } else if (err instanceof RaceEventNotFoundError) {
    res.status(404).json({ error: err.message })
  } else {
    console.error(err)
    res.status(500).json({ error: 'Error interno del servidor' })
  }
}

// Carreras y plan de temporada (para el calendario del frontend; el coach usa las mismas operaciones vía tools)
export function createEventsRouter(c: EventsContainer): Router {
  const router = Router()
  router.use(authMiddleware)

  // GET /api/events?past=true  — próximas (y en curso); con past, también las del último año
  router.get('/', async (req, res: Response) => {
    try {
      const { userId } = req as unknown as AuthRequest
      const events = await c.getRaceEvents.execute(userId, req.query.past === 'true')
      res.json({ events })
    } catch (err) {
      sendError(res, err)
    }
  })

  // GET /api/events/season-plan — fases, semanas y ventanas de taper / recuperación
  router.get('/season-plan', async (req, res: Response) => {
    try {
      const { userId } = req as unknown as AuthRequest
      res.json(await c.getSeasonPlan.execute(userId))
    } catch (err) {
      sendError(res, err)
    }
  })

  // POST /api/events  { events: [...] } o una única carrera
  router.post('/', async (req, res: Response) => {
    try {
      const { userId } = req as unknown as AuthRequest
      const body = req.body as Record<string, unknown> | undefined
      const raw = Array.isArray(body?.events) ? body!.events as unknown[] : [body]
      const events = await c.saveRaceEvents.execute(userId, raw.map(pickInput))
      res.status(201).json({ events })
    } catch (err) {
      sendError(res, err)
    }
  })

  router.patch('/:id', async (req: Request<{ id: string }>, res: Response) => {
    try {
      const { userId } = req as unknown as AuthRequest
      const event = await c.updateRaceEvent.execute(userId, req.params.id, pickInput(req.body))
      res.json({ event })
    } catch (err) {
      sendError(res, err)
    }
  })

  router.delete('/:id', async (req: Request<{ id: string }>, res: Response) => {
    try {
      const { userId } = req as unknown as AuthRequest
      await c.deleteRaceEvent.execute(userId, req.params.id)
      res.status(204).end()
    } catch (err) {
      sendError(res, err)
    }
  })

  return router
}
