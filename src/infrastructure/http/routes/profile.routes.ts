import { Router, Response } from 'express'
import { authMiddleware, AuthRequest } from '../middleware/auth'
import { GetProfile } from '../../../application/profile/GetProfile'
import { UpdateProfile } from '../../../application/profile/UpdateProfile'
import { CyclistProfileFields, ProfileValidationError } from '../../../domain/profile/CyclistProfile'

interface ProfileContainer {
  getProfile: GetProfile
  updateProfile: UpdateProfile
}

const EDITABLE_FIELDS: Array<keyof CyclistProfileFields> = [
  'ftp', 'weightKg', 'hoursPerWeek', 'goal', 'experience',
  'maxHr', 'restingHr', 'availableDays', 'limitations',
]

export function createProfileRouter({ getProfile, updateProfile }: ProfileContainer): Router {
  const router = Router()
  router.use(authMiddleware)

  router.get('/', async (req, res: Response) => {
    try {
      const { userId } = req as AuthRequest
      const profile = await getProfile.execute(userId)
      res.json({ profile })
    } catch (err) {
      res.status(500).json({ error: (err as Error).message })
    }
  })

  router.put('/', async (req, res: Response) => {
    try {
      const { userId } = req as AuthRequest
      const body = (req.body ?? {}) as Record<string, unknown>

      // Only whitelisted fields; the domain entity validates types and ranges
      const patch: Record<string, unknown> = {}
      for (const key of EDITABLE_FIELDS) {
        if (key in body) patch[key] = body[key]
      }

      const profile = await updateProfile.execute({ userId, ...(patch as Partial<CyclistProfileFields>) })
      res.json({ profile })
    } catch (err) {
      const status = err instanceof ProfileValidationError ? 400 : 500
      res.status(status).json({ error: (err as Error).message })
    }
  })

  return router
}
