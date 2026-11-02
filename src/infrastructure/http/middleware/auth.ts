import { Request, Response, NextFunction } from 'express'
import admin from 'firebase-admin'
import { UserRepository } from '../../../domain/user/UserRepository'

export interface AuthRequest extends Request {
  userId: string
  userEmail: string
}

let _userRepository: UserRepository

function loadServiceAccount(): admin.ServiceAccount {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT
  if (!raw) {
    throw new Error('Falta FIREBASE_SERVICE_ACCOUNT: pega el JSON de la cuenta de servicio de Firebase en una sola línea')
  }
  try {
    return JSON.parse(raw) as admin.ServiceAccount
  } catch {
    throw new Error('FIREBASE_SERVICE_ACCOUNT no es un JSON válido')
  }
}

export function configureAuth(userRepository: UserRepository): void {
  _userRepository = userRepository

  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert(loadServiceAccount()),
    })
  }
}

export async function authMiddleware(req: Request, res: Response, next: NextFunction): Promise<void> {
  const authHeader = req.headers['authorization']
  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Token requerido' })
    return
  }

  const token = authHeader.split(' ')[1]

  try {
    const decoded = await admin.auth().verifyIdToken(token)

    if (!decoded.email_verified) {
      res.status(403).json({ error: 'Email no verificado. Revisa tu bandeja de entrada y confirma tu cuenta.' })
      return
    }

    await _userRepository.ensureExists(decoded.uid, decoded.email!)
    ;(req as AuthRequest).userId    = decoded.uid
    ;(req as AuthRequest).userEmail = decoded.email!
    next()
  } catch {
    res.status(401).json({ error: 'Token inválido o expirado' })
  }
}
