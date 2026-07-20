import type { Plugin } from "@elizaos/core";
import { ModelType, logger } from "@elizaos/core";
import { privateKeyToAccount } from "viem/accounts";
import { getPrivateKey } from "./config.js";
import { handleTextLarge, handleTextSmall } from "./models.js";

/**
 * LMX Cloud ElizaOS plugin — OpenAI-compatible inference paid per call
 * in USDC on Base via x402 (no API key / no pre-funded balance).
 */
export const lmxcloudPlugin: Plugin = {
  name: "lmxcloud",
  description:
    "LMX Cloud LLM provider — pay-per-call USDC via x402 on Base (no API key)",
  priority: 100,
  config: {
    LMXCLOUD_PRIVATE_KEY: process.env.LMXCLOUD_PRIVATE_KEY,
    LMXCLOUD_API_URL: process.env.LMXCLOUD_API_URL,
    LMXCLOUD_SMALL_MODEL: process.env.LMXCLOUD_SMALL_MODEL,
    LMXCLOUD_LARGE_MODEL: process.env.LMXCLOUD_LARGE_MODEL,
    LMXCLOUD_RPC_URL: process.env.LMXCLOUD_RPC_URL,
    LMXCLOUD_CHAIN_ID: process.env.LMXCLOUD_CHAIN_ID,
    LMXCLOUD_MAX_USDC_PER_CALL: process.env.LMXCLOUD_MAX_USDC_PER_CALL,
  },
  async init(_config, runtime) {
    // Validate the required wallet key early so misconfig fails at boot.
    const account = privateKeyToAccount(getPrivateKey(runtime));
    logger.info(
      `[LMX Cloud] plugin ready (x402 pay-per-call; payer=${account.address})`,
    );
  },
  models: {
    [ModelType.TEXT_SMALL]: async (runtime, params) => {
      return handleTextSmall(runtime, params);
    },
    [ModelType.TEXT_LARGE]: async (runtime, params) => {
      return handleTextLarge(runtime, params);
    },
  },
};

export default lmxcloudPlugin;
