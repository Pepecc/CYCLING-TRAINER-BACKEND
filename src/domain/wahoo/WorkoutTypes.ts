import { WorkoutLocation } from './WahooWorkout'

// workout_type_id → nombre y ubicación, según la tabla de la Wahoo Cloud API
const OUTDOOR: Record<number, string> = {
  0: 'BIKING', 1: 'RUNNING', 3: 'RUNNING_TRACK', 4: 'RUNNING_TRAIL', 6: 'WALKING',
  7: 'WALKING_SPEED', 8: 'WALKING_NORDIC', 9: 'HIKING', 10: 'MOUNTAINEERING',
  11: 'BIKING_CYCLECROSS', 13: 'BIKING_MOUNTAIN', 14: 'BIKING_RECUMBENT', 15: 'BIKING_ROAD',
  16: 'BIKING_TRACK', 17: 'BIKING_MOTOCYCLING', 26: 'SWIMMING_OPEN_WATER', 27: 'SNOWBOARDING',
  28: 'SKIING', 29: 'SKIING_DOWNHILL', 30: 'SKIING_CROSS_COUNTRY', 31: 'SKATING',
  34: 'LONG_BOARDING', 35: 'SAILING', 36: 'WINDSURFING', 37: 'CANOEING', 38: 'KAYAKING',
  39: 'ROWING', 40: 'KITEBOARDING', 41: 'STAND_UP_PADDLE_BOARD', 45: 'WHEELCHAIR',
  46: 'GOLFING', 47: 'OTHER', 62: 'MULTISPORT', 63: 'TRANSITION', 64: 'EBIKING',
  65: 'TICKR_OFFLINE', 67: 'RUNNING_RACE', 70: 'HANDCYCLING',
}

const INDOOR: Record<number, string> = {
  2: 'FE', 5: 'RUNNING_TREADMILL', 12: 'BIKING_INDOOR', 18: 'FE_GENERAL', 19: 'FE_TREADMILL',
  20: 'FE_ELLIPTICAL', 21: 'FE_BIKE', 22: 'FE_ROWER', 23: 'FE_CLIMBER', 25: 'SWIMMING_LAP',
  32: 'SKATING_ICE', 33: 'SKATING_INLINE', 42: 'WORKOUT', 43: 'CARDIO_CLASS',
  44: 'STAIR_CLIMBER', 49: 'BIKING_INDOOR_CYCLING_CLASS', 56: 'WALKING_TREADMILL',
  61: 'BIKING_INDOOR_TRAINER', 66: 'YOGA', 68: 'BIKING_INDOOR_VIRTUAL',
  69: 'MENTAL_STRENGTH', 71: 'RUNNING_INDOOR_VIRTUAL',
}

export function describeWorkoutType(id: number | null | undefined): { name: string; location: WorkoutLocation } {
  if (id === null || id === undefined) return { name: 'UNKNOWN', location: 'unknown' }
  if (OUTDOOR[id]) return { name: OUTDOOR[id], location: 'outdoor' }
  if (INDOOR[id])  return { name: INDOOR[id],  location: 'indoor' }
  return { name: 'UNKNOWN', location: 'unknown' }
}

// Tipos de Wahoo que no son de bici: no se enlazan con el plan. Los dudosos (OTHER, WORKOUT,
// TICKR_OFFLINE, UNKNOWN…) cuentan como bici: la estática con pulsómetro puede quedar registrada así.
const NON_CYCLING = /^(RUNNING|WALKING|HIKING|MOUNTAINEERING|SWIMMING|SNOWBOARDING|SKIING|SKATING|LONG_BOARDING|SAILING|WINDSURFING|CANOEING|KAYAKING|ROWING|KITEBOARDING|STAND_UP|GOLFING|YOGA|MENTAL_STRENGTH|STAIR_CLIMBER|FE_TREADMILL|FE_ELLIPTICAL|FE_ROWER|FE_CLIMBER|BIKING_MOTOCYCLING)/

export function isCyclingWorkoutType(name: string): boolean {
  return !NON_CYCLING.test(name)
}
