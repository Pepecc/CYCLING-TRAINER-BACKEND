import { Router, Response } from 'express'
import { authMiddleware, AuthRequest } from '../middleware/auth'
import { rateLimit } from '../middleware/rateLimit'
import { SendMessage } from '../../../application/chat/SendMessage'
import { GetConversations } from '../../../application/chat/GetConversations'
import { GetConversation } from '../../../application/chat/GetConversation'
import { ConversationRepository } from '../../../domain/chat/ConversationRepository'

interface ChatContainer {
  sendMessage: SendMessage
  getConversations: GetConversations
  getConversation: GetConversation
  conversationRepository: ConversationRepository
}

export function createChatRouter({ sendMessage, getConversations, getConversation, conversationRepository }: ChatContainer): Router {
  const router = Router()
  router.use(authMiddleware)

  router.get('/conversations', async (req: any, res: Response) => {
    try {
      const { userId } = req as AuthRequest
      const conversations = await getConversations.execute(userId)
      res.json({ conversations })
    } catch (err) {
      res.status(500).json({ error: (err as Error).message })
    }
  })

  router.get('/conversations/:id', async (req, res: Response) => {
    try {
      const { userId } = req as any
      const conversation = await getConversation.execute(userId, req.params.id)
      res.json({ conversation })
    } catch (err) {
      res.status(404).json({ error: (err as Error).message })
    }
  })

  // Image attached to a message (the frontend fetches it with the auth header and shows it as a blob)
  router.get('/conversations/:id/attachments/:attachmentId', async (req, res: Response) => {
    try {
      const { userId } = req as unknown as AuthRequest
      const attachment = await conversationRepository.findAttachment(userId, req.params.id, req.params.attachmentId)
      if (!attachment) {
        res.status(404).json({ error: 'Imagen no encontrada' })
        return
      }
      res.set('Content-Type', attachment.mediaType)
      res.set('Cache-Control', 'private, max-age=86400')
      res.send(Buffer.from(attachment.data, 'base64'))
    } catch (err) {
      console.error(err)
      res.status(500).json({ error: 'Error interno del servidor' })
    }
  })

  const messageLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: Number(process.env.CHAT_RATE_LIMIT_PER_MINUTE) || 10,
  })

  router.post('/message', messageLimiter, async (req, res: Response) => {
    try {
      const { userId } = req as AuthRequest
      const { content, conversationId, images } = req.body as { content?: string; conversationId?: string; images?: unknown }
      const result = await sendMessage.execute({ userId, content: content ?? '', conversationId, images })
      res.json(result)
    } catch (err) {
      res.status(400).json({ error: (err as Error).message })
    }
  })

  return router
}
