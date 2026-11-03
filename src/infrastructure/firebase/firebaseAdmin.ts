import admin from 'firebase-admin'
import { Firestore } from 'firebase-admin/firestore'

// Single firebase-admin app shared by auth (ID token verification) and Firestore.

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

export function getFirebaseApp(): admin.app.App {
  if (!admin.apps.length) {
    admin.initializeApp({ credential: admin.credential.cert(loadServiceAccount()) })
  }
  return admin.app()
}

let firestore: Firestore | null = null

// With FIRESTORE_EMULATOR_HOST set, firebase-admin talks to the local emulator instead of the real project.
export function getFirestore(): Firestore {
  if (firestore) return firestore
  const db = getFirebaseApp().firestore()
  db.settings({ ignoreUndefinedProperties: true })

  if (process.env.FIRESTORE_EMULATOR_HOST) {
    console.log(`🔥 Firestore: emulador en ${process.env.FIRESTORE_EMULATOR_HOST}`)
  } else {
    console.warn('⚠️  FIRESTORE_EMULATOR_HOST no configurada — se usa el Firestore REAL del proyecto de Firebase')
  }
  firestore = db
  return db
}
