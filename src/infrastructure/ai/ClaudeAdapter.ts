import Anthropic from '@anthropic-ai/sdk'
import { AIPort } from '../../domain/chat/AIPort'
import { APIMessage } from '../../domain/chat/Message'

// Not wired in the container (no tool support yet; see PENDIENTES section 5)
export class ClaudeAdapter implements AIPort {
  private readonly client: Anthropic
  private readonly model = 'claude-sonnet-4-5'
  private readonly maxTokens = 1024

  constructor() {
    this.client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  }

  async complete(systemPrompt: string, messages: APIMessage[]): Promise<string> {
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: this.maxTokens,
      system: systemPrompt,
      messages: messages.map(toClaudeMessage),
    })

    const block = response.content[0]
    if (block.type !== 'text') throw new Error('Unexpected response type from Claude')
    return block.text
  }

  async completeJson(systemPrompt: string, messages: APIMessage[]): Promise<unknown> {
    const text = await this.complete(`${systemPrompt}\n\nResponde únicamente con el objeto JSON.`, messages)
    const json = text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)
    try {
      return JSON.parse(json)
    } catch {
      throw new Error('El modelo no ha devuelto un JSON válido')
    }
  }
}

type ImageMediaType = 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif'

function toClaudeMessage(m: APIMessage): Anthropic.MessageParam {
  if (m.role === 'assistant' || !m.images?.length) return { role: m.role, content: m.content }
  return {
    role: 'user',
    content: [
      ...m.images.map(img => ({
        type: 'image' as const,
        source: { type: 'base64' as const, media_type: img.mediaType as ImageMediaType, data: img.data },
      })),
      ...(m.content ? [{ type: 'text' as const, text: m.content }] : []),
    ],
  }
}
