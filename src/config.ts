import type { IAgentRuntime } from "@elizaos/core";

export const DEFAULT_API_URL = "https://api.lmxcloud.io";
export const DEFAULT_SMALL_MODEL = "glm-4.7-flash";
export const DEFAULT_LARGE_MODEL = "llama-3-70b";
export const DEFAULT_RPC_URL = "https://mainnet.base.org";
export const DEFAULT_CHAIN_ID = 8453;
/** Max USDC (6 decimals) the client will pay per x402 call. Default: $5. */
export const DEFAULT_MAX_USDC_PER_CALL = 5_000_000n;

export function getSetting(
  runtime: IAgentRuntime,
  key: string,
  defaultValue?: string,
): string | undefined {
  const fromRuntime = runtime.getSetting(key);
  if (fromRuntime !== undefined && fromRuntime !== null && `${fromRuntime}` !== "") {
    return String(fromRuntime);
  }
  const fromEnv = process.env[key];
  if (fromEnv !== undefined && fromEnv !== "") {
    return fromEnv;
  }
  return defaultValue;
}

export function getPrivateKey(runtime: IAgentRuntime): `0x${string}` {
  const raw = getSetting(runtime, "LMXCLOUD_PRIVATE_KEY");
  if (!raw) {
    throw new Error(
      "LMXCLOUD_PRIVATE_KEY is required. Set an EVM private key funded with USDC on Base.",
    );
  }
  const trimmed = raw.trim();
  const hex = trimmed.startsWith("0x") ? trimmed.slice(2) : trimmed;
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error(
      "LMXCLOUD_PRIVATE_KEY must be 64 hex characters (with or without 0x prefix)",
    );
  }
  return `0x${hex}`;
}

export function getApiUrl(runtime: IAgentRuntime): string {
  return (
    getSetting(runtime, "LMXCLOUD_API_URL", DEFAULT_API_URL) ?? DEFAULT_API_URL
  ).replace(/\/$/, "");
}

export function getSmallModel(runtime: IAgentRuntime): string {
  return (
    getSetting(runtime, "LMXCLOUD_SMALL_MODEL") ??
    getSetting(runtime, "SMALL_MODEL", DEFAULT_SMALL_MODEL) ??
    DEFAULT_SMALL_MODEL
  );
}

export function getLargeModel(runtime: IAgentRuntime): string {
  return (
    getSetting(runtime, "LMXCLOUD_LARGE_MODEL") ??
    getSetting(runtime, "LARGE_MODEL", DEFAULT_LARGE_MODEL) ??
    DEFAULT_LARGE_MODEL
  );
}

export function getRpcUrl(runtime: IAgentRuntime): string {
  return (
    getSetting(runtime, "LMXCLOUD_RPC_URL", DEFAULT_RPC_URL) ?? DEFAULT_RPC_URL
  );
}

export function getChainId(runtime: IAgentRuntime): number {
  const raw = getSetting(runtime, "LMXCLOUD_CHAIN_ID", String(DEFAULT_CHAIN_ID));
  const chainId = Number(raw);
  if (!Number.isInteger(chainId) || chainId <= 0) {
    throw new Error(`Invalid LMXCLOUD_CHAIN_ID: ${raw}`);
  }
  return chainId;
}

export function getNetwork(runtime: IAgentRuntime): `eip155:${number}` {
  return `eip155:${getChainId(runtime)}`;
}

export function getMaxUsdcPerCall(runtime: IAgentRuntime): bigint {
  const raw = getSetting(
    runtime,
    "LMXCLOUD_MAX_USDC_PER_CALL",
    String(DEFAULT_MAX_USDC_PER_CALL),
  );
  if (raw === undefined || !/^\d+$/.test(raw.trim())) {
    throw new Error(
      `Invalid LMXCLOUD_MAX_USDC_PER_CALL: ${raw} (expected a non-negative integer in USDC base units)`,
    );
  }
  return BigInt(raw.trim());
}
