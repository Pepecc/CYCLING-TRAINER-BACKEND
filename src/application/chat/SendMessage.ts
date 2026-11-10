import { Conversation } from '../../domain/chat/Conversation'
import { randomUUID } from 'crypto'
import { APIMessage, Message, MessageAttachment } from '../../domain/chat/Message'
import { ImageInput, parseImages } from '../../domain/chat/ImageAttachment'
import { ConversationRepository } from '../../domain/chat/ConversationRepository'
import { CyclistProfileRepository } from '../../domain/profile/CyclistProfileRepository'
import { CyclistProfile } from '../../domain/profile/CyclistProfile'
import { AIPort, ToolExecutorFn } from '../../domain/chat/AIPort'
import { ToolExecutor } from '../../infrastructure/ai/tools/ToolExecutor'
import { toolDefinitions } from '../../infrastructure/ai/tools/ToolDefinitions'

import { formatDate, formatDayKey } from '../../domain/training/calendar'
import { Experience } from '../../domain/profile/CyclistProfile'
import { SeasonPlan } from '../../domain/events/seasonPlan'
import { GetSeasonPlan } from '../events/GetSeasonPlan'
import { PHASE_GUIDE, PHASE_LABELS } from '../../infrastructure/ai/tools/SeasonTools'
import { ReconcilePlan, ReconcileOutcome } from '../planning/ReconcilePlan'
import { dayKey, mondayKey } from '../../domain/training/calendar'
import { GetDailyCheckIns, CheckInWithReadiness } from '../wellness/GetDailyCheckIns'
import { READINESS_GUIDE } from '../../domain/wellness/DailyCheckIn'
import { READINESS_LABELS } from '../../infrastructure/ai/tools/ProgressTools'

const MAX_RACES_IN_PROMPT = 8
const CONTEXT_MESSAGES = 20
// Images are sent again only while they are among the last messages (each one costs ~1000 tokens)
const IMAGE_CONTEXT_MESSAGES = 6

import fs from 'fs';
import path from 'path';

const EXPERIENCE_LABELS: Record<Experience, string> = {
  beginner: 'principiante',
  intermediate: 'intermedio',
  advanced: 'avanzado',
}

const basePrompt = fs.readFileSync(
  path.join(__dirname, '../../infrastructure/ai/prompts/coach.md'),
  'utf-8'
)

interface SendMessageInput {
  userId: string
  content: string
  conversationId?: string | null
  images?: unknown              // [{ mediaType, data (base64), name? }], se valida
}

interface SendMessageOutput {
  conversationId: string
  message: Message
}

export class SendMessage {
  constructor(
    private readonly conversationRepository: ConversationRepository,
    private readonly profileRepository: CyclistProfileRepository,
    private readonly aiPort: AIPort,
    private readonly toolExecutor: ToolExecutor | null = null,
    private readonly getSeasonPlan: GetSeasonPlan | null = null,
    private readonly reconcilePlan: ReconcilePlan | null = null,
    private readonly getCheckIns: GetDailyCheckIns | null = null
  ) {}

  async execute({ userId, content: rawContent, conversationId, images: rawImages }: SendMessageInput): Promise<SendMessageOutput> {
    const content = typeof rawContent === 'string' ? rawContent.trim() : ''
    const images = parseImages(rawImages)   // throws ImageValidationError
    if (!content && images.length === 0) throw new Error('El mensaje no puede estar vacío')

    // Load or create conversation
    let conversation: Conversation
    if (conversationId) {
      const found = await this.conversationRepository.findById(userId, conversationId)
      if (!found || found.userId !== userId) throw new Error('Conversación no encontrada')
      conversation = found
    } else {
      conversation = Conversation.create({ userId, title: content.slice(0, 50) || 'Imagen' })
      await this.conversationRepository.save(conversation)
    }

    const [profile, season, week, checkIn] = await Promise.all([
      this.profileRepository.findByUserId(userId),
      this.loadSeason(userId),
      this.loadWeek(userId),
      this.loadCheckIn(userId),
    ])
    const systemPrompt = this.buildSystemPrompt(profile, season, week, checkIn)

    // Persist the images (one document each), then the user message that references them
    const attachments = await this.saveImages(userId, conversation.id, images)
    const userMessage = Message.create({
      conversationId: conversation.id,
      role: 'user',
      content,
      attachments,
    })
    await this.conversationRepository.saveMessage(userId, userMessage)
    conversation.addMessage(userMessage)

    // Bind the tool executor to this request's userId (never shared between requests)
    const toolExecutor = this.toolExecutor
    const executeTool: ToolExecutorFn | undefined = toolExecutor
      ? (toolName, args) => toolExecutor.execute(userId, toolName, args)
      : undefined

    // Call AI — pass tools only if executor is available
    const contextMessages = await this.buildContext(userId, conversation, userMessage, images)
    const tools = executeTool ? toolDefinitions : undefined
    const assistantContent = await this.aiPort.complete(systemPrompt, contextMessages, tools, executeTool)

    // Persist assistant response
    const assistantMessage = Message.create({
      conversationId: conversation.id,
      role: 'assistant',
      content: assistantContent,
    })
    await this.conversationRepository.saveMessage(userId, assistantMessage)

    return { conversationId: conversation.id, message: assistantMessage }
  }

