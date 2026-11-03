import { Firestore } from 'firebase-admin/firestore'
import { Conversation } from '../../../domain/chat/Conversation'
import { Message, MessageRole } from '../../../domain/chat/Message'
import { ConversationRepository } from '../../../domain/chat/ConversationRepository'
import { conversationsCol, messagesCol } from './paths'

interface ConversationData {
  title: string
  createdAt: string
}

interface MessageData {
  role: MessageRole
  content: string
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
      return new Message({ id: m.id, conversationId: id, role: d.role, content: d.content, createdAt: d.createdAt })
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
    await messagesCol(this.db, userId, message.conversationId).doc(message.id).set(data)
  }

  private toEntity(userId: string, id: string, data: ConversationData): Conversation {
    return new Conversation({ id, userId, title: data.title, createdAt: data.createdAt })
  }
}
