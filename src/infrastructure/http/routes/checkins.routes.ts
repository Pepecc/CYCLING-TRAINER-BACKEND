import { Router, Request, Response } from 'express'
import { authMiddleware, AuthRequest } from '../middleware/auth'
import { SaveDailyCheckIn } from '../../../application/wellness/SaveDailyCheckIn'
import { GetDailyCheckIns, CheckInWithReadiness } from '../../../application/wellness/GetDailyCheckIns'
import { DeleteDailyCheckIn } from '../../../application/wellness/DeleteDailyCheckIn'
import { CheckInInput, CheckInNotFoundError, CheckInValidationError } from '../../../domain/wellness/DailyCheckIn'

interface CheckInsContainer {
  saveDailyCheckIn: SaveDailyCheckIn
  getDailyCheckIns: GetDailyCheckIns
  deleteDailyCheckIn: DeleteDailyCheckIn
}

const EDITABLE_FIELDS: Array<keyof CheckInInput> = ['fatigue', 'sleepHours', 'sleepQuality', 'feeling', 'soreness', 'morningHr', 'notes']

function pickInput(body: unknown): CheckInInput {
  const src = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>
  const input: CheckInInput = {}
  for (const key of EDITABLE_FIELDS) if (key in src) input[key] = src[key]
  return input
}

export function checkInToJson({ checkIn, readiness }: CheckInWithReadiness) {
  return { date: checkIn.date, ...checkIn.fields(), updatedAt: checkIn.updatedAt, readiness }
}

function sendError(res: Response, err: unknown): void {
  if (err instanceof CheckInValidationError) res.status(400).json({ error: err.message })
  else if (err instanceof CheckInNotFoundError) res.status(404).json({ error: err.message })
  else {
    console.error(err)
    res.status(500).json({ error: 'Error interno del servidor' })
  }
}

// Check-in diario: cansancio, sueño, sensaciones, dolor y FC al despertar (uno por día)
export function createCheckInsRouter(c: CheckInsContainer): Router {
  const router = Router()
  router.use(authMiddleware)

  // GET /api/checkins?from=YYYY-MM-DD&to=YYYY-MM-DD (default: the last 7 days)
  router.get('/', async (req, res: Response) => {
    try {
      const { userId } = req as unknown as AuthRequest
      const from = typeof req.query.from === 'string' ? req.query.from : null
      const to = typeof req.query.to === 'string' ? req.query.to : null
      const r = await c.getDailyCheckIns.execute(userId, from, to)
      res.json({ from: r.from, to: r.to, checkIns: r.checkIns.map(checkInToJson), averages: r.averages })
    } catch (err) {
      sendError(res, err)
    }
  })

  // PUT /api/checkins/:date — creates or updates that day's check-in (only the fields sent)
  router.put('/:date', async (req: Request<{ date: string }>, res: Response) => {
    try {
      const { userId } = req as unknown as AuthRequest
      const saved = await c.saveDailyCheckIn.execute(userId, req.params.date, pickInput(req.body))
      res.json({ checkIn: checkInToJson(saved) })
    } catch (err) {
      sendError(res, err)
    }
  })

  router.delete('/:date', async (req: Request<{ date: string }>, res: Response) => {
    try {
      const { userId } = req as unknown as AuthRequest
      await c.deleteDailyCheckIn.execute(userId, req.params.date)
      res.status(204).end()
    } catch (err) {
      sendError(res, err)
    }
  })

  return router
}