  private async saveImages(userId: string, conversationId: string, images: ImageInput[]): Promise<MessageAttachment[]> {
    return Promise.all(images.map(async (img, i) => {
      const attachment: MessageAttachment = {
        id: randomUUID(),
        mediaType: img.mediaType,
        name: img.name ?? `imagen-${i + 1}`,
        sizeBytes: Buffer.byteLength(img.data, 'base64'),
      }
      await this.conversationRepository.saveAttachment(userId, conversationId, { ...attachment, data: img.data })
      return attachment
    }))
  }

  // Last messages in API format; recent ones keep their images so the coach can still look at them
  private async buildContext(
    userId: string, conversation: Conversation, current: Message, currentImages: ImageInput[]
  ): Promise<APIMessage[]> {
    const recent = conversation.messages.slice(-CONTEXT_MESSAGES)
    return Promise.all(recent.map(async (m, i) => {
      const api = m.toAPIFormat()
      if (m.attachments.length === 0 || i < recent.length - IMAGE_CONTEXT_MESSAGES) return api
      if (m.id === current.id) {
        return { ...api, images: currentImages.map(img => ({ mediaType: img.mediaType, data: img.data })) }
      }
      const stored = await Promise.all(
        m.attachments.map(a => this.conversationRepository.findAttachment(userId, conversation.id, a.id))
      )
      const found = stored.filter((a): a is NonNullable<typeof a> => a !== null)
      return found.length ? { ...api, images: found.map(a => ({ mediaType: a.mediaType, data: a.data })) } : api
    }))
  }

  private async loadSeason(userId: string): Promise<SeasonPlan | null> {
    if (!this.getSeasonPlan) return null
    try {
      return await this.getSeasonPlan.execute(userId)
    } catch (err) {
      console.error('Season plan for the system prompt failed:', err)
      return null
    }
  }

  // This week so far, linked with Wahoo (null without Wahoo or if it fails: the chat must keep working)
  private async loadWeek(userId: string): Promise<ReconcileOutcome | null> {
    if (!this.reconcilePlan) return null
    try {
      const today = dayKey(new Date())
      const outcome = await this.reconcilePlan.execute(userId, mondayKey(today), today)
      return outcome.linked ? outcome : null
    } catch (err) {
      console.error('Week status for the system prompt failed:', err)
      return null
    }
  }

  private async loadCheckIn(userId: string): Promise<CheckInWithReadiness | null | undefined> {
    if (!this.getCheckIns) return undefined
    try {
      return await this.getCheckIns.today(userId)
    } catch (err) {
      console.error('Check-in for the system prompt failed:', err)
      return undefined
    }
  }

