# @lmxcloud/plugin-lmxcloud

ElizaOS LLM plugin for [LMX Cloud](https://lmxcloud.io). Agents call OpenAI-compatible `/v1/chat/completions` and **pay per call in USDC on Base via [x402](https://www.x402.org/)** — no LMX API key, no signup, no pre-funded balance account.

## Install

```bash
npm install @lmxcloud/plugin-lmxcloud
# or
elizaos plugins add @lmxcloud/plugin-lmxcloud
```

## Required config

| Setting | Description |
| --- | --- |
| `LMXCLOUD_PRIVATE_KEY` | EVM wallet private key (`0x…` or 64 hex chars) funded with **USDC on Base** plus a little **ETH for gas** |

On first payment the plugin may submit a one-time Permit2 USDC approval transaction from this wallet.

### Character / secrets

```json
{
  "name": "MyAgent",
  "plugins": ["@lmxcloud/plugin-lmxcloud"],
  "settings": {
    "secrets": {
      "LMXCLOUD_PRIVATE_KEY": "0xYOUR_PRIVATE_KEY"
    }
  }
}
```

Or set the same key in the process environment.

## Optional settings

| Setting | Default | Description |
| --- | --- | --- |
| `LMXCLOUD_API_URL` | `https://api.lmxcloud.io` | API base URL |
| `LMXCLOUD_SMALL_MODEL` | `glm-4.7-flash` | Model alias for `TEXT_SMALL` |
| `LMXCLOUD_LARGE_MODEL` | `llama-3-70b` | Model alias for `TEXT_LARGE` |
| `LMXCLOUD_RPC_URL` | `https://mainnet.base.org` | Base JSON-RPC for signing / Permit2 |
| `LMXCLOUD_CHAIN_ID` | `8453` | `8453` Base mainnet · `84532` Base Sepolia |

## Model tiers

The plugin registers:

- `ModelType.TEXT_SMALL` → `LMXCLOUD_SMALL_MODEL`
- `ModelType.TEXT_LARGE` → `LMXCLOUD_LARGE_MODEL`

Any [LMX Cloud model alias](https://lmxcloud.io) works, for example:

| Use | Example aliases |
| --- | --- |
| Fast / cheaper | `glm-4.7-flash`, `mistral-nemo`, `deepseek-v4-flash` |
| General | `llama-3-70b`, `qwen-3.6-35b`, `glm-5.1` |
| Stronger | `deepseek-v4-pro`, `deepseek-r1`, `kimi-k2.6` |

Pricing is dynamic per request (x402 `upto` scheme). The wallet pays the quoted USDC amount after HTTP 402.

## How payment works

1. Plugin POSTs to `https://api.lmxcloud.io/v1/chat/completions` (no Bearer key).
2. API returns **402** with x402 payment requirements (USDC on Base).
3. Plugin signs with `@x402/core` + `@x402/evm` (`UptoEvmScheme`) using your private key.
4. Request is retried with the payment header; completion is returned as text.

This matches LMX Cloud’s production x402 chat flow — wallet-native, no balance account.

## Funding checklist

1. Create or use an EVM wallet.
2. Send **USDC** on **Base** (`8453`) for inference.
3. Keep a small amount of **ETH on Base** for gas (Permit2 approval + any required txs).
4. Put the private key in `LMXCLOUD_PRIVATE_KEY`.

For Base Sepolia testnets, set `LMXCLOUD_CHAIN_ID=84532` and point `LMXCLOUD_API_URL` at an x402-enabled Sepolia deployment if you use one.

## Development

```bash
npm install
npm run build
```

## Registry

Third-party plugins publish under your own npm scope (not `@elizaos/*`). After publishing to npm, submit an entry to the [elizaOS registry](https://github.com/elizaOS/eliza/tree/develop/packages/registry) (`elizaos plugins submit . --dry-run`).

## License

MIT
