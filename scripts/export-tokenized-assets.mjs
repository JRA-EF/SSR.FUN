#!/usr/bin/env node
// Provider catalog export. Uses only Node.js built-ins; no StockScore app imports or credentials.
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const PRESTOCKS_URL = 'https://prestocks.com/api/prestocks';
const XSTOCKS_URL = 'https://api.xstocks.fi/api/v2/public/assets';
const SOLANA_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const EXCLUDED_XSTOCK_SYMBOLS = new Set(['VCXX']); // Private-company fund exposure stays outside this export.
const COLUMNS = ['provider', 'product_name', 'symbol', 'underlying_symbol', 'underlying_type', 'network', 'token_address', 'official_product_url', 'catalog_source_url', 'provider_token_price_usd', 'provider_mark_price_usd', 'implied_valuation_usd', 'retrieved_at'];

export function normalizePrestocks(products, retrievedAt, network = 'Solana') {
  if (!Array.isArray(products)) throw new Error('PreStocks response is not an array.');
  if (network !== 'all' && network !== 'Solana') return [];
  return products.map(product => {
    if (typeof product?.symbol !== 'string' || typeof product?.name !== 'string' || !SOLANA_ADDRESS.test(product?.contract_address ?? '')) throw new Error('Malformed PreStocks product or token address.');
    const officialUrl = new URL(product.external_url);
    if (!['prestocks.com', 'www.prestocks.com'].includes(officialUrl.hostname)) throw new Error('PreStocks product URL does not point to the provider.');
    return {
      provider: 'PreStocks', product_name: product.name, symbol: product.symbol,
      underlying_symbol: null, underlying_type: null, network: 'Solana', token_address: product.contract_address,
      official_product_url: officialUrl.href, catalog_source_url: PRESTOCKS_URL,
      provider_token_price_usd: finiteOrNull(product.tokenPrice), provider_mark_price_usd: finiteOrNull(product.markPrice),
      implied_valuation_usd: finiteOrNull(product.impliedValuation), retrieved_at: retrievedAt,
    };
  });
}

export function normalizeXstocks(products, retrievedAt, network = 'Solana') {
  if (!Array.isArray(products)) throw new Error('xStocks response is not an array.');
  const seen = new Set();
  return products.flatMap(product => {
    if (typeof product?.symbol !== 'string' || typeof product?.name !== 'string' || !Array.isArray(product?.deployments)) throw new Error('Malformed xStocks asset.');
    if (EXCLUDED_XSTOCK_SYMBOLS.has(product.symbol.toUpperCase())) return [];
    return product.deployments.flatMap(deployment => {
      if (typeof deployment?.network !== 'string' || typeof deployment?.address !== 'string') return [];
      if (network !== 'all' && deployment.network !== network) return [];
      if (deployment.network === 'Solana' && !SOLANA_ADDRESS.test(deployment.address)) return [];
      const key = `${product.symbol}:${deployment.network}:${deployment.address}`;
      if (seen.has(key)) return [];
      seen.add(key);
      return [{
        provider: 'xStocks', product_name: product.name, symbol: product.symbol,
        underlying_symbol: product.underlying?.symbol ?? product.underlyingSymbol ?? null,
        underlying_type: product.underlying?.type ?? null,
        network: deployment.network, token_address: deployment.address,
        official_product_url: 'https://xstocks.com/products', catalog_source_url: XSTOCKS_URL,
        provider_token_price_usd: null, provider_mark_price_usd: null, implied_valuation_usd: null,
        retrieved_at: retrievedAt,
      }];
    });
  });
}

function finiteOrNull(value) { return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null; }

async function getJson(url) {
  const response = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return response.json();
}

export async function fetchXstocksPages(get = getJson) {
  const products = [];
  for (let pageNumber = 0; pageNumber < 100; pageNumber++) {
    const response = await get(`${XSTOCKS_URL}?page=${pageNumber}`);
    if (!Array.isArray(response?.nodes) || typeof response?.page?.hasNextPage !== 'boolean' || response.page.currentPage !== pageNumber) throw new Error(`Invalid xStocks page ${pageNumber}.`);
    products.push(...response.nodes);
    if (!response.page.hasNextPage) return products;
  }
  throw new Error('xStocks pagination exceeded 100 pages; refusing a partial export.');
}

function csvCell(value) {
  const string = value === null || value === undefined ? '' : String(value);
  return /[",\r\n]/.test(string) ? `"${string.replaceAll('"', '""')}"` : string;
}

export function toCsv(rows) { return `${COLUMNS.join(',')}\n${rows.map(row => COLUMNS.map(column => csvCell(row[column])).join(',')).join('\n')}\n`; }

async function main() {
  const args = process.argv.slice(2);
  const option = name => { const at = args.indexOf(name); return at < 0 ? null : args[at + 1]; };
  const network = option('--network') ?? 'Solana';
  const outputDir = resolve(option('--output-dir') ?? 'exports');
  if (!/^(all|[A-Za-z][A-Za-z0-9]*)$/.test(network)) throw new Error('Use --network Solana, --network all, or another network name.');
  const [prestocks, xstocks] = await Promise.all([getJson(PRESTOCKS_URL), fetchXstocksPages()]);
  const retrievedAt = new Date().toISOString();
  const rows = [...normalizePrestocks(prestocks, retrievedAt, network), ...normalizeXstocks(xstocks, retrievedAt, network)].sort((a, b) => a.provider.localeCompare(b.provider) || a.symbol.localeCompare(b.symbol) || a.network.localeCompare(b.network));
  if (!rows.length) throw new Error(`No products found for network ${network}; refusing an empty export.`);
  const data = { schema_version: '1.0', generated_at: retrievedAt, network_filter: network, sources: [PRESTOCKS_URL, XSTOCKS_URL], row_count: rows.length, products: rows };
  await mkdir(outputDir, { recursive: true });
  await Promise.all([
    writeFile(resolve(outputDir, 'tokenized-assets.json'), `${JSON.stringify(data, null, 2)}\n`),
    writeFile(resolve(outputDir, 'tokenized-assets.csv'), toCsv(rows)),
  ]);
  process.stdout.write(`Exported ${rows.length} provider deployments (${rows.filter(row => row.provider === 'PreStocks').length} PreStocks, ${rows.filter(row => row.provider === 'xStocks').length} xStocks) to ${outputDir}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(error => { console.error(error.message); process.exitCode = 1; });
