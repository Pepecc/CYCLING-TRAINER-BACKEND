import { Conversation } from '../../domain/chat/Conversation'
import { ConversationRepository } from '../../domain/chat/ConversationRepository'

export class GetConversation {
  constructor(private readonly conversationRepository: ConversationRepository) {}

  async execute(userId: string, conversationId: string): Promise<Conversation> {
    const conversation = await this.conversationRepository.findById(userId, conversationId)
    if (!conversation || conversation.userId !== userId) {
      throw new Error('Conversación no encontrada')
    }
    return conversation
  }
}
