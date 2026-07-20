import {
  logger,
  type GenerateTextParams,
  type IAgentRuntime,
} from "@elizaos/core";
import {
  getApiUrl,
  getChainId,
  getLargeModel,
  getMaxUsdcPerCall,
  getPrivateKey,
  getRpcUrl,
  getSmallModel,
} from "./config.js";
import { getOrCreateChatClient, type ChatMessage } from "./x402-client.js";

function buildMessages(
  runtime: IAgentRuntime,
  prompt: string,
): ChatMessage[] {
  const messages: ChatMessage[] = [];
  const system = runtime.character?.system;
  if (typeof system === "string" && system.trim()) {
    messages.push({ role: "system", content: system });
  }
  messages.push({ role: "user", content: prompt });
  return messages;
}

function mapResponseFormat(
  responseFormat: GenerateTextParams["responseFormat"],
): { type: "json_object" | "text" } | string | undefined {
  if (!responseFormat) return undefined;
  if (typeof responseFormat === "string") return responseFormat;
  return responseFormat;
}

async function generateText(
  runtime: IAgentRuntime,
  params: GenerateTextParams,
  model: string,
  modelType: string,
): Promise<string> {
  const client = getOrCreateChatClient({
    apiUrl: getApiUrl(runtime),
    privateKey: getPrivateKey(runtime),
    rpcUrl: getRpcUrl(runtime),
    chainId: getChainId(runtime),
    maxUsdcPerCall: getMaxUsdcPerCall(runtime),
  });

  logger.debug(
    `[LMX Cloud] ${modelType} via x402 model=${model} payer=${client.address}`,
  );

  const text = await client.complete({
    model,
    messages: buildMessages(runtime, params.prompt),
    max_tokens: params.maxTokens,
    temperature: params.temperature,
    top_p: params.topP,
    frequency_penalty: params.frequencyPenalty,
    presence_penalty: params.presencePenalty,
    stop: params.stopSequences,
    user:
      params.user === undefined
        ? runtime.character?.name
        : params.user === null
          ? undefined
          : params.user,
    response_format: mapResponseFormat(params.responseFormat),
  });

  if (params.onStreamChunk) {
    await params.onStreamChunk(text);
  }

  return text;
}

export async function handleTextSmall(
  runtime: IAgentRuntime,
  params: GenerateTextParams,
): Promise<string> {
  return generateText(runtime, params, getSmallModel(runtime), "TEXT_SMALL");
}

export async function handleTextLarge(
  runtime: IAgentRuntime,
  params: GenerateTextParams,
): Promise<string> {
  return generateText(runtime, params, getLargeModel(runtime), "TEXT_LARGE");
}
