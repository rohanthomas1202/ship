/**
 * FleetGraph Claude client — wraps Claude API calls with structured output.
 *
 * Uses the Anthropic SDK directly (via ANTHROPIC_API_KEY) with Bedrock as fallback.
 * Supports tool_use for typed/structured outputs.
 */

import Anthropic from '@anthropic-ai/sdk';

const MODEL_ID = 'claude-sonnet-4-5-20250929';

let client: Anthropic | null = null;
let clientInitFailed = false;

function getClient(): Anthropic | null {
  if (clientInitFailed) return null;
  if (client) return client;

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.warn('[FleetGraph] ANTHROPIC_API_KEY not set — Claude calls will use fallback');
    clientInitFailed = true;
    return null;
  }

  try {
    client = new Anthropic({ apiKey });
    console.log('[FleetGraph] Anthropic client initialized');
    return client;
  } catch (err) {
    console.warn('[FleetGraph] Failed to initialize Anthropic client:', err);
    clientInitFailed = true;
    return null;
  }
}

export interface BedrockMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface BedrockToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface BedrockCallOptions {
  system: string;
  messages: BedrockMessage[];
  tools?: BedrockToolDefinition[];
  max_tokens?: number;
}

export interface BedrockResponse {
  text?: string;
  tool_use?: {
    name: string;
    input: Record<string, unknown>;
  };
  stop_reason: string;
}

export async function callBedrock(options: BedrockCallOptions): Promise<BedrockResponse | null> {
  const anthropic = getClient();
  if (!anthropic) return null;

  try {
    const params: Anthropic.MessageCreateParams = {
      model: MODEL_ID,
      max_tokens: options.max_tokens || 4096,
      system: options.system,
      messages: options.messages,
    };

    if (options.tools && options.tools.length > 0) {
      params.tools = options.tools.map(t => ({
        name: t.name,
        description: t.description,
        input_schema: t.input_schema as Anthropic.Tool.InputSchema,
      }));
      params.tool_choice = { type: 'auto' };
    }

    const response = await anthropic.messages.create(params);

    const result: BedrockResponse = {
      stop_reason: response.stop_reason || 'end_turn',
    };

    for (const block of response.content) {
      if (block.type === 'text') {
        result.text = block.text;
      } else if (block.type === 'tool_use') {
        result.tool_use = {
          name: block.name,
          input: block.input as Record<string, unknown>,
        };
      }
    }

    return result;
  } catch (err: any) {
    console.error('[FleetGraph] Claude API call failed:', err?.message);
    // Reset on auth errors so next request retries
    if (err?.status === 401 || err?.status === 403) {
      client = null;
      clientInitFailed = false;
    }
    return null;
  }
}

export function isBedrockAvailable(): boolean {
  return getClient() !== null;
}
