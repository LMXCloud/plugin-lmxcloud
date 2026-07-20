import {
  createPublicClient,
  createWalletClient,
  http,
  type Account,
  type Chain,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base, baseSepolia } from "viem/chains";
import { x402Client, x402HTTPClient } from "@x402/core/client";
import {
  UptoEvmScheme,
  createPermit2ApprovalTx,
  getPermit2AllowanceReadParams,
  toClientEvmSigner,
} from "@x402/evm";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  stop?: string | string[];
  user?: string;
  response_format?: { type: "json_object" | "text" } | string;
}

export interface ChatCompletionChoice {
  message?: { content?: string | null };
  text?: string;
}

export interface ChatCompletionResponse {
  choices?: ChatCompletionChoice[];
  error?: { message?: string };
}

export interface X402ChatClientOptions {
  apiUrl: string;
  privateKey: `0x${string}`;
  rpcUrl: string;
  chainId: number;
  /** Max USDC (6 decimals) to pay per call. Rejects higher 402 amounts. */
  maxUsdcPerCall: bigint;
}

/** Canonical Circle USDC contracts for chains this plugin supports. */
const USDC_BY_CHAIN_ID: Record<number, `0x${string}`> = {
  8453: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  84532: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
};

const FETCH_TIMEOUT_MS = 60_000;
const TX_RECEIPT_TIMEOUT_MS = 120_000;

function chainForId(chainId: number): Chain {
  if (chainId === 8453) return base;
  if (chainId === 84532) return baseSepolia;
  throw new Error(
    `Unsupported LMXCLOUD_CHAIN_ID ${chainId}. Supported: 8453 (Base), 84532 (Base Sepolia).`,
  );
}

function usdcForChainId(chainId: number): `0x${string}` {
  const usdc = USDC_BY_CHAIN_ID[chainId];
  if (!usdc) {
    throw new Error(
      `No canonical USDC address for chain ${chainId}. Supported: 8453, 84532.`,
    );
  }
  return usdc;
}

function decodePaymentError(header: string | null): string | undefined {
  if (!header) return undefined;
  try {
    const json = JSON.parse(
      Buffer.from(header, "base64").toString("utf8"),
    ) as { error?: string };
    return json.error;
  } catch {
    return undefined;
  }
}

/**
 * x402 client for LMX Cloud OpenAI-compatible chat completions.
 * Flow: unpaid POST → 402 → validate accept → sign Permit2/upto payload → paid retry.
 */
export class LmxX402ChatClient {
  private readonly apiUrl: string;
  private readonly rpcUrl: string;
  private readonly chainId: number;
  private readonly network: `eip155:${number}`;
  private readonly maxUsdcPerCall: bigint;
  private readonly account: Account;
  private readonly httpClient: x402HTTPClient;
  private permit2Approved = false;

  constructor(options: X402ChatClientOptions) {
    this.apiUrl = options.apiUrl.replace(/\/$/, "");
    this.rpcUrl = options.rpcUrl;
    this.chainId = options.chainId;
    this.network = `eip155:${options.chainId}`;
    this.maxUsdcPerCall = options.maxUsdcPerCall;
    this.account = privateKeyToAccount(options.privateKey);

    const chain = chainForId(this.chainId);
    const publicClient = createPublicClient({
      chain,
      transport: http(this.rpcUrl),
    });
    const walletClient = createWalletClient({
      account: this.account,
      chain,
      transport: http(this.rpcUrl),
    });

    const signer = toClientEvmSigner(
      {
        address: this.account.address,
        signTypedData: (msg) => {
          if (!this.account.signTypedData) {
            throw new Error("Wallet account does not support signTypedData");
          }
          return this.account.signTypedData(msg);
        },
        signTransaction: async (args) => {
          if (!walletClient.signTransaction) {
            throw new Error("Wallet client does not support signTransaction");
          }
          return walletClient.signTransaction(args);
        },
      },
      publicClient,
    );

    const client = new x402Client();
    client.register(
      this.network,
      new UptoEvmScheme(signer, { rpcUrl: this.rpcUrl }),
    );
    this.httpClient = new x402HTTPClient(client);
  }

  get address(): string {
    return this.account.address;
  }

