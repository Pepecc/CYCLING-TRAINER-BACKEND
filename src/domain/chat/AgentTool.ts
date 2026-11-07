// Tipos que representan las tool definitions que se pasan a OpenAI

// Subconjunto de JSON Schema que aceptan las tools (admite objetos y listas anidados)
export interface AgentToolParameter {
  type: string
  description?: string
  enum?: string[]
  items?: AgentToolParameter
  properties?: Record<string, AgentToolParameter>
  required?: string[]
  minItems?: number
  maxItems?: number
}

export interface AgentToolFunction {
  name: string
  description: string
  parameters: {
    type: 'object'
    properties: Record<string, AgentToolParameter>
    required?: string[]
  }
}

export interface AgentTool {
  type: 'function'
  function: AgentToolFunction
}

// Resultado de ejecutar una tool — se devuelve a OpenAI como tool_result
export interface ToolResult {
  toolCallId: string
  content: string   // JSON serializado con los datos
}
