import { WahooToken } from '../../domain/wahoo/WahooToken'
import { WahooWorkout } from '../../domain/wahoo/WahooWorkout'
import { WahooTokenRepository } from '../../domain/wahoo/WahooTokenRepository'
import { describeWorkoutType } from '../../domain/wahoo/WorkoutTypes'

const WAHOO_BASE_URL = 'https://api.wahooligan.com'
const DEFAULT_SCOPES = 'email power_zones_read workouts_read plans_read routes_read offline_data user_read'
const MAX_PER_PAGE = 50
const MAX_PAGES = 20  // tope de seguridad: 1000 entrenos por consulta

// Raw shapes returned by Wahoo API (numeric fields may arrive as strings)
type NumLike = number | string | null | undefined

interface WahooTokenResponse {
  access_token: string
  refresh_token: string
  expires_in: number
  token_type: string
}

interface WahooWorkoutSummaryRaw {
  ascent_accum?: NumLike
  cadence_avg?: NumLike
  calories_accum?: NumLike
  distance_accum?: NumLike
  duration_active_accum?: NumLike
  duration_total_accum?: NumLike
  heart_rate_avg?: NumLike
  power_avg?: NumLike
  power_bike_np_last?: NumLike
  power_bike_tss_last?: NumLike
  speed_avg?: NumLike
  work_accum?: NumLike
  time_zone?: string | null
}

interface WahooWorkoutRaw {
  id: number
  name: string | null
  starts: string
  minutes: NumLike
  workout_type_id: number | null
  workout_summary: WahooWorkoutSummaryRaw | null
}

interface WahooWorkoutsResponse {
  workouts: WahooWorkoutRaw[]
  total: number
  page: number
  per_page: number
}

export class WahooNotConnectedError extends Error {
  constructor() {
    super('Usuario no conectado a Wahoo')
  }
}

export class WahooOAuthService {
  private readonly clientId: string
  private readonly clientSecret: string
  private readonly redirectUri: string
  private readonly scopes: string

  constructor(private readonly tokenRepository: WahooTokenRepository) {
    this.clientId = process.env.WAHOO_CLIENT_ID ?? ''
    this.clientSecret = process.env.WAHOO_CLIENT_SECRET ?? ''
    this.redirectUri = process.env.WAHOO_REDIRECT_URI ?? ''
    this.scopes = process.env.WAHOO_SCOPES?.trim() || DEFAULT_SCOPES

    if (!this.clientId || !this.clientSecret || !this.redirectUri) {
      console.warn('⚠️  Wahoo OAuth credentials not configured — integration disabled')
    }
  }

  // ─── Step 1: Build the authorization URL ────────────────────────────────────

