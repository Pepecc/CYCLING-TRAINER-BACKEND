// Value object que representa un workout de Wahoo con su resumen
// Campos basados en la Wahoo Cloud API (GET /v1/workouts, objeto workout_summary)
// Wahoo no expone FC máxima, potencia máxima ni IF: el IF se calcula con el FTP del perfil.

export type WorkoutLocation = 'indoor' | 'outdoor' | 'unknown'

export interface WahooWorkoutSummaryData {
  durationActiveSeconds: number | null   // duration_active_accum (sin pausas)
  durationTotalSeconds: number | null    // duration_total_accum
  distanceInMeters: number | null        // distance_accum
  ascentInMeters: number | null          // ascent_accum
  calories: number | null                // calories_accum
  heartRateAvg: number | null            // heart_rate_avg
  powerAvg: number | null                // power_avg
  normalizedPower: number | null         // power_bike_np_last
  tss: number | null                     // power_bike_tss_last
  cadenceAvg: number | null              // cadence_avg
  speedAvgKmh: number | null             // speed_avg (m/s en la API)
  workKj: number | null                  // work_accum (julios en la API)
  timeZone: string | null                // time_zone
}

export interface WahooWorkout {
  id: number
  name: string
  startedAt: string                // ISO date
  durationMinutes: number
  workoutTypeId: number | null
  workoutTypeName: string          // p.ej. 'BIKING_ROAD', 'BIKING_INDOOR_TRAINER'
  location: WorkoutLocation
  summary: WahooWorkoutSummaryData | null
}
