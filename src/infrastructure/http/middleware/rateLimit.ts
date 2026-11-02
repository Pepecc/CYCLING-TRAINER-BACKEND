import { Request, Response, NextFunction } from 'express'
import { AuthRequest } from './auth'

interface Window {
  count: number
  resetAt: number
}

// In-memory fixed-window limiter keyed by authenticated user (falls back to IP).
// Good enough for a single instance; use Redis if the backend is scaled out.
export function rateLimit({ windowMs, max }: { windowMs: number; max: number }) {
  const windows = new Map<string, Window>()

  setInterval(() => {
    const now = Date.now()
    for (const [key, w] of windows) if (w.resetAt <= now) windows.delete(key)
  }, windowMs).unref()

  return (req: Request, res: Response, next: NextFunction): void => {
    const key = (req as AuthRequest).userId ?? req.ip ?? 'unknown'
    const now = Date.now()

    let w = windows.get(key)
    if (!w || w.resetAt <= now) {
      w = { count: 0, resetAt: now + windowMs }
      windows.set(key, w)
    }

    w.count++
    if (w.count > max) {
      res.setHeader('Retry-After', Math.ceil((w.resetAt - now) / 1000))
      res.status(429).json({ error: 'Demasiados mensajes seguidos. Espera un momento antes de volver a escribir.' })
      return
    }

    next()
  }
}
