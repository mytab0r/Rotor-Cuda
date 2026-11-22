// Validation for data/assets.json, the single source of the top-10 asset list.
// Used by scripts/gen-ssot.mjs (which generates apps/site/assets.generated.js)
// and by the wallet asset tests, so one rule set covers both.
//
// Zero dependencies; Windows-safe.

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const TRON_ADDRESS_RE = /^T[1-9A-HJ-NP-Za-km-z]{33}$/;
const SYMBOL_RE = /^[A-Z0-9]{2,10}$/;
const TICKER_RE = /^[A-Z0-9]{2,10}$/;
const DECIMAL_RE = /^\d+(?:\.\d+)?$/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MULTI_CHAIN = "evm";
const BALANCE_KINDS = new Set(["native", "token", "unavailable"]);
export const TOP_ASSET_COUNT = 10;

function fail(message) {
  throw new Error(`data/assets.json: ${message}`);
}

function isObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function chainBySlug(chains) {
  const map = new Map();
  for (const chain of chains) map.set(chain.slug, chain);
  return map;
}

function addressFor(chain, value, where) {
  if (typeof value !== "string" || !value.trim()) {
    fail(`${where} must be a contract address`);
  }
  if (chain.family === "tron") {
    if (!TRON_ADDRESS_RE.test(value)) fail(`${where} is not a TRON base58 address: ${value}`);
    return value;
  }
  if (!ADDRESS_RE.test(value)) fail(`${where} is not a 0x-prefixed 20-byte address: ${value}`);
  return value;
}

function normalizeNetwork(asset, chainSlug, contract, chain, where) {
  if (!chain) fail(`${where} names unknown chain ${chainSlug}`);
  if (chain.testnet) fail(`${where} names testnet chain ${chainSlug}`);
  return {
    chain: chainSlug,
    contract: contract === null ? null : addressFor(chain, contract, `${where}.contract`),
  };
}

