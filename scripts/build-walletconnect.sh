#!/bin/sh
# Rebuild the WalletConnect Ethereum provider bundle served at /walletconnect.js.
# Requires node/npm; the output is committed and lazy-loaded only on the cabinet.
set -eu
cd "$(dirname "$0")/.."
tmp="${TMPDIR:-/tmp}/rotor-walletconnect-build"
rm -rf "$tmp"
mkdir -p "$tmp"
cd "$tmp"
npm init -y >/dev/null
npm install --no-audit --no-fund @walletconnect/ethereum-provider@2.26.0 esbuild >/dev/null
cat > entry.js <<'JS'
import { EthereumProvider } from '@walletconnect/ethereum-provider';
export async function connect(opts) {
  const provider = await EthereumProvider.init({
    projectId: opts.projectId,
    chains: [1],
    optionalChains: [1, 56, 137, 42161, 10, 8453],
    showQrModal: true,
    metadata: opts.metadata,
    rpcMap: { 1: 'https://ethereum-rpc.publicnode.com' }
  });
  await provider.connect();
  return provider;
}
JS
./node_modules/.bin/esbuild entry.js --bundle --format=iife --global-name=RotorWC --outfile=walletconnect.js --minify
cp walletconnect.js "$OLDPWD/apps/site/walletconnect.js"
echo "wrote apps/site/walletconnect.js"
