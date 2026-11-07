import { Firestore, CollectionReference, DocumentReference } from 'firebase-admin/firestore'

// Firestore layout (everything per user hangs from users/{uid}):
//   users/{uid}                                  { email, createdAt, profile? }
//   users/{uid}/conversations/{id}               { title, createdAt }
//   users/{uid}/conversations/{id}/messages/{id} { role, content, createdAt }
//   users/{uid}/workouts/{wahooId}               WahooWorkout + { startedAtUtc, syncedAt }
//   users/{uid}/plannedWorkouts/{id}             PlannedWorkout (sin id ni userId), `date` = 'YYYY-MM-DD'
//   users/{uid}/private/wahoo                  Wahoo OAuth tokens (encrypted)
//   users/{uid}/private/workoutSync              { lastSyncedAt }
//   oauthStates/{state}                          { userId, expiresAt } — TTL policy on expiresAt

export const userDoc = (db: Firestore, uid: string): DocumentReference =>
  db.collection('users').doc(uid)

export const conversationsCol = (db: Firestore, uid: string): CollectionReference =>
  userDoc(db, uid).collection('conversations')

export const messagesCol = (db: Firestore, uid: string, conversationId: string): CollectionReference =>
  conversationsCol(db, uid).doc(conversationId).collection('messages')

export const workoutsCol = (db: Firestore, uid: string): CollectionReference =>
  userDoc(db, uid).collection('workouts')

export const plannedWorkoutsCol = (db: Firestore, uid: string): CollectionReference =>
  userDoc(db, uid).collection('plannedWorkouts')

export const privateDoc =(db: Firestore, uid: string, name: 'wahoo' | 'workoutSync'): DocumentReference =>
  userDoc(db, uid).collection('private').doc(name)

export const oauthStatesCol = (db: Firestore): CollectionReference =>
  db.collection('oauthStates')