// Returns a normalized copy: assets sorted by rank, networks ordered as they
// are declared. Throws with a data/assets.json-prefixed message on any
// violation, so gen-ssot and check-ssot fail loud instead of shipping a bad
// list.
export function validateAssets(data, chains) {
  if (!isObject(data) || data.version !== 1 || !Array.isArray(data.assets)) {
    fail("must be { version: 1, assets: [...] }");
  }
  if (!isNonEmptyString(data.rankSource) || !isNonEmptyString(data.priceSource)) {
    fail("rankSource and priceSource must be non-empty strings");
  }
  if (!ISO_DATE_RE.test(String(data.updated || ""))) {
    fail("updated must be YYYY-MM-DD");
  }
  if (data.assets.length !== TOP_ASSET_COUNT) {
    fail(`must contain exactly ${TOP_ASSET_COUNT} assets, found ${data.assets.length}`);
  }

  const bySlug = chainBySlug(chains);
  const ranks = new Set();
  const marketRanks = new Set();
  const symbols = new Set();
  const symbolsPerChain = new Map();

  const assets = data.assets.map((asset, index) => {
    const where = `assets[${index}]`;
    if (!isObject(asset)) fail(`${where} must be an object`);
    if (!Number.isInteger(asset.rank) || asset.rank < 1 || asset.rank > TOP_ASSET_COUNT) {
      fail(`${where}.rank must be an integer between 1 and ${TOP_ASSET_COUNT}`);
    }
    if (ranks.has(asset.rank)) fail(`rank ${asset.rank} is repeated`);
    ranks.add(asset.rank);
    if (!Number.isInteger(asset.marketCapRank) || asset.marketCapRank < 1) {
      fail(`${where}.marketCapRank must be a positive integer`);
    }
    if (marketRanks.has(asset.marketCapRank)) {
      fail(`marketCapRank ${asset.marketCapRank} is repeated`);
    }
    marketRanks.add(asset.marketCapRank);

    if (typeof asset.symbol !== "string" || !SYMBOL_RE.test(asset.symbol)) {
      fail(`${where}.symbol must match ${SYMBOL_RE}`);
    }
    if (symbols.has(asset.symbol)) fail(`symbol ${asset.symbol} is repeated`);
    symbols.add(asset.symbol);
    if (!isNonEmptyString(asset.name)) fail(`${where}.name must be a non-empty string`);
    if (!Number.isInteger(asset.decimals) || asset.decimals < 0 || asset.decimals > 36) {
      fail(`${where}.decimals must be an integer between 0 and 36`);
    }
    if (!BALANCE_KINDS.has(asset.balance)) {
      fail(`${where}.balance must be native, token or unavailable`);
    }

    if (asset.ticker !== null) {
      if (typeof asset.ticker !== "string" || !TICKER_RE.test(asset.ticker)) {
        fail(`${where}.ticker must be null or match ${TICKER_RE}`);
      }
    }
    if (asset.pegUsd !== null) {
      if (typeof asset.pegUsd !== "string" || !DECIMAL_RE.test(asset.pegUsd) ||
          !(Number(asset.pegUsd) > 0)) {
        fail(`${where}.pegUsd must be null or a positive decimal string`);
      }
    }
    if ((asset.ticker === null) === (asset.pegUsd === null)) {
      fail(`${where} must declare exactly one price source: ticker or pegUsd`);
    }

    if (!isObject(asset.contracts)) fail(`${where}.contracts must be an object`);
    const contractEntries = Object.entries(asset.contracts);
    if (asset.chain === MULTI_CHAIN) {
      if (contractEntries.length === 0) {
        fail(`${where} uses chain "evm" but declares no contracts`);
      }
      if (asset.balance !== "token") {
        fail(`${where} with chain "evm" must be a token entry`);
      }
    }

    let networks;
    if (asset.chain === MULTI_CHAIN) {
      networks = contractEntries.map(([chainSlug, contract]) => {
        const chain = bySlug.get(chainSlug);
        if (!chain) fail(`${where}.contracts names unknown chain ${chainSlug}`);
        if (chain.family !== "evm") {
          fail(`${where}.contracts.${chainSlug} is not an EVM chain`);
        }
        return normalizeNetwork(asset, chainSlug, contract, chain, `${where}.contracts.${chainSlug}`);
      });
    } else {
      const chain = bySlug.get(asset.chain);
      if (!chain) fail(`${where}.chain names unknown chain ${asset.chain}`);
      if (chain.testnet) fail(`${where}.chain names testnet chain ${asset.chain}`);
      if (asset.balance === "native") {
        if (contractEntries.length !== 0) {
          fail(`${where} is native on ${asset.chain} and must not declare contracts`);
        }
        networks = [normalizeNetwork(asset, asset.chain, null, chain, `${where}.chain`)];
      } else if (asset.balance === "token") {
        if (contractEntries.length !== 1 || contractEntries[0][0] !== asset.chain) {
          fail(`${where} is a token on ${asset.chain} and must declare exactly that contract`);
        }
        networks = [normalizeNetwork(asset, asset.chain, contractEntries[0][1], chain, `${where}.contracts`)];
      } else {
        networks = contractEntries.length === 0
          ? [{ chain: asset.chain, contract: null }]
          : contractEntries.map(([chainSlug, contract]) => {
            const networkChain = bySlug.get(chainSlug);
            return normalizeNetwork(asset, chainSlug, contract, networkChain, `${where}.contracts.${chainSlug}`);
          });
      }
    }

    for (const network of networks) {
      const seen = symbolsPerChain.get(network.chain) || new Set();
      if (seen.has(asset.symbol)) {
        fail(`symbol ${asset.symbol} appears twice on ${network.chain}`);
      }
      seen.add(asset.symbol);
      symbolsPerChain.set(network.chain, seen);
      if (network.contract) {
        const tokenKey = `${asset.symbol}|${network.chain}|${network.contract.toLowerCase()}`;
        const tokens = symbolsPerChain.get("__tokens__") || new Set();
        if (tokens.has(tokenKey)) fail(`token ${tokenKey} is repeated`);
        tokens.add(tokenKey);
        symbolsPerChain.set("__tokens__", tokens);
      }
    }

    return {
      rank: asset.rank,
      marketCapRank: asset.marketCapRank,
      symbol: asset.symbol,
      name: asset.name,
      chain: asset.chain,
      contracts: Object.fromEntries(contractEntries.map(([chainSlug, contract]) => [
        chainSlug,
        addressFor(bySlug.get(chainSlug), contract, `${where}.contracts.${chainSlug}`),
      ])),
      decimals: asset.decimals,
      ticker: asset.ticker,
      pegUsd: asset.pegUsd,
      balance: asset.balance,
      networks,
    };
  });

  const ordered = assets.slice().sort((left, right) => left.rank - right.rank);
  for (let index = 0; index < ordered.length; index += 1) {
    if (ordered[index].rank !== index + 1) {
      fail(`ranks must be the contiguous sequence 1..${TOP_ASSET_COUNT}`);
    }
  }

  return {
    version: 1,
    updated: data.updated,
    rankSource: data.rankSource,
    priceSource: data.priceSource,
    assets: ordered,
  };
}
