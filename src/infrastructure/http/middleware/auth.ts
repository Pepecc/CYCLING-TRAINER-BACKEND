import { Request, Response, NextFunction } from 'express'
import admin from 'firebase-admin'
import { UserRepository } from '../../../domain/user/UserRepository'
import { getFirebaseApp } from '../../firebase/firebaseAdmin'

export interface AuthRequest extends Request {
  userId: string
  userEmail: string
}

let _userRepository: UserRepository

export function configureAuth(userRepository: UserRepository): void {
  _userRepository = userRepository
  getFirebaseApp()
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
