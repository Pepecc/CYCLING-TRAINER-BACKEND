import { Router, Response } from 'express'
import { authMiddleware, AuthRequest } from '../middleware/auth'
import { rateLimit } from '../middleware/rateLimit'
import { SendMessage } from '../../../application/chat/SendMessage'
import { GetConversations } from '../../../application/chat/GetConversations'
import { GetConversation } from '../../../application/chat/GetConversation'

interface ChatContainer {
  sendMessage: SendMessage
  getConversations: GetConversations
  getConversation: GetConversation
}

export function createChatRouter({ sendMessage, getConversations, getConversation }: ChatContainer): Router {
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

  const messageLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: Number(process.env.CHAT_RATE_LIMIT_PER_MINUTE) || 10,
  })

  router.post('/message', messageLimiter, async (req, res: Response) => {
    try {
      const { userId } = req as AuthRequest
      const { content, conversationId } = req.body as { content: string; conversationId?: string }
      const result = await sendMessage.execute({ userId, content, conversationId })
      res.json(result)
    } catch (err) {
      res.status(400).json({ error: (err as Error).message })
    }
  })

  return router
}
