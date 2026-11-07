import { randomUUID } from 'crypto'

export type MessageRole = 'user' | 'assistant'

// Metadatos de una imagen adjunta; los bytes se guardan aparte (ConversationRepository.saveAttachment)
export interface MessageAttachment {
  id: string
  mediaType: string
  name: string | null
  sizeBytes: number
}

export interface MessageProps {
  id: string
  conversationId: string
  role: MessageRole
  content: string
  createdAt: string
  attachments?: MessageAttachment[]
}

export interface APIImage {
  mediaType: string
  data: string          // base64
}

export interface APIMessage {
  role: MessageRole
  content: string
  images?: APIImage[]   // solo en mensajes del usuario (modelos con visión)
}

export class Message {
  readonly id: string
  readonly conversationId: string
  readonly role: MessageRole
  readonly content: string
  readonly createdAt: string
  readonly attachments: MessageAttachment[]

  constructor(props: MessageProps) {
    this.id = props.id
    this.conversationId = props.conversationId
    this.role = props.role
    this.content = props.content
    this.createdAt = props.createdAt
    this.attachments = props.attachments ?? []
  }

  static create(params: {
    conversationId: string
    role: MessageRole
    content: string
    attachments?: MessageAttachment[]
  }): Message {
    return new Message({
      id: randomUUID(),
      conversationId: params.conversationId,
      role: params.role,
      content: params.content,
      createdAt: new Date().toISOString(),
      attachments: params.attachments ?? [],
    })
  }

  // Images are not included here: SendMessage loads them only for the most recent messages
  toAPIFormat(): APIMessage {
    if (this.attachments.length === 0) return { role: this.role, content: this.content }
    const n = this.attachments.length
    const note = `[${n === 1 ? 'Imagen adjunta' : `${n} imágenes adjuntas`}: ${this.attachments.map(a => a.name ?? 'sin nombre').join(', ')}]`
    return { role: this.role, content: this.content ? `${this.content}\n\n${note}` : note }
  }
}
