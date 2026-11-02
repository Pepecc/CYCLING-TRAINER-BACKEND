import { Conversation } from '../../domain/chat/Conversation'
import { Message } from '../../domain/chat/Message'
import { ConversationRepository } from '../../domain/chat/ConversationRepository'
import { CyclistProfileRepository } from '../../domain/profile/CyclistProfileRepository'
import { CyclistProfile } from '../../domain/profile/CyclistProfile'
import { AIPort, ToolExecutorFn } from '../../domain/chat/AIPort'
import { ToolExecutor } from '../../infrastructure/ai/tools/ToolExecutor'
import { toolDefinitions } from '../../infrastructure/ai/tools/ToolDefinitions'

import { formatDate } from '../../domain/training/calendar'
import { Experience } from '../../domain/profile/CyclistProfile'

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
    private readonly toolExecutor: ToolExecutor | null = null
  ) {}

  async execute({ userId, content, conversationId }: SendMessageInput): Promise<SendMessageOutput> {
    if (!content.trim()) throw new Error('El mensaje no puede estar vacío')

    // Load or create conversation
    let conversation: Conversation
    if (conversationId) {
      const found = await this.conversationRepository.findById(conversationId)
      if (!found || found.userId !== userId) throw new Error('Conversación no encontrada')
      conversation = found
    } else {
      conversation = Conversation.create({ userId, title: content.slice(0, 50) })
      await this.conversationRepository.save(conversation)
    }

    const profile = await this.profileRepository.findByUserId(userId)
    const systemPrompt = this.buildSystemPrompt(profile)

    // Persist user message
    const userMessage = Message.create({
      conversationId: conversation.id,
      role: 'user',
      content: content.trim(),
    })
    await this.conversationRepository.saveMessage(userMessage)
    conversation.addMessage(userMessage)

    // Bind the tool executor to this request's userId (never shared between requests)
    const toolExecutor = this.toolExecutor
    const executeTool: ToolExecutorFn | undefined = toolExecutor
      ? (toolName, args) => toolExecutor.execute(userId, toolName, args)
      : undefined

    // Call AI — pass tools only if executor is available
    const contextMessages = conversation.getContextMessages(20)
    const tools = executeTool ? toolDefinitions : undefined
    const assistantContent = await this.aiPort.complete(systemPrompt, contextMessages, tools, executeTool)

    // Persist assistant response
    const assistantMessage = Message.create({
      conversationId: conversation.id,
      role: 'assistant',
      content: assistantContent,
    })
    await this.conversationRepository.saveMessage(assistantMessage)

    return { conversationId: conversation.id, message: assistantMessage }
  }

  private buildSystemPrompt(profile: CyclistProfile | null): string {
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
      ['Eventos objetivo', p.targetEvents],
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

    return sections.join('\n\n')
  }
}
