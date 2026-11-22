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
npm install --no-audit --no-fund @walletconnect/ethereum-provider@2.26.0 qrcode@1.5.4 esbuild >/dev/null
cat > entry.js <<'JS'
import { EthereumProvider } from '@walletconnect/ethereum-provider';
import QRCode from 'qrcode';

/* Every EVM chain the site supports. Chain 1 stays required; the rest join the
 * optional namespace so one EVM account works across them without inventing a
 * per-chain address. */
const OPTIONAL_CHAINS = [1, 56, 137, 42161, 10, 8453, 43114, 324];

/* Build the provider without the opaque built-in modal: the cabinet renders
 * its own panel, so it needs display_uri and the provider object before
 * connect() starts. */
export async function create(opts) {
  return EthereumProvider.init({
    projectId: opts.projectId,
    chains: [1],
    optionalChains: OPTIONAL_CHAINS,
    showQrModal: false,
    metadata: opts.metadata,
    rpcMap: { 1: 'https://ethereum-rpc.publicnode.com' }
  });
}

export async function connect(provider) {
  if (!provider || typeof provider.connect !== 'function') {
    throw new Error('WalletConnect provider is not initialised.');
  }
  await provider.connect();
  return provider;
}

/* Paint the QR for the connection URI into the cabinet's own canvas. */
export async function toCanvas(canvas, text) {
  return QRCode.toCanvas(canvas, String(text), {
    errorCorrectionLevel: 'M',
    margin: 2,
    width: 320
  });
}
JS
./node_modules/.bin/esbuild entry.js --bundle --format=iife --global-name=RotorWC --outfile=walletconnect.js --minify
cp walletconnect.js "$OLDPWD/apps/site/walletconnect.js"
echo "wrote apps/site/walletconnect.js"
