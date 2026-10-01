# Tokenized asset discovery, independent of StockScore

This is a provider catalog export recipe. It uses public HTTP endpoints, JSON, CSV, and optional Solana RPC. It does not depend on StockScore, a wallet, Jupiter, Pyth, or a particular web framework.

## Run the export

Requires Node.js 22 or newer. From this repository:

```sh
node scripts/export-tokenized-assets.mjs --network Solana --output-dir exports
```

The command writes `tokenized-assets.json` and `tokenized-assets.csv`. To include every network deployment published by xStocks, use `--network all`. Every output row carries its provider, product and underlying symbols, network, token address, official product URL, raw catalog URL, and retrieval timestamp. PreStocks rows also carry provider token price, provider mark, and implied valuation **as supplied at retrieval time**. Empty fields mean the catalog did not supply the value; they are not zero. The export is a point-in-time snapshot, not a market feed.

The checked-in snapshot is for handoff and audit. Re-run the command before use, and review each provider's terms before redistributing the data or using it commercially.

## Get the source catalogs yourself

| Provider lane | Official source | What to read | Boundary |
| --- | --- | --- | --- |
| PreStocks products | [Products API](https://prestocks.com/api/prestocks), [product directory](https://prestocks.com/products) | `symbol`, `name`, `contract_address`, `external_url`, `tokenPrice`, `markPrice`, `impliedValuation` | Treat provider prices and marks as provider values, not observed pool quotes. Follow [provider terms](https://url.prestocks.com/terms-of-service). |
| xStocks assets | [Public Assets API](https://docs.xstocks.fi/apis/openapi/assets), [product directory](https://xstocks.com/products) | Paginate `/api/v2/public/assets?page=N`; read `nodes`, `page.hasNextPage`, `symbol`, `underlying`, and `deployments[]` | Pick the address for the intended **network**. A ticker is not a token address. Public asset endpoints need no API key. |

Minimal raw requests:

```sh
curl -fsS https://prestocks.com/api/prestocks | jq '.[] | {name, symbol, contract_address, tokenPrice, markPrice, impliedValuation, external_url}'
curl -fsS 'https://api.xstocks.fi/api/v2/public/assets?page=0' | jq '{page, sample: (.nodes[0] | {name, symbol, underlying, deployments})}'
```

Continue xStocks pages until `page.hasNextPage` is `false`. Check `page.currentPage` and fail on malformed or missing pages; do not quietly present a partial list as complete. The xStocks [developer guide](https://docs.xstocks.fi/developers) documents public asset metadata, per-chain addresses, and Solana's Token-2022 Scaled UI multiplier. A raw Solana token amount may differ from the displayed amount after the multiplier; consult the [official multiplier guide](https://docs.xstocks.fi/developers/multipliers) when showing balances.

This export omits xStocks `VCXx`, a private-company exposure fund, so that PreStocks remains the only source for the PreStocks research lane. It does not classify a company as public or private from a ticker, a name, or an old company list. The provider product and its current terms define the lane. Other issuers need their own official catalog and separately verified mint mapping; do not infer a mint from a ticker or copy one from an unrelated token.

## Verify a listed token before using it

1. Keep the provider, network, address, catalog URL, and retrieval time together. Re-fetch the official listing before using an old snapshot.
2. For Solana, query the mint with [`getAccountInfo`](https://solana.com/docs/rpc/http/getaccountinfo) using `jsonParsed` and a trusted mainnet RPC. Verify that the account exists and is owned by the intended token program. Inspect decimals and Token-2022 extensions where applicable. A syntactically valid address alone is not proof of an issuer token.
3. Query observed pools by **mint address**, not ticker, using [DEX Screener's token-pairs endpoint](https://docs.dexscreener.com/api/reference). Check `chainId`, base-token address, pool address, price, liquidity, and observation time. Pool price is separate from a provider mark, an underlying-equity reference, and an executable swap quote.
4. If execution matters, request a fresh route from the venue or aggregator for the **exact input and output mints**. A catalog listing or observed pool does not prove that a route exists now. Check provider restrictions and terms for the specific product.

For example, after setting `SOLANA_RPC_URL` to a trusted RPC endpoint and `MINT` to an address from the official catalog:

```sh
curl -fsS "$SOLANA_RPC_URL" -H 'content-type: application/json' \
  --data "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"getAccountInfo\",\"params\":[\"$MINT\",{\"encoding\":\"jsonParsed\",\"commitment\":\"confirmed\"}]}"
curl -fsS "https://api.dexscreener.com/token-pairs/v1/solana/$MINT"
```

The exporter deliberately does not label a listing as liquid, scored, legally available, or buyable. Those states need separately sourced and current evidence. To add another provider, fetch its official catalog, validate its network-specific address and URL, then map its fields into the same columns without silently replacing one provider's values with another's.

## If “get” means acquire the token

The catalog answers **what the provider lists and which token address it publishes**. Acquisition is a separate, time-sensitive check:

1. Open the product's official page and current terms. PreStocks publishes its [availability and terms](https://url.prestocks.com/terms-of-service); xStocks publishes [product and jurisdiction information](https://xstocks.com/products). The user must determine whether the product is available to them. A route is not an eligibility determination.
2. Check the provider's official issuance or purchase path, if one is offered to that user. Do not assume primary issuance is permissionless merely because the token exists onchain.
3. For a secondary Solana market, request a fresh quote using the exact input and output mints from an aggregator such as [Jupiter](https://developers.jup.ag/docs/guides/how-to-build-a-custom-swap-with-metis). Check the quoted output, price impact, slippage, minimum received, fees, and transaction expiry. A missing route means no supported route was found at that moment.
4. The user reviews and signs with their own wallet. Check onchain confirmation and the actual output-token balance before calling the acquisition complete. Never treat a quote or wallet prompt as a completed purchase.

This process works independently of the application displaying the catalog. It does not imply that every listed product can be bought, that two issuer tokens have identical rights, or that provider terms permit a particular person to transact.
