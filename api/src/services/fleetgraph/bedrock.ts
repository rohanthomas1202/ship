/**
 * FleetGraph Bedrock client — wraps Claude calls with structured output.
 * Follows the same pattern as ai-analysis.ts but supports tool_use for typed output.
 */

import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';

const MODEL_ID = 'global.anthropic.claude-sonnet-4-5-20250514-v1:0';
const REGION = 'us-east-1';

let bedrockClient: BedrockRuntimeClient | null = null;
let clientInitFailed = false;

function getClient(): BedrockRuntimeClient | null {
  if (clientInitFailed) return null;
  if (bedrockClient) return bedrockClient;
  try {
    bedrockClient = new BedrockRuntimeClient({ region: REGION });
    return bedrockClient;
  } catch (err) {
    console.warn('[FleetGraph] Failed to initialize Bedrock client:', err);
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
  const client = getClient();
  if (!client) return null;

  const body: Record<string, unknown> = {
    anthropic_version: 'bedrock-2023-05-31',
    max_tokens: options.max_tokens || 4096,
    system: options.system,
    messages: options.messages,
  };

  if (options.tools && options.tools.length > 0) {
    body.tools = options.tools;
    body.tool_choice = { type: 'auto' };
  }

  const command = new InvokeModelCommand({
    modelId: MODEL_ID,
    contentType: 'application/json',
    accept: 'application/json',
    body: new TextEncoder().encode(JSON.stringify(body)),
  });

  try {
    const response = await client.send(command);
    const responseBody = JSON.parse(new TextDecoder().decode(response.body));

    const result: BedrockResponse = {
      stop_reason: responseBody.stop_reason || 'end_turn',
    };

    if (responseBody.content) {
      for (const block of responseBody.content) {
        if (block.type === 'text') {
          result.text = block.text;
        } else if (block.type === 'tool_use') {
          result.tool_use = {
            name: block.name,
            input: block.input,
          };
        }
      }
    }

    return result;
  } catch (err) {
    console.error('[FleetGraph] Bedrock call failed:', err);
    return null;
  }
}

export function isBedrockAvailable(): boolean {
  return getClient() !== null;
}