  // Today's check-in and readiness (undefined = not available: the section is left out)
  private buildCheckInSection(checkIn: CheckInWithReadiness | null | undefined): string | null {
    const isMonday = new Date(`${dayKey(new Date())}T12:00:00Z`).getUTCDay() === 1
    const monday = isMonday ? '\nHoy es lunes: si no lo habéis visto, ofrece el resumen de la semana pasada (get_weekly_summary).' : ''
    if (checkIn === undefined) return monday ? monday.trim() : null
    if (checkIn === null) {
      return 'CHECK-IN DE HOY: sin hacer. Si te cuenta cómo ha dormido o cómo se encuentra, guárdalo con save_daily_checkin.' + monday
    }
    const c = checkIn.checkIn
    const r = checkIn.readiness
    const parts = [
      c.fatigue !== null ? `cansancio ${c.fatigue}/5` : null,
      c.sleepHours !== null ? `${c.sleepHours} h de sueño` : null,
      c.sleepQuality !== null ? `calidad del sueño ${c.sleepQuality}/5` : null,
      c.feeling !== null ? `sensaciones ${c.feeling}/5` : null,
      c.soreness !== null ? `dolor muscular ${c.soreness}/5` : null,
      c.morningHr !== null ? `FC al despertar ${c.morningHr} ppm` : null,
      c.notes ? `notas: "${c.notes}"` : null,
    ].filter(Boolean)
    const lines = [
      `CHECK-IN DE HOY: ${parts.join(', ')}.`,
      `Disponibilidad: ${READINESS_LABELS[r.level]}${r.reasons.length ? ` (${r.reasons.join('; ')})` : ''}. ${READINESS_GUIDE[r.level]}`,
    ]
    if (r.level === 'caution' || r.level === 'rest') {
      lines.push('Si hoy tiene una sesión de calidad, coméntalo y propón adaptarla (adapt_planned_workout con menos minutos) o cambiarla por resistencia suave o descanso; no cambies nada sin su conformidad.')
    }
    return lines.join('\n') + monday
  }

  private buildWeekSection(week: ReconcileOutcome | null): string | null {
    if (!week) return null
    const today = dayKey(new Date())
    const past = week.planned.filter(w => w.date <= today && w.focus !== 'rest')
    const unplanned = week.unplanned.filter(a => dayKey(new Date(a.startedAt)) <= today)
    if (past.length === 0 && unplanned.length === 0) return null

    const day = (d: string) => formatDayKey(d, { weekday: 'long', day: 'numeric' })
    const list = (status: string) => past
      .filter(w => w.status === status)
      .map(w => `${w.title} (${day(w.date)}${w.completion?.durationPercent != null ? `, ${w.completion.durationPercent} % de la duración` : ''})`)
    const done = list('done')
    const partial = list('partial')
    const skipped = list('skipped')
    const pendingToday = past.filter(w => w.date === today && w.status === 'planned').map(w => w.title)

    const lines = [`PLAN ESTA SEMANA (enlazado con Wahoo, del lunes a hoy):`]
    if (done.length) lines.push(`- Hechos: ${done.join('; ')}`)
    if (partial.length) lines.push(`- Parciales: ${partial.join('; ')}`)
    if (skipped.length) lines.push(`- Saltados: ${skipped.join('; ')}`)
    if (pendingToday.length) lines.push(`- Pendiente hoy: ${pendingToday.join('; ')}`)
    if (unplanned.length) {
      lines.push(`- Sin planificar: ${unplanned.map(a => `${a.name} (${day(dayKey(new Date(a.startedAt)))}, ${a.durationMinutes} min)`).join('; ')}`)
    }
    if (skipped.length) {
      lines.push('Si el ciclista habla de la semana o de lo que le toca, comenta los saltados y ofrece replanificar con replan_week (vista previa primero).')
    }
    return lines.join('\n')
  }

