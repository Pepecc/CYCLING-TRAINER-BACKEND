import OpenAI from 'openai'
import { AIPort, ToolExecutorFn } from '../../domain/chat/AIPort'
import { APIMessage } from '../../domain/chat/Message'
import { AgentTool, ToolResult } from '../../domain/chat/AgentTool'

export class OpenAIAdapter implements AIPort {
  private readonly client: OpenAI
  private readonly model: string
  private readonly maxTokens = 1024

  constructor() {
    this.client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
    this.model = process.env.OPENAI_MODEL ?? 'gpt-4.1'
  }

  async complete(
    systemPrompt: string,
    messages: APIMessage[],
    tools?: AgentTool[],
    executeTool?: ToolExecutorFn
  ): Promise<string> {
    const openaiMessages: OpenAI.Chat.ChatCompletionMessageParam[] = [
      { role: 'system', content: systemPrompt },
      ...messages,
    ]

    // No tools — simple completion
    if (!tools || tools.length === 0 || !executeTool) {
      const response = await this.client.chat.completions.create({
        model: this.model,
        max_tokens: this.maxTokens,
        messages: openaiMessages,
      })
      return response.choices[0]?.message?.content ?? ''
    }

    // Agentic loop — iterate while OpenAI wants to call tools
    let currentMessages = openaiMessages
    const MAX_ITERATIONS = 5  // safety limit

    for (let i = 0; i < MAX_ITERATIONS; i++) {
      const response = await this.client.chat.completions.create({
        model: this.model,
        max_tokens: this.maxTokens,
        messages: currentMessages,
        tools,
        tool_choice: 'auto',
      })

      const choice = response.choices[0]

      // No more tool calls — return final response
      if (choice.finish_reason !== 'tool_calls' || !choice.message.tool_calls) {
        return choice.message.content ?? ''
      }

      // Execute all tool calls in parallel
      const toolResults: ToolResult[] = await Promise.all(
        choice.message.tool_calls.map(async tc => {
          let args: Record<string, unknown> = {}
          try {
            args = JSON.parse(tc.function.arguments || '{}') as Record<string, unknown>
          } catch {
            return { toolCallId: tc.id, content: JSON.stringify({ error: 'Argumentos de la tool no válidos' }) }
          }
          const content = await executeTool(tc.function.name, args)
          return { toolCallId: tc.id, content }
        })
      )

      // Append assistant message with tool calls + tool results to history
      currentMessages = [
        ...currentMessages,
        choice.message,
        ...toolResults.map(r => ({
          role: 'tool' as const,
          tool_call_id: r.toolCallId,
          content: r.content,
        })),
      ]
    }

    // Fallback if max iterations reached — ask for a final answer without tools
    const fallback = await this.client.chat.completions.create({
      model: this.model,
      max_tokens: this.maxTokens,
      messages: currentMessages,
    })
    return fallback.choices[0]?.message?.content ?? ''
  }
}
