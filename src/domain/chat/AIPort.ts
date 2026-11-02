import { APIMessage } from './Message'
import { AgentTool } from './AgentTool'

// Executes a tool call requested by the model. Bound per request to the
// current user, so it must never be stored as adapter state.
export type ToolExecutorFn = (toolName: string, args: Record<string, unknown>) => Promise<string>

// Port for AI provider — swap the adapter to change the underlying model
export interface AIPort {
  complete(
    systemPrompt: string,
    messages: APIMessage[],
    tools?: AgentTool[],
    executeTool?: ToolExecutorFn
  ): Promise<string>
}
