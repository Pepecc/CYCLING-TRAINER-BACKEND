import { Conversation } from './Conversation'
import { Message, MessageAttachment } from './Message'

export interface StoredAttachment extends MessageAttachment {
  data: string   // base64
}

// Conversations always belong to a user: lookups are scoped by userId.
export interface ConversationRepository {
  findById(userId: string, id: string): Promise<Conversation | null>
  findByUserId(userId: string): Promise<Conversation[]>
  save(conversation: Conversation): Promise<void>
  saveMessage(userId: string, message: Message): Promise<void>
  // Image bytes of a message, stored apart from it (one document per image)
  saveAttachment(userId: string, conversationId: string, attachment: StoredAttachment): Promise<void>
  findAttachment(userId: string, conversationId: string, id: string): Promise<StoredAttachment | null>
}
