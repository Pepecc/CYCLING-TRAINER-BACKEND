import 'dotenv/config'
import express, { Request, Response, NextFunction } from 'express'
import cors from 'cors'
import { buildContainer } from '../../config/container'
import { createProfileRouter } from './routes/profile.routes'
import { createChatRouter } from './routes/chat.routes'
import { createWahooRouter } from './routes/wahoo.routes'
import { createPlanRouter } from './routes/plan.routes'
import { createEventsRouter } from './routes/events.routes'
import { createCheckInsRouter } from './routes/checkins.routes'
import { createTestsRouter } from './routes/tests.routes'

const PORT = process.env.PORT ?? 3000

async function bootstrap(): Promise<void> {
  const app = express()

  // FRONTEND_URL may hold several comma-separated origins; localhost is always allowed for dev
  const allowedOrigins = (process.env.FRONTEND_URL ?? '')
    .split(',')
    .map(o => o.trim().replace(/\/$/, ''))
    .filter(Boolean)

  app.use(cors({
    origin(origin, callback) {
      if (!origin) return callback(null, true)  // curl, server-to-server, same-origin
      if (allowedOrigins.includes(origin) || /^http:\/\/localhost(:\d+)?$/.test(origin)) {
        return callback(null, true)
      }
      callback(null, false)
    },
  }))
  // Plan files (TrainingPeaks ~1 MB per season) and chat images (up to 4 × 900 KB in base64) need more than the 100 KB default
  app.use(express.json({ limit: process.env.JSON_BODY_LIMIT ?? '8mb' }))

  const container = buildContainer()

  app.use('/api/profile', createProfileRouter(container))
  app.use('/api/chat',    createChatRouter(container))
  app.use('/api/wahoo',   createWahooRouter(container))
  app.use('/api/plan',    createPlanRouter(container))
  app.use('/api/events',  createEventsRouter(container))
  app.use('/api/checkins', createCheckInsRouter(container))
  app.use('/api/tests',   createTestsRouter(container))

  app.get('/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() })
  })

  app.use((_req: Request, res: Response) => {
    res.status(404).json({ error: 'Ruta no encontrada' })
  })

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: Error & { type?: string }, _req: Request, res: Response, _next: NextFunction) => {
    // Errors from express.json(): body too large or malformed JSON
    if (err.type === 'entity.too.large') {
      res.status(413).json({ error: 'El fichero o las imágenes ocupan demasiado' })
      return
    }
    if (err.type === 'entity.parse.failed') {
      res.status(400).json({ error: 'El cuerpo de la petición no es un JSON válido' })
      return
    }
    console.error(err)
    res.status(500).json({ error: 'Error interno del servidor' })
  })

  app.listen(PORT, () => {
    console.log(`🚴 Cycling Coach API  →  http://localhost:${PORT}`)
    console.log(`   Health check       →  http://localhost:${PORT}/health`)
  })
}

bootstrap()
