import { Router, Response } from 'express'
import { authMiddleware, AuthRequest } from '../middleware/auth'
import { GetFitnessTests } from '../../../application/testing/GetFitnessTests'
import { ScheduleFitnessTest } from '../../../application/testing/ScheduleFitnessTest'
import { RecordFitnessTest } from '../../../application/testing/RecordFitnessTest'
import { FitnessTestError, PROTOCOLS, TEST_PROTOCOLS } from '../../../domain/testing/fitnessTest'
import { PlanValidationError, PlannedWorkoutNotFoundError } from '../../../domain/planning/PlannedWorkout'
import { ProfileValidationError } from '../../../domain/profile/CyclistProfile'

interface TestsContainer {
  getFitnessTests: GetFitnessTests
  scheduleFitnessTest: ScheduleFitnessTest
  recordFitnessTest: RecordFitnessTest
}

function sendError(res: Response, err: unknown): void {
  if (err instanceof FitnessTestError || err instanceof PlanValidationError || err instanceof ProfileValidationError) {
    res.status(400).json({ error: err.message })
  } else if (err instanceof PlannedWorkoutNotFoundError) {
    res.status(404).json({ error: err.message })
  } else {
    console.error(err)
    res.status(500).json({ error: 'Error interno del servidor' })
  }
}

// Tests de FTP y de FC: historial, programarlos en el plan y registrar el resultado (actualiza el perfil y las zonas)
export function createTestsRouter(c: TestsContainer): Router {
  const router = Router()
  router.use(authMiddleware)

  // GET /api/tests — history, scheduled tests, whether a test is due and the protocols
  router.get('/', async (req, res: Response) => {
    try {
      const { userId } = req as unknown as AuthRequest
      const overview = await c.getFitnessTests.execute(userId)
      res.json({ ...overview, protocols: TEST_PROTOCOLS.map(id => ({ id, ...PROTOCOLS[id] })) })
    } catch (err) {
      sendError(res, err)
    }
  })

  // POST /api/tests/schedule { protocol, date, environment? }
  router.post('/schedule', async (req, res: Response) => {
    try {
      const { userId } = req as unknown as AuthRequest
      const body = (req.body ?? {}) as Record<string, unknown>
      const r = await c.scheduleFitnessTest.execute(userId, { protocol: body.protocol, date: body.date, environment: body.environment }, 'user')
      res.status(201).json(r)
    } catch (err) {
      sendError(res, err)
    }
  })

  // POST /api/tests/record { protocol?, value?, date?, plannedWorkoutId?, notes?, save? } — preview unless save is true
  router.post('/record', async (req, res: Response) => {
    try {
      const { userId } = req as unknown as AuthRequest
      const body = (req.body ?? {}) as Record<string, unknown>
      const r = await c.recordFitnessTest.execute(
        userId,
        { protocol: body.protocol, value: body.value, date: body.date, plannedWorkoutId: body.plannedWorkoutId, notes: body.notes },
        body.save === true
      )
      res.status(r.saved ? 201 : 200).json(r)
    } catch (err) {
      sendError(res, err)
    }
  })

  return router
}