  private buildSystemPrompt(
    profile: CyclistProfile | null,
    season: SeasonPlan | null,
    week: ReconcileOutcome | null = null,
    checkIn: CheckInWithReadiness | null | undefined = undefined
  ): string {
    const today = formatDate(new Date(), { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
    const p = profile ?? CyclistProfile.create('')

    const fields: Array<[string, string | null]> = [
      ['FTP', p.ftp ? `${p.ftp}w` : null],
      ['Peso', p.weightKg ? `${p.weightKg}kg` : null],
      ['W/kg', p.wattsPerKg ? String(p.wattsPerKg) : null],
      ['Horas disponibles/semana', p.hoursPerWeek ? `${p.hoursPerWeek}h` : null],
      ['Días disponibles', p.availableDays],
      ['Nivel', profile ? EXPERIENCE_LABELS[p.experience] : null],
      ['Objetivo', p.goal],
      ['FC máxima', p.maxHr ? `${p.maxHr} ppm` : null],
      ['FC en reposo', p.restingHr ? `${p.restingHr} ppm` : null],
      ['Lesiones / limitaciones', p.limitations],
    ]

    const known = fields.filter(([, v]) => v !== null).map(([k, v]) => `- ${k}: ${v}`)
    const missing = fields.filter(([k, v]) => v === null && k !== 'W/kg').map(([k]) => k)

    const zones = p.powerZones
    const zonesText = zones
      ? Object.entries(zones)
          .map(([z, d]) => `  ${z.toUpperCase()} ${d.name}: ${d.min}w${d.max ? ` - ${d.max}w` : '+'}`)
          .join('\n')
      : null

    const sections = [
      basePrompt,
      `FECHA DE HOY: ${today}`,
      `PERFIL DEL CICLISTA (datos guardados):\n${known.length ? known.join('\n') : '- Sin datos todavía'}`,
    ]

    if (missing.length) {
      sections.push(
        `DATOS QUE FALTAN EN EL PERFIL: ${missing.join(', ')}.\n` +
        'Pregúntalos de forma natural (no todos a la vez) y guárdalos con update_profile en cuanto te los den.'
      )
    }

    if (zonesText) {
      sections.push(
        `ZONAS DE POTENCIA (basadas en FTP ${p.ftp}w):\n${zonesText}\n\n` +
        'Si el ciclista menciona vatios concretos de un entreno, clasifícalos en su zona correspondiente.'
      )
    }

    const hrZones = p.heartRateZones
    if (hrZones) {
      sections.push(
        `ZONAS DE FC (Karvonen, FC máx ${p.maxHr} y reposo ${p.restingHr} ppm):\n` +
        hrZones.map(z => `  ${z.zone} ${z.name}: ${z.min}-${z.max} ppm`).join('\n') +
        '\n\nEn rodillo o bici estática sin potenciómetro, prescribe la intensidad con estas zonas de FC.'
      )
    }

    sections.push(this.buildSeasonSection(season))
    const weekSection = this.buildWeekSection(week)
    if (weekSection) sections.push(weekSection)
    const checkInSection = this.buildCheckInSection(checkIn)
    if (checkInSection) sections.push(checkInSection)

    return sections.join('\n\n')
  }

  // Upcoming races and current phase, so the coach knows the season context without calling a tool
  private buildSeasonSection(season: SeasonPlan | null): string {
    if (!season) return 'CARRERAS Y TEMPORADA: no disponible en este momento (usa get_race_events si lo necesitas).'
    if (season.races.length === 0) {
      return 'CARRERAS Y TEMPORADA: no hay carreras guardadas.\n' +
        'Pregunta por sus carreras u objetivos con fecha y su prioridad (A, B o C), y guárdalas con save_race_event.'
    }

    const races = season.races.slice(0, MAX_RACES_IN_PROMPT).map(r => {
      const when = formatDayKey(r.date, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
      const left = r.daysToRace > 0
        ? `faltan ${r.daysToRace >= 14 ? `${Math.floor(r.daysToRace / 7)} semanas` : `${r.daysToRace} días`}`
        : 'en curso'
      return `- ${r.name} (${r.priority}): ${when}, ${left}`
    })
    if (season.races.length > MAX_RACES_IN_PROMPT) races.push(`- … y ${season.races.length - MAX_RACES_IN_PROMPT} más (get_race_events)`)

    const lines = [`CARRERAS Y TEMPORADA (próximas):\n${races.join('\n')}`]
    const phase = season.currentPhase
    if (phase) {
      const target = season.races.find(r => r.raceId === phase.raceId)
      lines.push(
        `Fase actual: ${PHASE_LABELS[phase.kind]} hasta el ${formatDayKey(phase.to, { day: 'numeric', month: 'long' })}` +
        `${target ? ` (${phase.kind === 'recovery' ? 'tras' : 'hacia'} ${target.name})` : ''}. ${PHASE_GUIDE[phase.kind]}`
      )
    }
    if (season.warnings.length) lines.push(`Avisos del plan de temporada:\n${season.warnings.map(w => `- ${w}`).join('\n')}`)
    lines.push('Detalle semana a semana con get_season_plan.')
    return lines.join('\n')
  }
}
