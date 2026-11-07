import { getFirestore } from '../infrastructure/firebase/firebaseAdmin'
import { FirestoreUserRepository } from '../infrastructure/persistence/firestore/FirestoreUserRepository'
import { FirestoreProfileRepository } from '../infrastructure/persistence/firestore/FirestoreProfileRepository'
import { FirestoreConversationRepository } from '../infrastructure/persistence/firestore/FirestoreConversationRepository'
import { FirestoreWahooTokenRepository } from '../infrastructure/persistence/firestore/FirestoreWahooTokenRepository'
import { FirestoreOAuthStateRepository } from '../infrastructure/persistence/firestore/FirestoreOAuthStateRepository'
import { FirestoreWorkoutRepository } from '../infrastructure/persistence/firestore/FirestoreWorkoutRepository'
import { FirestorePlannedWorkoutRepository } from '../infrastructure/persistence/firestore/FirestorePlannedWorkoutRepository'
import { OAuthStateRepository } from '../domain/wahoo/OAuthStateRepository'
import { OpenAIAdapter } from '../infrastructure/ai/OpenAIAdapter'
import { WahooOAuthService } from '../infrastructure/wahoo/WahooOAuthService'
import { configureAuth } from '../infrastructure/http/middleware/auth'

import { UpdateProfile } from '../application/profile/UpdateProfile'
import { GetProfile } from '../application/profile/GetProfile'
import { SendMessage } from '../application/chat/SendMessage'
import { GetConversations } from '../application/chat/GetConversations'
import { GetConversation } from '../application/chat/GetConversation'
import { GetWahooWorkouts } from '../application/wahoo/GetWahooWorkouts'
import { AnalyzeWahooWorkout } from '../application/wahoo/AnalyzeWahooWorkout'
import { SyncWahooWorkouts } from '../application/wahoo/SyncWahooWorkouts'
import { DisconnectWahoo } from '../application/wahoo/DisconnectWahoo'
import { ToolExecutor } from '../infrastructure/ai/tools/ToolExecutor'
import { PlanningTools } from '../infrastructure/ai/tools/PlanningTools'
import { SavePlannedWorkouts } from '../application/planning/SavePlannedWorkouts'
import { UpdatePlannedWorkout } from '../application/planning/UpdatePlannedWorkout'
import { DeletePlannedWorkout } from '../application/planning/DeletePlannedWorkout'
import { GetTrainingPlan } from '../application/planning/GetTrainingPlan'

export interface Container {
  updateProfile:       UpdateProfile
  getProfile:          GetProfile
  sendMessage:         SendMessage
  getConversations:    GetConversations
  getConversation:     GetConversation
  wahooService:        WahooOAuthService
  oauthStates:         OAuthStateRepository
  syncWorkouts:        SyncWahooWorkouts
  getWahooWorkouts:    GetWahooWorkouts
  analyzeWahooWorkout: AnalyzeWahooWorkout
  disconnectWahoo:     DisconnectWahoo
  savePlannedWorkouts: SavePlannedWorkouts
  updatePlannedWorkout: UpdatePlannedWorkout
  deletePlannedWorkout: DeletePlannedWorkout
  getTrainingPlan:     GetTrainingPlan
}

export function buildContainer(): Container {
  // --- Database (Firestore; the local emulator when FIRESTORE_EMULATOR_HOST is set) ---
  const db = getFirestore()

  // --- Repositories ---
  const userRepository         = new FirestoreUserRepository(db)
  const profileRepository      = new FirestoreProfileRepository(db)
  const conversationRepository = new FirestoreConversationRepository(db)
  const wahooTokenRepository   = new FirestoreWahooTokenRepository(db)
  const oauthStateRepository   = new FirestoreOAuthStateRepository(db)
  const workoutRepository      = new FirestoreWorkoutRepository(db)
  const plannedWorkoutRepository = new FirestorePlannedWorkoutRepository(db)

  // --- Configure Firebase auth middleware ---
  configureAuth(userRepository)

  // --- External services ---
  const aiPort       = new OpenAIAdapter()
  const wahooService = new WahooOAuthService(wahooTokenRepository)

  // --- Use cases ---
  const updateProfile = new UpdateProfile(profileRepository)
  const syncWorkouts  = new SyncWahooWorkouts(wahooService, workoutRepository)
  const savePlannedWorkouts  = new SavePlannedWorkouts(plannedWorkoutRepository, profileRepository)
  const updatePlannedWorkout = new UpdatePlannedWorkout(plannedWorkoutRepository, profileRepository)
  const deletePlannedWorkout = new DeletePlannedWorkout(plannedWorkoutRepository)
  const getTrainingPlan      = new GetTrainingPlan(plannedWorkoutRepository, profileRepository)
  const planningTools = new PlanningTools(savePlannedWorkouts, updatePlannedWorkout, deletePlannedWorkout, getTrainingPlan, profileRepository)
  const toolExecutor  = new ToolExecutor(syncWorkouts, workoutRepository, profileRepository, updateProfile, planningTools)
  const sendMessage   = new SendMessage(conversationRepository, profileRepository, aiPort, toolExecutor)

  return {
    updateProfile,
    getProfile:          new GetProfile(profileRepository),
    sendMessage,
    getConversations:    new GetConversations(conversationRepository),
    getConversation:     new GetConversation(conversationRepository),
    wahooService,
    oauthStates:         oauthStateRepository,
    syncWorkouts,
    getWahooWorkouts:    new GetWahooWorkouts(syncWorkouts, workoutRepository),
    analyzeWahooWorkout: new AnalyzeWahooWorkout(wahooService, profileRepository),
    disconnectWahoo:     new DisconnectWahoo(wahooService, workoutRepository),
    savePlannedWorkouts,
    updatePlannedWorkout,
    deletePlannedWorkout,
    getTrainingPlan,
  }
}
