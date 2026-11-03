import { Conversation } from './Conversation'
import { Message } from './Message'

// Conversations always belong to a user: lookups are scoped by userId.
export interface ConversationRepository {
  findById(userId: string, id: string): Promise<Conversation | null>
  findByUserId(userId: string): Promise<Conversation[]>
  save(conversation: Conversation): Promise<void>
  saveMessage(userId: string, message: Message): Promise<void>
}