  /**
   * Validate the chosen x402 accept entry before any signing or Permit2 work.
   * Returns the canonical USDC address and required amount in base units.
   */
  private validateAccept(accept: {
    network?: string;
    asset?: string;
    amount?: string;
  } | undefined): { tokenAddress: `0x${string}`; requiredAmount: bigint } {
    if (!accept) {
      throw new Error("x402 payment requirements missing accepts[0]");
    }

    if (accept.network !== this.network) {
      throw new Error(
        `x402 accept network mismatch: got ${JSON.stringify(accept.network)}, ` +
          `expected ${this.network}`,
      );
    }

    const expectedUsdc = usdcForChainId(this.chainId);
    const asset = accept.asset?.trim();
    if (!asset || asset.toLowerCase() !== expectedUsdc.toLowerCase()) {
      throw new Error(
        `x402 accept asset is not canonical USDC for chain ${this.chainId}: ` +
          `got ${JSON.stringify(accept.asset)}, expected ${expectedUsdc}`,
      );
    }

    const amountRaw = accept.amount?.trim();
    if (!amountRaw || !/^\d+$/.test(amountRaw)) {
      throw new Error(
        `x402 accept amount is missing or invalid: ${JSON.stringify(accept.amount)}`,
      );
    }

    const requiredAmount = BigInt(amountRaw);
    if (requiredAmount <= 0n) {
      throw new Error(
        `x402 accept amount must be positive, got ${requiredAmount.toString()}`,
      );
    }

    if (requiredAmount > this.maxUsdcPerCall) {
      throw new Error(
        `x402 accept amount ${requiredAmount.toString()} exceeds max per-call ` +
          `spend limit ${this.maxUsdcPerCall.toString()} USDC base units ` +
          `(set LMXCLOUD_MAX_USDC_PER_CALL to raise)`,
      );
    }

    return { tokenAddress: expectedUsdc, requiredAmount };
  }

  private async chatFetch(
    body: string,
    headers?: Record<string, string>,
  ): Promise<Response> {
    return fetch(`${this.apiUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...headers,
      },
      body,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  }

  private async ensurePermit2Allowance(
    tokenAddress: `0x${string}`,
    requiredAmount: bigint,
  ): Promise<void> {
    if (this.permit2Approved) return;

    const chain = chainForId(this.chainId);
    const publicClient = createPublicClient({
      chain,
      transport: http(this.rpcUrl),
    });
    const walletClient = createWalletClient({
      account: this.account,
      chain,
      transport: http(this.rpcUrl),
    });

    const allowance = (await publicClient.readContract(
      getPermit2AllowanceReadParams({
        tokenAddress,
        ownerAddress: this.account.address,
      }),
    )) as bigint;

    if (allowance >= requiredAmount) {
      this.permit2Approved = true;
      return;
    }

    const approvalTx = createPermit2ApprovalTx(tokenAddress);
    const hash = await walletClient.sendTransaction({
      account: this.account,
      chain,
      to: approvalTx.to,
      data: approvalTx.data,
    });
    await publicClient.waitForTransactionReceipt({
      hash,
      timeout: TX_RECEIPT_TIMEOUT_MS,
    });
    this.permit2Approved = true;
  }

  async complete(request: ChatCompletionRequest): Promise<string> {
    const body = JSON.stringify(request);

    const initial = await this.chatFetch(body);
    const initialBody = (await initial.json().catch(() => ({}))) as
      | ChatCompletionResponse
      | Record<string, unknown>;

    if (initial.status !== 402) {
      throw new Error(
        `Expected 402 Payment Required from ${this.apiUrl}/v1/chat/completions, ` +
          `got ${initial.status}: ${JSON.stringify(initialBody)}`,
      );
    }

    const paymentRequired = this.httpClient.getPaymentRequiredResponse(
      (name) => initial.headers.get(name),
      initialBody,
    );

    const { tokenAddress, requiredAmount } = this.validateAccept(
      paymentRequired.accepts?.[0],
    );

    await this.ensurePermit2Allowance(tokenAddress, requiredAmount);

    const paymentPayload =
      await this.httpClient.createPaymentPayload(paymentRequired);
    const paymentHeaders =
      this.httpClient.encodePaymentSignatureHeader(paymentPayload);

    const paid = await this.chatFetch(body, paymentHeaders);
    const paidBody = (await paid.json().catch(() => ({}))) as ChatCompletionResponse;

    if (paid.status !== 200) {
      const paymentError = decodePaymentError(
        paid.headers.get("payment-required") ??
          paid.headers.get("x-payment-required"),
      );
      throw new Error(
        paymentError
          ? `LMX x402 chat failed (${paid.status}): ${paymentError}`
          : `LMX x402 chat failed (${paid.status}): ${JSON.stringify(paidBody)}`,
      );
    }

    if (paidBody.error?.message) {
      throw new Error(`LMX chat error: ${paidBody.error.message}`);
    }

    const text =
      paidBody.choices?.[0]?.message?.content ??
      paidBody.choices?.[0]?.text ??
      "";

    if (!text) {
      throw new Error(
        `LMX chat returned empty content: ${JSON.stringify(paidBody)}`,
      );
    }

    return text;
  }
}

const clients = new Map<string, LmxX402ChatClient>();

export function getOrCreateChatClient(
  options: X402ChatClientOptions,
): LmxX402ChatClient {
  const key = [
    options.apiUrl,
    options.privateKey,
    options.rpcUrl,
    options.chainId,
    options.maxUsdcPerCall.toString(),
  ].join("|");
  let client = clients.get(key);
  if (!client) {
    client = new LmxX402ChatClient(options);
    clients.set(key, client);
  }
  return client;
}
