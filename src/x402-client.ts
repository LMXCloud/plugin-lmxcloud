import {
  createPublicClient,
  createWalletClient,
  http,
  type Account,
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
}

function chainForId(chainId: number) {
  return chainId === 84532 ? baseSepolia : base;
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
 * Flow: unpaid POST → 402 → sign Permit2/upto payload → paid retry.
 */
export class LmxX402ChatClient {
  private readonly apiUrl: string;
  private readonly rpcUrl: string;
  private readonly chainId: number;
  private readonly network: `eip155:${number}`;
  private readonly account: Account;
  private readonly httpClient: x402HTTPClient;
  private permit2Approved = false;

  constructor(options: X402ChatClientOptions) {
    this.apiUrl = options.apiUrl.replace(/\/$/, "");
    this.rpcUrl = options.rpcUrl;
    this.chainId = options.chainId;
    this.network = `eip155:${options.chainId}`;
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
    await publicClient.waitForTransactionReceipt({ hash });
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

    const accept = paymentRequired.accepts?.[0];
    const tokenAddress = accept?.asset as `0x${string}` | undefined;
    const requiredAmount = BigInt(accept?.amount ?? "1000");
    if (!tokenAddress) {
      throw new Error("x402 payment requirements missing USDC asset address");
    }

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
  ].join("|");
  let client = clients.get(key);
  if (!client) {
    client = new LmxX402ChatClient(options);
    clients.set(key, client);
  }
  return client;
}