  buildAuthorizationUrl(state: string): string {
    const params = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: this.redirectUri,
      response_type: 'code',
      state,
    })
    // Wahoo expects spaces encoded as %20, not '+', so scope is appended manually
    return `${WAHOO_BASE_URL}/oauth/authorize?${params.toString()}&scope=${encodeURIComponent(this.scopes)}`
  }

  // ─── Step 2: Exchange code for tokens ───────────────────────────────────────

  async exchangeCode(userId: string, code: string): Promise<WahooToken> {
    const data = await this.requestToken({
      code,
      redirect_uri: this.redirectUri,
      grant_type: 'authorization_code',
    }, 'token exchange')

    const token = WahooToken.create({
      userId,
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresIn: data.expires_in,
    })

    await this.tokenRepository.save(token)
    return token
  }

  // ─── Token refresh ───────────────────────────────────────────────────────────

  async refreshToken(userId: string): Promise<WahooToken> {
    const existing = await this.tokenRepository.findByUserId(userId)
    if (!existing) throw new WahooNotConnectedError()

    const data = await this.requestToken({
      refresh_token: existing.refreshToken,
      grant_type: 'refresh_token',
    }, 'token refresh')

    existing.accessToken = data.access_token
    existing.refreshToken = data.refresh_token
    existing.expiresAt = new Date(Date.now() + data.expires_in * 1000).toISOString()

    await this.tokenRepository.save(existing)
    return existing
  }

  // ─── Get valid token (auto-refresh if needed) ────────────────────────────────

  async getValidToken(userId: string): Promise<WahooToken> {
    const token = await this.tokenRepository.findByUserId(userId)
    if (!token) throw new WahooNotConnectedError()

    if (token.isExpired()) {
      return this.refreshToken(userId)
    }

    return token
  }

  // ─── Fetch one page of workouts (most recent first) ─────────────────────────

  async getWorkouts(userId: string, page = 1, perPage = 10): Promise<WahooWorkout[]> {
    const data = await this.fetchWorkoutsPage(userId, page, Math.min(perPage, MAX_PER_PAGE))
    return data.workouts.map(w => this.mapWorkout(w))
  }

  // ─── Fetch every workout that started on or after `since` ───────────────────
  // Wahoo always returns workouts sorted by `starts` descending, so we page
  // until we reach one older than `since` or run out of results.

  async getWorkoutsSince(userId: string, since: Date): Promise<WahooWorkout[]> {
    const result: WahooWorkout[] = []

    for (let page = 1; page <= MAX_PAGES; page++) {
      const data = await this.fetchWorkoutsPage(userId, page, MAX_PER_PAGE)
      const workouts = data.workouts.map(w => this.mapWorkout(w))

      for (const w of workouts) {
        if (new Date(w.startedAt) >= since) result.push(w)
      }

      const oldest = workouts[workouts.length - 1]
      const reachedEnd = workouts.length < MAX_PER_PAGE || page * MAX_PER_PAGE >= data.total
      if (reachedEnd || !oldest || new Date(oldest.startedAt) < since) break
    }

    return result
  }

  // ─── Fetch single workout (includes workout_summary) ────────────────────────

  async getWorkout(userId: string, workoutId: number): Promise<WahooWorkout> {
    const workout = await this.authorizedGet<WahooWorkoutRaw>(userId, `/v1/workouts/${workoutId}`, 'workout fetch')
    return this.mapWorkout(workout)
  }

  // ─── Check if user has connected Wahoo ──────────────────────────────────────

  async isConnected(userId: string): Promise<boolean> {
    const token = await this.tokenRepository.findByUserId(userId)
    return token !== null
  }

  // ─── Disconnect: revoke permissions in Wahoo and delete local tokens ────────

  async disconnect(userId: string): Promise<void> {
    try {
      const token = await this.getValidToken(userId)
      const res = await fetch(`${WAHOO_BASE_URL}/v1/permissions`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token.accessToken}` },
      })
      if (!res.ok && res.status !== 401) {
        console.warn(`Wahoo revoke failed: ${res.status} ${await res.text()}`)
      }
    } catch (err) {
      // Best effort: even if Wahoo is unreachable, the local tokens are removed
      if (!(err instanceof WahooNotConnectedError)) console.warn('Wahoo revoke error:', err)
    }

    await this.tokenRepository.deleteByUserId(userId)
  }

  // ─── Private helpers ─────────────────────────────────────────────────────────

  private fetchWorkoutsPage(userId: string, page: number, perPage: number): Promise<WahooWorkoutsResponse> {
    const params = new URLSearchParams({ page: String(page), per_page: String(perPage) })
    return this.authorizedGet<WahooWorkoutsResponse>(userId, `/v1/workouts?${params.toString()}`, 'workouts fetch')
  }

  // GET against the Wahoo API; on 401 refreshes the token once and retries
  private async authorizedGet<T>(userId: string, path: string, label: string): Promise<T> {
    let token = await this.getValidToken(userId)

    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await fetch(`${WAHOO_BASE_URL}${path}`, {
        headers: { Authorization: `Bearer ${token.accessToken}` },
      })

      if (res.status === 401 && attempt === 0) {
        token = await this.refreshToken(userId)
        continue
      }

      if (!res.ok) {
        const body = await res.text()
        throw new Error(`Wahoo ${label} failed: ${res.status} ${body}`)
      }

      return await res.json() as T
    }

    throw new Error(`Wahoo ${label} failed: unauthorized`)
  }

  private async requestToken(params: Record<string, string>, label: string): Promise<WahooTokenResponse> {
    // Params go in the query string, as in Wahoo's documented examples
    const query = new URLSearchParams({
      client_id: this.clientId,
      client_secret: this.clientSecret,
      ...params,
    })

    const res = await fetch(`${WAHOO_BASE_URL}/oauth/token?${query.toString()}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    })

    if (!res.ok) {
      const text = await res.text()
      throw new Error(`Wahoo ${label} failed: ${res.status} ${text}`)
    }

    return await res.json() as WahooTokenResponse
  }

  private mapWorkout(raw: WahooWorkoutRaw): WahooWorkout {
    const s = raw.workout_summary
    const type = describeWorkoutType(raw.workout_type_id)
    const speedMs = num(s?.speed_avg)
    const workJ = num(s?.work_accum)

    return {
      id: raw.id,
      name: raw.name || 'Entrenamiento',
      startedAt: raw.starts,
      durationMinutes: num(raw.minutes) ?? 0,
      workoutTypeId: raw.workout_type_id ?? null,
      workoutTypeName: type.name,
      location: type.location,
      summary: s ? {
        durationActiveSeconds: num(s.duration_active_accum),
        durationTotalSeconds:  num(s.duration_total_accum),
        distanceInMeters:      num(s.distance_accum),
        ascentInMeters:        num(s.ascent_accum),
        calories:              num(s.calories_accum),
        heartRateAvg:          round(num(s.heart_rate_avg)),
        powerAvg:              round(num(s.power_avg)),
        normalizedPower:       round(num(s.power_bike_np_last)),
        tss:                   round(num(s.power_bike_tss_last)),
        cadenceAvg:            round(num(s.cadence_avg)),
        speedAvgKmh:           speedMs !== null ? Math.round(speedMs * 3.6 * 10) / 10 : null,
        workKj:                workJ !== null ? Math.round(workJ / 1000) : null,
        timeZone:              s.time_zone ?? null,
      } : null,
    }
  }
}

// Wahoo sends numbers as strings (e.g. "215.0"); 0 or missing → null
function num(v: NumLike): number | null {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) && n !== 0 ? n : null
}

function round(v: number | null): number | null {
  return v === null ? null : Math.round(v)
}
