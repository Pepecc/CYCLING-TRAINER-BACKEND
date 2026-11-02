import { Router, Request, Response } from 'express'
import crypto from 'crypto'
import { authMiddleware, AuthRequest } from '../middleware/auth'
import { rateLimit } from '../middleware/rateLimit'
import { WahooOAuthService, WahooNotConnectedError } from '../../wahoo/WahooOAuthService'
import { OAuthStateRepository } from '../../../domain/wahoo/OAuthStateRepository'
import { GetWahooWorkouts } from '../../../application/wahoo/GetWahooWorkouts'
import { AnalyzeWahooWorkout } from '../../../application/wahoo/AnalyzeWahooWorkout'
import { SyncWahooWorkouts } from '../../../application/wahoo/SyncWahooWorkouts'
import { DisconnectWahoo } from '../../../application/wahoo/DisconnectWahoo'
import { SendMessage } from '../../../application/chat/SendMessage'

interface WahooContainer {
  wahooService: WahooOAuthService
  oauthStates: OAuthStateRepository
  syncWorkouts: SyncWahooWorkouts
  getWahooWorkouts: GetWahooWorkouts
  analyzeWahooWorkout: AnalyzeWahooWorkout
  disconnectWahoo: DisconnectWahoo
  sendMessage: SendMessage
}

const OAUTH_STATE_TTL_MS = 10 * 60 * 1000

function errorStatus(err: unknown): number {
  return err instanceof WahooNotConnectedError ? 403 : 500
}

export function createWahooRouter(container: WahooContainer): Router {
  const router = Router()
  const {
    wahooService, oauthStates, syncWorkouts, getWahooWorkouts,
    analyzeWahooWorkout, disconnectWahoo, sendMessage,
  } = container

  // Analysis triggers an AI call, so it gets the same per-user limit as the chat
  const analyzeLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: Number(process.env.CHAT_RATE_LIMIT_PER_MINUTE) || 10,
  })

  // CSRF protection: random state tied to this userId, stored in DB (single use, 10 min)
  async function createState(userId: string): Promise<string> {
    const state = crypto.randomBytes(16).toString('hex')
    await oauthStates.create(state, userId, OAUTH_STATE_TTL_MS)
    return state
  }

  // ── GET /api/wahoo/status ─────────────────────────────────────────────────
  // Check if current user has Wahoo connected
  router.get('/status', authMiddleware, async (req, res: Response) => {
    const { userId } = req as AuthRequest
    const connected = await wahooService.isConnected(userId)
    res.json({ connected })
  })

  // ── GET /api/wahoo/connect ────────────────────────────────────────────────
  // Redirects user to Wahoo authorization page
  router.get('/connect', authMiddleware, async (req, res: Response) => {
    const { userId } = req as AuthRequest
    const state = await createState(userId)
    res.redirect(wahooService.buildAuthorizationUrl(state))
  })

  // ── GET /api/wahoo/connect-url ────────────────────────────────────────────
  // Returns the Wahoo authorization URL as JSON (for frontend-initiated OAuth)
  router.get('/connect-url', authMiddleware, async (req, res: Response) => {
    const { userId } = req as AuthRequest
    const state = await createState(userId)
    res.json({ url: wahooService.buildAuthorizationUrl(state) })
  })

  // ── GET /api/wahoo/callback ───────────────────────────────────────────────
  // Wahoo redirects here after user authorizes
  router.get('/callback', async (req: Request, res: Response) => {
    const { code, state, error } = req.query as Record<string, string>
    const frontendUrl = (process.env.FRONTEND_URL ?? '').split(',')[0].trim().replace(/\/$/, '')

    if (error) {
      return res.redirect(`${frontendUrl}/?wahoo_error=${encodeURIComponent(error)}`)
    }

    if (!code || !state) {
      return res.status(400).send('Parámetros de callback inválidos')
    }

    const userId = await oauthStates.consume(state)
    if (!userId) {
      return res.redirect(`${frontendUrl}/?wahoo_error=${encodeURIComponent('La conexión ha caducado. Vuelve a intentarlo.')}`)
    }

    try {
      await wahooService.exchangeCode(userId, code)

      // Import the workout history in the background so the first chat is fast
      syncWorkouts.execute(userId, { force: true })
        .catch(err => console.error('Initial Wahoo sync failed:', err))

      res.redirect(`${frontendUrl}/?wahoo_connected=true`)
    } catch (err) {
      console.error('Wahoo callback error:', err)
      res.redirect(`${frontendUrl}/?wahoo_error=${encodeURIComponent('No se pudo completar la conexión con Wahoo')}`)
    }
  })

  // ── GET /api/wahoo/workouts ───────────────────────────────────────────────
  // List recent workouts for the authenticated user
  router.get('/workouts', authMiddleware, async (req, res: Response) => {
    const { userId } = req as AuthRequest
    const page = Number(req.query.page) || 1
    const perPage = Number(req.query.per_page) || 10

    try {
      const workouts = await getWahooWorkouts.execute(userId, page, perPage)
      res.json({ workouts })
    } catch (err) {
      res.status(errorStatus(err)).json({ error: (err as Error).message })
    }
  })

  // ── POST /api/wahoo/workouts/:id/analyze ─────────────────────────────────
  // Fetch workout from Wahoo + send to coach for analysis
  // Creates a new conversation with the workout context pre-loaded
  router.post('/workouts/:id/analyze', authMiddleware, analyzeLimiter, async (req, res: Response) => {
    const { userId } = req as AuthRequest
    const workoutId = Number(req.params.id)

    if (isNaN(workoutId)) {
      return res.status(400).json({ error: 'workout id inválido' })
    }

    try {
      const { analysisContext } = await analyzeWahooWorkout.execute({ userId, workoutId })

      // Send the workout context as the first user message in a new conversation
      const result = await sendMessage.execute({
        userId,
        content: analysisContext,
        conversationId: null,
      })

      res.json({
        conversationId: result.conversationId,
        message: result.message,
      })
    } catch (err) {
      res.status(errorStatus(err)).json({ error: (err as Error).message })
    }
  })

  // ── DELETE /api/wahoo/disconnect ─────────────────────────────────────────
  // Revokes the app's permissions in Wahoo and deletes tokens and synced workouts
  router.delete('/disconnect', authMiddleware, async (req, res: Response) => {
    const { userId } = req as AuthRequest
    try {
      await disconnectWahoo.execute(userId)
      res.json({ disconnected: true })
    } catch (err) {
      res.status(500).json({ error: (err as Error).message })
    }
  })

  return router
}
