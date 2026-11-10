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
import { AdaptPlannedWorkout } from '../application/planning/AdaptPlannedWorkout'
import { ReconcilePlan } from '../application/planning/ReconcilePlan'
import { ReplanWeek } from '../application/planning/ReplanWeek'
import { GetFormProjection } from '../application/planning/GetFormProjection'
import { FirestoreRaceEventRepository } from '../infrastructure/persistence/firestore/FirestoreRaceEventRepository'
import { SeasonTools } from '../infrastructure/ai/tools/SeasonTools'
import { SaveRaceEvents } from '../application/events/SaveRaceEvents'
import { UpdateRaceEvent } from '../application/events/UpdateRaceEvent'
import { DeleteRaceEvent } from '../application/events/DeleteRaceEvent'
import { GetRaceEvents } from '../application/events/GetRaceEvents'
import { GetSeasonPlan } from '../application/events/GetSeasonPlan'
import { PreviewPlanImport } from '../application/planning/PreviewPlanImport'
import { ImportPlannedWorkouts } from '../application/planning/ImportPlannedWorkouts'
import { ExtractPlanFromImage } from '../application/planning/ExtractPlanFromImage'
import { TrainingPeaksParser } from '../infrastructure/import/TrainingPeaksParser'
import { NativePlanParser } from '../infrastructure/import/NativePlanParser'
import { AIPlanImageExtractor } from '../infrastructure/ai/AIPlanImageExtractor'
import { ConversationRepository } from '../domain/chat/ConversationRepository'
import { FirestoreCheckInRepository } from '../infrastructure/persistence/firestore/FirestoreCheckInRepository'
import { FirestoreFitnessTestRepository } from '../infrastructure/persistence/firestore/FirestoreFitnessTestRepository'
import { SaveDailyCheckIn } from '../application/wellness/SaveDailyCheckIn'
import { GetDailyCheckIns } from '../application/wellness/GetDailyCheckIns'
import { DeleteDailyCheckIn } from '../application/wellness/DeleteDailyCheckIn'
import { GetFitnessTests } from '../application/testing/GetFitnessTests'
import { ScheduleFitnessTest } from '../application/testing/ScheduleFitnessTest'
import { RecordFitnessTest } from '../application/testing/RecordFitnessTest'
import { GetWeeklySummary } from '../application/planning/GetWeeklySummary'
import { ExportPlannedWorkout } from '../application/planning/ExportPlannedWorkout'
import { FitWorkoutEncoder } from '../infrastructure/export/FitWorkoutEncoder'
import { ZwoWorkoutEncoder } from '../infrastructure/export/ZwoWorkoutEncoder'
import { ProgressTools } from '../infrastructure/ai/tools/ProgressTools'

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
  adaptPlannedWorkout: AdaptPlannedWorkout
  reconcilePlan:       ReconcilePlan
  replanWeek:          ReplanWeek
  getFormProjection:   GetFormProjection
  saveRaceEvents:      SaveRaceEvents
  updateRaceEvent:     UpdateRaceEvent
  deleteRaceEvent:     DeleteRaceEvent
  getRaceEvents:       GetRaceEvents
  getSeasonPlan:       GetSeasonPlan
  previewPlanImport:   PreviewPlanImport
  importPlannedWorkouts: ImportPlannedWorkouts
  extractPlanFromImage: ExtractPlanFromImage
  conversationRepository: ConversationRepository
  saveDailyCheckIn:    SaveDailyCheckIn
  getDailyCheckIns:    GetDailyCheckIns
  deleteDailyCheckIn:  DeleteDailyCheckIn
  getFitnessTests:     GetFitnessTests
  scheduleFitnessTest: ScheduleFitnessTest
  recordFitnessTest:   RecordFitnessTest
  getWeeklySummary:    GetWeeklySummary
  exportPlannedWorkout: ExportPlannedWorkout
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
  const raceEventRepository    = new FirestoreRaceEventRepository(db)
  const checkInRepository      = new FirestoreCheckInRepository(db)
  const fitnessTestRepository  = new FirestoreFitnessTestRepository(db)

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
  const adaptPlannedWorkout  = new AdaptPlannedWorkout(plannedWorkoutRepository, profileRepository)
  const saveRaceEvents  = new SaveRaceEvents(raceEventRepository)
  const updateRaceEvent = new UpdateRaceEvent(raceEventRepository)
  const deleteRaceEvent = new DeleteRaceEvent(raceEventRepository)
  const getRaceEvents   = new GetRaceEvents(raceEventRepository)
  const getSeasonPlan   = new GetSeasonPlan(raceEventRepository)
  const reconcilePlan   = new ReconcilePlan(syncWorkouts, workoutRepository, plannedWorkoutRepository, profileRepository)
  const replanWeek      = new ReplanWeek(plannedWorkoutRepository, profileRepository, reconcilePlan, getSeasonPlan)
  const getFormProjection = new GetFormProjection(workoutRepository, plannedWorkoutRepository, profileRepository, reconcilePlan, getSeasonPlan)
  const planningTools = new PlanningTools(
    savePlannedWorkouts, updatePlannedWorkout, deletePlannedWorkout, getTrainingPlan, profileRepository, adaptPlannedWorkout,
    reconcilePlan, replanWeek, getFormProjection
  )
  const seasonTools   = new SeasonTools(saveRaceEvents, updateRaceEvent, deleteRaceEvent, getRaceEvents, getSeasonPlan)
  const getDailyCheckIns    = new GetDailyCheckIns(checkInRepository, profileRepository)
  const saveDailyCheckIn    = new SaveDailyCheckIn(checkInRepository, getDailyCheckIns)
  const getFitnessTests     = new GetFitnessTests(fitnessTestRepository, plannedWorkoutRepository, profileRepository, getSeasonPlan)
  const scheduleFitnessTest = new ScheduleFitnessTest(plannedWorkoutRepository, profileRepository)
  const recordFitnessTest   = new RecordFitnessTest(fitnessTestRepository, plannedWorkoutRepository, profileRepository, checkInRepository, updateProfile)
  const getWeeklySummary    = new GetWeeklySummary(reconcilePlan, getTrainingPlan, workoutRepository, profileRepository, getDailyCheckIns, getSeasonPlan)
  const progressTools = new ProgressTools(saveDailyCheckIn, getDailyCheckIns, getFitnessTests, scheduleFitnessTest, recordFitnessTest, getWeeklySummary)
  const toolExecutor  = new ToolExecutor(syncWorkouts, workoutRepository, profileRepository, updateProfile, planningTools, seasonTools, progressTools)
  const sendMessage   = new SendMessage(conversationRepository, profileRepository, aiPort, toolExecutor, getSeasonPlan, reconcilePlan, getDailyCheckIns)
  const previewPlanImport = new PreviewPlanImport(
    [new TrainingPeaksParser(), new NativePlanParser()], plannedWorkoutRepository, profileRepository
  )
  const importPlannedWorkouts = new ImportPlannedWorkouts(plannedWorkoutRepository, profileRepository)
  const extractPlanFromImage  = new ExtractPlanFromImage(new AIPlanImageExtractor(aiPort), previewPlanImport, profileRepository)

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
    adaptPlannedWorkout,
    reconcilePlan,
    replanWeek,
    getFormProjection,
    saveRaceEvents,
    updateRaceEvent,
    deleteRaceEvent,
    getRaceEvents,
    getSeasonPlan,
    previewPlanImport,
    importPlannedWorkouts,
    extractPlanFromImage,
    conversationRepository,
    saveDailyCheckIn,
    getDailyCheckIns,
    deleteDailyCheckIn: new DeleteDailyCheckIn(checkInRepository),
    getFitnessTests,
    scheduleFitnessTest,
    recordFitnessTest,
    getWeeklySummary,
    exportPlannedWorkout: new ExportPlannedWorkout(plannedWorkoutRepository, profileRepository, [new FitWorkoutEncoder(), new ZwoWorkoutEncoder()]),
  }
}
