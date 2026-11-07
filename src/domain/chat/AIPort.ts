import { APIMessage } from './Message'
import { AgentTool } from './AgentTool'

// Executes a tool call requested by the model. Bound per request to the
// current user, so it must never be stored as adapter state.
export type ToolExecutorFn = (toolName: string, args: Record<string, unknown>) => Promise<string>

// Port for AI provider — swap the adapter to change the underlying model.
// Messages may carry images (APIMessage.images): the adapter must use a model with vision.
export interface AIPort {
  complete(
    systemPrompt: string,
    messages: APIMessage[],
    tools?: AgentTool[],
    executeTool?: ToolExecutorFn
  ): Promise<string>

  // Single answer that must be a JSON object (structured extraction, e.g. a plan from a photo).
  // Returns the parsed object; throws if the model does not return valid JSON.
  completeJson(systemPrompt: string, messages: APIMessage[]): Promise<unknown>
}
