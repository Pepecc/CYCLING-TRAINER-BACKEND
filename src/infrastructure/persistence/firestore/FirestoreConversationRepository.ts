import { Firestore } from 'firebase-admin/firestore'
import { Conversation } from '../../../domain/chat/Conversation'
import { Message, MessageAttachment, MessageRole } from '../../../domain/chat/Message'
import { ConversationRepository, StoredAttachment } from '../../../domain/chat/ConversationRepository'
import { attachmentsCol, conversationsCol, messagesCol } from './paths'

interface ConversationData {
  title: string
  createdAt: string
}

interface MessageData {
  role: MessageRole
  content: string
  createdAt: string
  attachments?: MessageAttachment[]
}

interface AttachmentData {
  mediaType: string
  name: string | null
  sizeBytes: number
  data: Buffer          // stored as Firestore bytes (base64 would take a third more of the 1 MiB limit)
  createdAt: string
}

export class FirestoreConversationRepository implements ConversationRepository {
  constructor(private readonly db: Firestore) {}

  async findById(userId: string, id: string): Promise<Conversation | null> {
    const [snap, messages] = await Promise.all([
      conversationsCol(this.db, userId).doc(id).get(),
      messagesCol(this.db, userId, id).orderBy('createdAt', 'asc').get(),
    ])
    if (!snap.exists) return null

    const conversation = this.toEntity(userId, id, snap.data() as ConversationData)
    conversation.messages = messages.docs.map(m => {
      const d = m.data() as MessageData
      return new Message({
        id: m.id, conversationId: id, role: d.role, content: d.content, createdAt: d.createdAt, attachments: d.attachments,
      })
    })
    return conversation
  }

  async findByUserId(userId: string): Promise<Conversation[]> {
    const snap = await conversationsCol(this.db, userId).orderBy('createdAt', 'desc').get()
    return snap.docs.map(d => this.toEntity(userId, d.id, d.data() as ConversationData))
  }

  async save(conversation: Conversation): Promise<void> {
    const data: ConversationData = { title: conversation.title, createdAt: conversation.createdAt }
    await conversationsCol(this.db, conversation.userId).doc(conversation.id).set(data, { merge: true })
  }

  async saveMessage(userId: string, message: Message): Promise<void> {
    const data: MessageData = { role: message.role, content: message.content, createdAt: message.createdAt }
    if (message.attachments.length) data.attachments = message.attachments
    await messagesCol(this.db, userId, message.conversationId).doc(message.id).set(data)
  }

  async saveAttachment(userId: string, conversationId: string, a: StoredAttachment): Promise<void> {
    const data: AttachmentData = {
      mediaType: a.mediaType,
      name: a.name,
      sizeBytes: a.sizeBytes,
      data: Buffer.from(a.data, 'base64'),
      createdAt: new Date().toISOString(),
    }
    await attachmentsCol(this.db, userId, conversationId).doc(a.id).set(data)
  }

  async findAttachment(userId: string, conversationId: string, id: string): Promise<StoredAttachment | null> {
    const snap = await attachmentsCol(this.db, userId, conversationId).doc(id).get()
    if (!snap.exists) return null
    const d = snap.data() as AttachmentData
    return { id, mediaType: d.mediaType, name: d.name, sizeBytes: d.sizeBytes, data: Buffer.from(d.data).toString('base64') }
  }

  private toEntity(userId: string, id: string, data: ConversationData): Conversation {
    return new Conversation({ id, userId, title: data.title, createdAt: data.createdAt })
  }
}
