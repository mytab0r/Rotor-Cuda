/* Single source of truth for the internal docs parity map
 * (docs/site-map/index.html).
 *
 * Update this file when a route or a capability lands; the page only renders
 * this data. Donor routes were read from
 * https://ref-site-a/sitemap.xml and the ref-site-b navigation on
 * 2026-11-19, with a few live probes (marked in `note`) where the sitemap was
 * stale.
 *
 * Status values:
 *   parity    - the route/feature exists and covers the donor scope
 *   partial   - the route exists, but a donor capability is still missing
 *   missing   - the donor has it and Rotor has no equivalent
 *   ours-only - Rotor has it and no donor equivalent is known
 */
(function () {
  'use strict';

  var CHAINS = [
    ['bitcoin', 'Bitcoin'],
    ['ethereum', 'Ethereum'],
    ['bnb', 'BNB'],
    ['arbitrum', 'Arbitrum'],
    ['optimism', 'Optimism'],
    ['base', 'Base'],
    ['polygon', 'Polygon'],
    ['avalanche', 'Avalanche'],
    ['zksync', 'zkSync Era'],
    ['solana', 'Solana'],
    ['tron', 'TRON'],
    ['xrp', 'XRP'],
    ['litecoin', 'Litecoin'],
    ['bitcoin-cash', 'Bitcoin Cash'],
    ['dogecoin', 'Dogecoin'],
    ['zcash', 'Zcash'],
    ['sui', 'Sui'],
    ['ton', 'TON']
  ];

  var RICHEST_CHAINS = [
    ['bitcoin', 'Bitcoin'],
    ['ethereum', 'Ethereum'],
    ['bnb', 'BNB'],
    ['solana', 'Solana'],
    ['tron', 'TRON'],
    ['polygon', 'Polygon'],
    ['arbitrum', 'Arbitrum'],
    ['dogecoin', 'Dogecoin']
  ];

  var ours = [];
  var donors = [];
  var features = [];

  function oursRoute(route) {
    route.id = 'ours:' + route.path;
    if (!route.href) route.href = route.path;
    if (!route.donorIds) route.donorIds = [];
    ours.push(route);
  }

  function donorRoute(route) {
    route.id = route.source + ':' + route.path;
    if (!route.href) route.href = route.path;
    donors.push(route);
  }

  function feature(entry) {
    features.push(entry);
  }

  /* ---------------------------------------------------------------- our routes */

  oursRoute({
    path: '/',
    title: 'Home',
    area: 'site',
    status: 'parity',
    priority: '-',
    donorIds: ['pkf:/'],
    note: 'Landing page with the product summary and quick-start links.'
  });

  oursRoute({
    path: '/private-keys',
    title: 'Private keys directory',
    area: 'directory',
    status: 'parity',
    priority: '-',
    donorIds: ['pkf:/private-keys', 'ss:/PrivateKeyHex'],
    note: 'Index of the 18 chain directories.'
  });

  CHAINS.forEach(function (item) {
    oursRoute({
      path: '/private-keys/' + item[0],
      title: item[1] + ' private keys',
      area: 'directory',
      status: 'parity',
      priority: '-',
      donorIds: ['pkf:/private-keys/' + item[0]],
      note: '60 rows per page, 18 chain tabs, pager + page jump, a search bar with the optional type select and `?key=` page jumps; BTC and LTC expose four address-type cards, other chains one row set as the donor. WIF (c)/(u) links are shown with the chain’s own encoding (BTC/BCH 0x80, LTC 0xb0, DOGE 0x9e). Account-model chains summarise Balance/Active; UTXO chains Balance/Received/TX, as the donor does. The donor has neither a CSV export nor balance sorting, so neither is a gap.'
    });
  });

  oursRoute({
    path: '/key',
    title: 'Key explorer',
    area: 'key',
    status: 'partial',
    priority: 'P0',
    donorIds: [
      'pkf:/key/<hex|wif|decimal>',
      'ss:/PrivateKeyHex',
      'ss:/PrivateKeyWif',
      'ss:/PrivateKeyEth',
      'ss:/PrivateKeyTron',
      'ss:/PrivateKeySegwit',
      'ss:/PrivateKey_wif_to_hex',
      'ss:/Bech32'
    ],
    note: 'Auto-derives as you type for hex, decimal, WIF, Solana keypair JSON and brainwallet text. Key facts cover HEX, DECIMAL, WIF, WIF(u), Solana keypair, XRP secret, PUBKEY and PAGE; counters (USD Total Value from a six-hour cached public ticker, Has Balance, Active Chains, Checked 18/18), eight EVM chain rows and public-row Copy All/CSV are in place. The formats help is a quiet info icon with a shared hover/focus tooltip that opens an in-place popover; random/clear/±1 use the same tooltip. Balances load for XRP (XRPScan), SOL, SUI, TON (TON Center), LTC and DOGE (BlockCypher) from free public providers; only BCH and ZEC have no provider and show —. Short URL forms /key/<1–64 hex> and /key/0x… render the padded key page; arbitrary text stays a real 404 (not the donor soft-404). The curve selector ships (secp256k1/ed25519) and the signing entry links to the testnet /send page.'
  });

  oursRoute({
    path: '/key/hex',
    title: 'Hex key calculator',
    area: 'key',
    status: 'partial',
    priority: 'P0',
    donorIds: ['pkf:/key/<hex|wif|decimal>', 'ss:/PrivateKeyHex'],
    note: 'Auto-derives from 64 hex characters to WIF, public key and addresses. Counters, key facts, eight EVM rows and public-row export are shared with /key.'
  });

  oursRoute({
    path: '/key/wif',
    title: 'WIF calculator',
    area: 'key',
    status: 'partial',
    priority: 'P0',
    donorIds: ['pkf:/key/<hex|wif|decimal>', 'ss:/PrivateKeyWif', 'ss:/PrivateKey_wif_to_hex'],
    note: 'Auto-derives from 5…, K… or L… to hex and addresses. Counters, key facts, eight EVM rows and public-row export are shared with /key.'
  });

  oursRoute({
    path: '/key/decimal',
    title: 'Decimal key calculator',
    area: 'key',
    status: 'partial',
    priority: 'P0',
    donorIds: ['pkf:/key/<hex|wif|decimal>'],
    note: 'Auto-derives from a decimal integer below the curve order. Counters, key facts, eight EVM rows and public-row export are shared with /key.'
  });

  oursRoute({
    path: '/mnemonic-seeds',
    title: 'Mnemonic seeds directory',
    area: 'seeds',
    status: 'parity',
    priority: '-',
    donorIds: ['pkf:/mnemonic-seeds'],
    note: '60 seed rows per page with phrase, private key copy, paths, address types and balances for Bitcoin and EVM chains; every other chain shows — with an unsupported state. TON is an explicit unsupported state. Rows carry no WIF links, matching the donor.'
  });

  CHAINS.forEach(function (item) {
    var ton = item[0] === 'ton';
    oursRoute({
      path: '/mnemonic-seeds/' + item[0],
      title: item[1] + ' mnemonic seeds',
      area: 'seeds',
      status: ton ? 'partial' : 'parity',
      priority: ton ? 'P1' : '-',
      donorIds: ['pkf:/mnemonic-seeds/' + item[0]],
      note: ton
        ? 'Seed derivation for TON is not implemented; the page shows an explicit unsupported state instead of a faked address.'
        : 'Phrase, private key copy, path, address type and balances for Bitcoin and EVM chains (— elsewhere); no WIF links, matching the donor.'
    });
  });

  oursRoute({
    path: '/seed',
    title: 'Seed studio',
    area: 'seeds',
    status: 'ours-only',
    priority: '-',
    donorIds: [],
    note: 'BIP39 entropy 12/15/18/21/24 plus Electrum old and Electrum BIP39, passphrase, paths and address counts. The donor has no equivalent studio. It stays a tool ("Convert or generate your own phrase"), linked from /tools, /key, the /mnemonic-seeds hub and /mnemonic-converter; it is not the Seeds nav destination.'
  });

  oursRoute({
    path: '/mnemonic-converter',
    title: 'Mnemonic converter',
    area: 'seeds',
    status: 'partial',
    priority: 'P1',
    donorIds: ['pkf:/mnemonic-converter'],
    note: 'Word counter, 20-address option, “Load next 5”, Copy All and Active/Sum aggregates are present. The donor’s lifetime Received total is not shown because the public providers used here do not return it; there is no separate hardened checkbox.'
  });

  oursRoute({
    path: '/bitcoin-puzzle',
    title: 'Bitcoin puzzle index',
    area: 'puzzle',
    status: 'parity',
    priority: '-',
    donorIds: ['pkf:/bitcoin-puzzle', 'ss:/bitcoin-puzzle'],
    note: '160-puzzle table with All/Solved/Unsolved filters, search, Balance/TX/Actions columns and BTC claimed/left stats.'
  });

  oursRoute({
    path: '/bitcoin-puzzle/<n>',
    href: '/bitcoin-puzzle/71',
    title: 'Puzzle detail',
    area: 'puzzle',
    status: 'parity',
    priority: '-',
    donorIds: ['pkf:/bitcoin-puzzle/<n>'],
    note: 'Target and range copy, difficulty, decimal key space, TX link, /private-keys cross-link and the 1–160 picker.'
  });

  oursRoute({
    path: '/bitcoin-puzzle/<n>/random',
    href: '/bitcoin-puzzle/71/random',
    title: 'Puzzle random keys',
    area: 'puzzle',
    status: 'parity',
    priority: '-',
    donorIds: ['pkf:/bitcoin-puzzle/<n>/random'],
    note: 'Local WASM worker plus Community Hunt, live results table, range presets and a match panel with key copy.'
  });

  oursRoute({
    path: '/brainwallet',
    title: 'Brainwallet directory',
    area: 'brainwallet',
    status: 'parity',
    priority: '-',
    donorIds: ['pkf:/brainwallet'],
    note: '18 chain tiles, an 18,890-passphrase counter, explainer blocks and links to the generator, key calculator and seed tool.'
  });

  CHAINS.forEach(function (item) {
    oursRoute({
      path: '/brainwallet/' + item[0],
      title: item[1] + ' brainwallets',
      area: 'brainwallet',
      status: 'parity',
      priority: '-',
      donorIds: ['pkf:/brainwallet/' + item[0]],
      note: '60 rows × 315 pages: SHA-256 key and phrase copy, the hex key plus WIF(c)/WIF(u) links to /key/<key> on BTC/BCH/LTC/DOGE with the chain’s own WIF encoding (BTC/BCH 0x80, LTC 0xb0, DOGE 0x9e), chain address with explorer and copy, address types where the chain supports them, optional balances.'
    });
  });

  oursRoute({
    path: '/brainwallet-generator',
    title: 'Brainwallet generator',
    area: 'brainwallet',
    status: 'parity',
    priority: '-',
    donorIds: ['pkf:/brainwallet-generator'],
    note: 'Network dropdown for 18 chains, 1/3/5/10 addresses, Generate & Check Balance, Copy all and CSV.'
  });

  oursRoute({
    path: '/tools',
    title: 'Tools index',
    area: 'tools',
    status: 'ours-only',
    priority: '-',
    donorIds: [],
    note: 'Crypto-wide calculator catalogue and per-chain generator entry points.'
  });

  oursRoute({
    path: '/vanity',
    title: 'Vanity generator',
    area: 'tools',
    status: 'partial',
    priority: 'P1',
    donorIds: ['pkf:/vanity-generator', 'ss:/vanity-generator'],
    note: 'Six networks, parallel workers (1-4), difficulty, ETA, a recent-5 list and an address QR. Saving keys is intentionally absent; keys are never saved.'
  });

  oursRoute({
    path: '/milk-sad',
    title: 'Milk Sad audit',
    area: 'tools',
    status: 'ours-only',
    priority: '-',
    donorIds: [],
    note: 'Owner-facing explanation of the Libbitcoin bx seed weak-entropy issue.'
  });

  oursRoute({
    path: '/hex-dec-bin',
    title: 'Hex / decimal / binary',
    area: 'tools',
    status: 'parity',
    priority: '-',
    donorIds: ['pkf:/hex-dec-bin', 'ss:/HexDecBin'],
    note: 'Unsigned 0..2^256-1 conversion with validation and copy.'
  });

  oursRoute({
    path: '/public-key',
    title: 'Public key to addresses',
    area: 'tools',
    status: 'parity',
    priority: '-',
    donorIds: ['pkf:/public-key', 'ss:/PublicKey'],
    note: 'Compressed/uncompressed secp256k1 to BTC, EVM and TRON addresses without a private key.'
  });

  oursRoute({
    path: '/pubkey-add',
    title: 'Add public keys',
    area: 'tools',
    status: 'partial',
    priority: 'P1',
    donorIds: ['pkf:/pubkey-add', 'ss:/PubkeyAdd'],
    note: 'P + Q, P − Q and k · P are shipped; the donor offers the same three operations.'
  });

  oursRoute({
    path: '/reconstruction',
    title: 'Byte-fragment assembler',
    area: 'tools',
    status: 'partial',
    priority: 'P1',
    donorIds: ['pkf:/reconstruction', 'ss:/Reconstruction'],
    note: 'Different semantics: Crypto assembles known bytes at fixed offsets and never guesses. Donor reconstruction uses ±a±λb formulas.'
  });

  oursRoute({
    path: '/keystore-parser',
    title: 'Keystore parser',
    area: 'tools',
    status: 'partial',
    priority: 'P1',
    donorIds: ['pkf:/keystore-parser', 'ss:/keystore-parser'],
    note: 'Local V3 decrypt, drag-drop/file input, a verified web3 test-vector example and id/version/cipher/address metadata.'
  });

  oursRoute({
    path: '/tx',
    title: 'Transaction decoders',
    area: 'tools',
    status: 'parity',
    priority: '-',
    donorIds: ['ss:/Transaction_decoded_Bitcoin', 'ss:/decode_ethereum_transaction'],
    note: 'Shared index for the two client-side decoders.'
  });

  oursRoute({
    path: '/tx/bitcoin',
    title: 'Bitcoin transaction decoder',
    area: 'tools',
    status: 'parity',
    priority: '-',
    donorIds: ['ss:/Transaction_decoded_Bitcoin'],
    note: 'Raw legacy or SegWit hex to inputs, outputs, script types/addresses, locktime, size/weight/vsize and JSON. A fee appears only when prevout values are supplied; no guessing.'
  });

  oursRoute({
    path: '/tx/ethereum',
    title: 'Ethereum transaction decoder',
    area: 'tools',
    status: 'parity',
    priority: '-',
    donorIds: ['ss:/decode_ethereum_transaction'],
    note: 'Raw legacy, EIP-2930 and EIP-1559 hex to chain id, gas/fee fields, destination or contract creation, value, data, access list, signature fields and JSON. Canonical RLP is validated; no signature recovery.'
  });

  oursRoute({
    path: '/send',
    title: 'Testnet send',
    area: 'tools',
    status: 'partial',
    priority: 'P0',
    donorIds: ['ss:/Easy_bitcoin_transaction_online', 'ss:/Easy_ethereum_transaction_online', 'ss:/Easy_bnb_transaction_online', 'ss:/Easy_usdt_erc20_transaction_online'],
    note: 'Top-level TESTNET-only send page shared by /send, /send/bitcoin, /send/ethereum, /send/bnb, /send/usdt and /send/tron. Every route accepts a testnet WIF or a 64-hex key; on the EVM and TRON routes a Bitcoin mainnet/testnet WIF is only a 32-byte key container and its network byte does not select the chain. Keys derive, sign and broadcast locally; mainnet slugs, mainnet chain ids and mainnet endpoints are rejected in code. The donor covers more chains on mainnet; ours is deliberately testnet-only.'
  });

  oursRoute({
    path: '/send/bitcoin',
    title: 'Send Bitcoin testnet',
    area: 'tools',
    status: 'partial',
    priority: 'P0',
    donorIds: ['ss:/Easy_bitcoin_transaction_online'],
    note: 'Bitcoin testnet only: testnet WIF or 64-hex key, tb1q destination, coin selection, review, local P2WPKH signing and an optional mempool.space testnet broadcast. Mainnet WIFs are rejected.'
  });

  oursRoute({
    path: '/send/ethereum',
    title: 'Send Ethereum Sepolia',
    area: 'tools',
    status: 'partial',
    priority: 'P0',
    donorIds: ['ss:/Easy_ethereum_transaction_online'],
    note: 'Ethereum Sepolia only: testnet WIF or 64-hex key (a WIF is used as its 32-byte key; its network byte does not select the chain), chain-id 11155111 guard, fee/nonce estimates from allowlisted Sepolia RPCs, review, local EIP-1559 signing and an optional broadcast. Mainnet RPCs are rejected.'
  });

  oursRoute({
    path: '/send/bnb',
    title: 'Send BNB Smart Chain testnet',
    area: 'tools',
    status: 'partial',
    priority: 'P0',
    donorIds: ['ss:/Easy_bnb_transaction_online'],
    note: 'BNB Smart Chain testnet only (chapel, chain id 97): testnet WIF or 64-hex key (a WIF is used as its 32-byte key; its network byte does not select the chain), allowlisted BSC-testnet RPCs, chain-id guard, review, local EIP-1559 signing and an optional testnet.bscscan.com broadcast. BSC mainnet (chain id 56) and mainnet RPCs are rejected. The donor also covers mainnet.'
  });

  oursRoute({
    path: '/send/tron',
    title: 'Send TRON Nile testnet',
    area: 'tools',
    status: 'partial',
    priority: 'P0',
    donorIds: ['ss:/Easy_tron_trx_transaction_online'],
    note: 'TRON Nile testnet only: a testnet WIF or 64-hex key (a WIF is used as its 32-byte key; its network byte does not select the chain; the same 32 bytes derive the same TRON address), a T... base58 recipient and TRX->sun conversion feed the WASM TransferContract builder. Review shows the ref block, expiration, txID and raw_data_hex; signing is local and an optional broadcast posts only to api.nileex.io. Mainnet TRON hosts and the mainnet tron route are rejected. The donor covers mainnet TRX.'
  });

  oursRoute({
    path: '/send/usdt',
    title: 'Send an ERC-20 transfer on Sepolia',
    area: 'tools',
    status: 'partial',
    priority: 'P0',
    donorIds: ['ss:/Easy_usdt_erc20_transaction_online'],
    note: 'Generic ERC-20 transfer(address,uint256) builder on Ethereum Sepolia from a testnet WIF or 64-hex key (a WIF is used as its 32-byte key; its network byte does not select the chain). No token contract is hardcoded: the user supplies the contract, decimals (default 6) and amount, and the exact calldata is shown in the review. There is no canonical USDT deployment on Sepolia, so this is not a USDT-specific mainnet flow.'
  });

  oursRoute({
    path: '/wallets',
    title: 'Wallet database storefront',
    area: 'wallet',
    status: 'ours-only',
    priority: '-',
    donorIds: ['pkf:/downloads', 'ss:/wallets'],
    note: 'Crypto mirrors six Rich-Address-Wallet downloads through its origin. ref-site-a serves ten direct files on /downloads (that exact path now redirects here); ref-site-b shows a market/price table.'
  });

  oursRoute({
    path: '/cabinet/wallet',
    title: 'Cabinet wallet',
    area: 'wallet',
    status: 'ours-only',
    priority: '-',
    donorIds: [],
    note: 'Encrypted local vault and Sepolia review/confirm flow. The import card also generates a 12/24-word BIP39 phrase, shows its word count, entropy bits and checksum state with a brute-force estimate, then derives one chain-specific key (BIP44 preset) into the vault. No donor equivalent.'
  });

  oursRoute({
    path: '/cabinet',
    title: 'Cabinet',
    area: 'wallet',
    status: 'partial',
    priority: 'P2',
    donorIds: ['ss:/dashboard'],
    note: 'Address monitor and account workspace. ref-site-b /dashboard is a calculator dashboard, not the same product.'
  });

  oursRoute({
    path: '/faq',
    title: 'FAQ',
    area: 'site',
    status: 'parity',
    priority: '-',
    donorIds: ['pkf:/faq']
  });

  oursRoute({
    path: '/disclaimer',
    title: 'Disclaimer',
    area: 'site',
    status: 'parity',
    priority: '-',
    donorIds: ['pkf:/disclaimer']
  });

  oursRoute({
    path: '/donate',
    title: 'Donate',
    area: 'site',
    status: 'parity',
    priority: '-',
    donorIds: ['pkf:/donate']
  });

  oursRoute({
    path: '/docs',
    title: 'Docs',
    area: 'site',
    status: 'ours-only',
    priority: '-',
    donorIds: [],
    note: 'Operator and client documentation; no donor equivalent.'
  });

  oursRoute({
    path: '/design',
    title: 'Design gallery',
    area: 'site',
    status: 'ours-only',
    priority: '-',
    donorIds: [],
    note: 'Internal noindex component gallery generated from design/components/*.json. It is reachable only by direct URL and is not linked from the navigation.'
  });

  /* ------------------------------------------------------------ donor routes */

  donorRoute({
    source: 'pkf',
    path: '/',
    title: 'Home',
    area: 'site',
    status: 'parity',
    ours: '/'
  });

  donorRoute({
    source: 'pkf',
    path: '/private-keys',
    title: 'Private keys directory',
    area: 'directory',
    status: 'parity',
    ours: '/private-keys'
  });

  CHAINS.forEach(function (item) {
    donorRoute({
      source: 'pkf',
      path: '/private-keys/' + item[0],
      title: item[1] + ' private keys',
      area: 'directory',
      status: 'parity',
      ours: '/private-keys/' + item[0],
      note: ''
    });
  });

  donorRoute({
    source: 'pkf',
    path: '/key/<hex|wif|decimal>',
    href: '/key/0000000000000000000000000000000000000000000000000000000000000001',
    title: 'Key entity pages',
    area: 'key',
    status: 'partial',
    ours: '/key',
    note: 'Auto-derive, aggregates, CSV and eight EVM chain rows are present. Short and 0x-prefixed hex plus WIF resolve; arbitrary text stays a real 404 (not the donor soft-404).'
  });

  donorRoute({
    source: 'pkf',
    path: '/mnemonic-seeds',
    title: 'Mnemonic seeds directory',
    area: 'seeds',
    status: 'parity',
    ours: '/mnemonic-seeds'
  });

  CHAINS.forEach(function (item) {
    donorRoute({
      source: 'pkf',
      path: '/mnemonic-seeds/' + item[0],
      title: item[1] + ' mnemonic seeds',
      area: 'seeds',
      status: item[0] === 'ton' ? 'partial' : 'parity',
      ours: '/mnemonic-seeds/' + item[0],
      note: item[0] === 'ton' ? 'Crypto shows an explicit TON-unsupported state.' : ''
    });
  });

  donorRoute({
    source: 'pkf',
    path: '/mnemonic-converter',
    title: 'Mnemonic converter',
    area: 'seeds',
    status: 'partial',
    ours: '/mnemonic-converter'
  });

  donorRoute({
    source: 'pkf',
    path: '/bitcoin-puzzle',
    title: 'Bitcoin puzzle index',
    area: 'puzzle',
    status: 'parity',
    ours: '/bitcoin-puzzle'
  });

  donorRoute({
    source: 'pkf',
    path: '/bitcoin-puzzle/<n>',
    href: '/bitcoin-puzzle/71',
    title: 'Puzzle detail',
    area: 'puzzle',
    status: 'parity',
    ours: '/bitcoin-puzzle/<n>'
  });

  donorRoute({
    source: 'pkf',
    path: '/bitcoin-puzzle/<n>/random',
    href: '/bitcoin-puzzle/71/random',
    title: 'Puzzle random keys',
    area: 'puzzle',
    status: 'parity',
    ours: '/bitcoin-puzzle/<n>/random'
  });

  donorRoute({
    source: 'pkf',
    path: '/brainwallet',
    title: 'Brainwallet directory',
    area: 'brainwallet',
    status: 'parity',
    ours: '/brainwallet'
  });

  CHAINS.forEach(function (item) {
    donorRoute({
      source: 'pkf',
      path: '/brainwallet/' + item[0],
      title: item[1] + ' brainwallets',
      area: 'brainwallet',
      status: 'parity',
      priority: '-',
      ours: '/brainwallet/' + item[0],
      note: 'Live on the donor but absent from its sitemap.'
    });
  });

  donorRoute({
    source: 'pkf',
    path: '/brainwallet-generator',
    title: 'Brainwallet generator',
    area: 'brainwallet',
    status: 'parity',
    ours: '/brainwallet-generator'
  });

  donorRoute({
    source: 'pkf',
    path: '/vanity-generator',
    title: 'Vanity generator',
    area: 'tools',
    status: 'partial',
    ours: '/vanity'
  });

  donorRoute({
    source: 'pkf',
    path: '/keystore-parser',
    title: 'Keystore parser',
    area: 'tools',
    status: 'partial',
    ours: '/keystore-parser'
  });

  donorRoute({
    source: 'pkf',
    path: '/public-key',
    title: 'Public key to addresses',
    area: 'tools',
    status: 'parity',
    ours: '/public-key'
  });

  donorRoute({
    source: 'pkf',
    path: '/hex-dec-bin',
    title: 'Hex / decimal / binary',
    area: 'tools',
    status: 'parity',
    ours: '/hex-dec-bin'
  });

  donorRoute({
    source: 'pkf',
    path: '/pubkey-add',
    title: 'Add public keys',
    area: 'tools',
    status: 'partial',
    ours: '/pubkey-add'
  });

  donorRoute({
    source: 'pkf',
    path: '/reconstruction',
    title: 'Private key reconstruction',
    area: 'tools',
    status: 'partial',
    ours: '/reconstruction',
    note: 'Donor reconstructs from ±a±λb formulas; Crypto only assembles known bytes.'
  });

  donorRoute({
    source: 'pkf',
    path: '/richest',
    title: 'Rich list index',
    area: 'wallet',
    status: 'missing',
    priority: 'P0',
    ours: null,
    note: 'Interactive top-100 with rank, address, label, type, balance and actions.'
  });

  RICHEST_CHAINS.forEach(function (item) {
    donorRoute({
      source: 'pkf',
      path: '/richest/' + item[0],
      title: item[1] + ' rich list',
      area: 'wallet',
      status: 'missing',
      priority: 'P0',
      ours: null,
      note: 'Type filters All/Exchanges/Contracts/Unknown and address search.'
    });
  });

  donorRoute({
    source: 'pkf',
    path: '/bitcoin-dormant',
    title: 'Bitcoin dormant wallets',
    area: 'wallet',
    status: 'missing',
    priority: 'P1',
    ours: null,
    note: 'Content hub with stats, tables, filters and pagination.'
  });

  donorRoute({
    source: 'pkf',
    path: '/satoshi-wallets',
    title: 'Satoshi wallets',
    area: 'wallet',
    status: 'missing',
    priority: 'P1',
    ours: null
  });

  donorRoute({
    source: 'pkf',
    path: '/whale-tracker',
    title: 'Whale tracker',
    area: 'wallet',
    status: 'missing',
    priority: 'P2',
    ours: null
  });

  donorRoute({
    source: 'pkf',
    path: '/wallet-viewer',
    title: 'Wallet viewer',
    area: 'wallet',
    status: 'missing',
    priority: 'P2',
    ours: null,
    note: 'Read-only address lookup with explorer links.'
  });

  donorRoute({
    source: 'pkf',
    path: '/wallets',
    title: 'Wallet catalogue',
    area: 'wallet',
    status: 'ours-only',
    ours: '/wallets',
    note: 'The donor URL returns a generic soft landing, not a catalogue.'
  });

  donorRoute({
    source: 'pkf',
    path: '/downloads',
    title: 'Downloadable datasets',
    area: 'wallet',
    status: 'partial',
    ours: '/wallets',
    note: 'Ten direct dataset files on the donor; Crypto mirrors six under /wallets and redirects this exact path there.'
  });

  donorRoute({
    source: 'pkf',
    path: '/faq',
    title: 'FAQ',
    area: 'site',
    status: 'parity',
    ours: '/faq'
  });

  donorRoute({
    source: 'pkf',
    path: '/disclaimer',
    title: 'Disclaimer',
    area: 'site',
    status: 'parity',
    ours: '/disclaimer'
  });

  donorRoute({
    source: 'pkf',
    path: '/donate',
    title: 'Donate',
    area: 'site',
    status: 'parity',
    ours: '/donate'
  });

  /* ref-site-b navigation, 2026-11-19. */
  [
    ['/PrivateKeyHex', 'Private key (HEX)', 'key', '/key/hex', 'partial', 'P0', 'Auto-derive, counters, Copy All/CSV and the donor’s eight EVM chain rows (`↑ same`) are present; BCH and ZEC balances stay `—` (no keyless provider).'],
    ['/PrivateKeyWif', 'Private key (WIF)', 'key', '/key/wif', 'partial', 'P0', 'Auto-derive, counters, Copy All/CSV and the donor’s eight EVM chain rows (`↑ same`) are present; BCH and ZEC balances stay `—` (no keyless provider).'],
    ['/PrivateKeyEth', 'Ethereum private key', 'key', '/key?chain=ethereum', 'partial', 'P0', 'Crypto shows one shared `0x` EVM row plus the eight donor chain rows marked `↑ same`; BCH and ZEC balances stay `—` (no keyless provider).'],
    ['/PrivateKeyTron', 'TRON private key', 'key', '/key?chain=tron', 'partial', 'P0', 'Auto-derive, counters, Copy All/CSV and the donor’s eight EVM chain rows (`↑ same`) are present; BCH and ZEC balances stay `—` (no keyless provider).'],
    ['/PrivateKeySegwit', 'SegWit private key', 'key', '/key?chain=bitcoin&type=segwit', 'partial', 'P0', 'Auto-derive, counters, Copy All/CSV and the donor’s eight EVM chain rows (`↑ same`) are present; BCH and ZEC balances stay `—` (no keyless provider).'],
    ['/PrivateKey_wif_to_hex', 'WIF to HEX', 'key', '/key/wif', 'partial', 'P0', 'Auto-derive, counters, Copy All/CSV and the donor’s eight EVM chain rows (`↑ same`) are present; BCH and ZEC balances stay `—` (no keyless provider).'],
    ['/Bech32', 'Bech32 address calculator', 'key', '/key?chain=bitcoin&type=segwit', 'partial', 'P0', 'Auto-derive, counters, Copy All/CSV and the donor’s eight EVM chain rows (`↑ same`) are present; BCH and ZEC balances stay `—` (no keyless provider).'],
    ['/PublicKey', 'Public key calculator', 'tools', '/public-key', 'parity', '-', ''],
    ['/PubkeyAdd', 'Add public keys', 'tools', '/pubkey-add', 'parity', '-', 'P + Q, P − Q and k · P run in the local wasm core, with the same compressed/uncompressed report.'],
    ['/Reconstruction', 'Private key reconstruction', 'tools', '/reconstruction', 'partial', 'P1', 'Formula search vs a known-byte assembler.'],
    ['/HexDecBin', 'Hex / decimal / binary', 'tools', '/hex-dec-bin', 'parity', '-', ''],
    ['/Transaction_decoded_Bitcoin', 'Bitcoin transaction decoder', 'tools', '/tx/bitcoin', 'parity', '-', 'Raw hex to inputs, outputs, scripts, fee (with supplied prevouts) and JSON.'],
    ['/decode_ethereum_transaction', 'Ethereum transaction decoder', 'tools', '/tx/ethereum', 'parity', '-', 'Raw hex to type, gas/fee fields, access list, signature and JSON. No signature recovery.'],
    ['/Easy_bitcoin_transaction_online', 'Bitcoin transaction builder', 'tools', '/send/bitcoin', 'partial', 'P0', 'Top-level testnet-only /send/bitcoin page; the donor also covers mainnet.'],
    ['/Easy_ethereum_transaction_online', 'Ethereum transaction builder', 'tools', '/send/ethereum', 'partial', 'P0', 'Top-level Sepolia-only /send/ethereum page that accepts a testnet WIF or 64-hex key; mainnet RPCs are rejected in code.'],
    ['/Easy_bnb_transaction_online', 'BNB transaction builder', 'tools', '/send/bnb', 'partial', 'P0', 'Top-level BNB Smart Chain testnet-only /send/bnb page (chapel, chain id 97) that accepts a testnet WIF or 64-hex key; BSC mainnet chain id 56 and mainnet RPCs are rejected. The donor also covers mainnet.'],
    ['/Easy_tron_trx_transaction_online', 'TRON TRX transaction builder', 'tools', '/send/tron', 'partial', 'P0', 'Top-level TRON Nile testnet-only /send/tron page that accepts a testnet WIF or 64-hex key: TRX->sun conversion, local WASM TransferContract signing and an optional api.nileex.io broadcast; mainnet TRON hosts and the mainnet tron route are rejected. The donor covers mainnet TRX.'],
    ['/Easy_usdt_erc20_transaction_online', 'USDT ERC20 transaction builder', 'tools', '/send/usdt', 'partial', 'P0', 'Generic ERC-20 transfer builder on Ethereum Sepolia from a testnet WIF or 64-hex key with a user-supplied contract; no canonical USDT on Sepolia is assumed. The donor covers mainnet USDT.'],
    ['/wallets', 'Wallet market table', 'wallet', '/wallets', 'ours-only', '-', 'Crypto mirrors real dataset downloads; ref-site-b shows prices and terms.'],
    ['/richest', 'Rich lists', 'wallet', null, 'missing', 'P0', 'The ref-site-b nav link currently answers 404.'],
    ['/bitcoin-puzzle', 'Bitcoin puzzle', 'puzzle', '/bitcoin-puzzle', 'parity', '-', 'Table, filters, local worker and Community Hunt now match the donor scope.'],
    ['/vanity-generator', 'Vanity generator', 'tools', '/vanity', 'partial', 'P1', 'Crypto shows parallel workers (1-4), difficulty, ETA, a recent-address list and an address QR (addresses only; keys are never saved). Saving keys is intentionally absent.'],
    ['/keystore-parser', 'Keystore parser', 'tools', '/keystore-parser', 'partial', 'P1', 'Crypto has drag-drop/file input, a verified public test-vector example and keystore metadata; decryption stays in the tab.'],
    ['/dashboard', 'Account dashboard', 'wallet', '/cabinet', 'partial', 'P2', 'Crypto /cabinet is an address monitor, not a calculator dashboard.'],
    ['/results', 'Scanner results', 'tools', null, 'missing', 'P2', 'No scanner in Crypto, so there is nothing honest to show.'],
    ['/scaner', 'Address scanner', 'tools', null, 'missing', 'P2', 'No fake progress: a real scanner is required first.'],
    ['/programs', 'Program catalogue', 'site', null, 'missing', 'P3', ''],
    ['/rent', 'Rental / paid compute', 'site', null, 'missing', 'P3', ''],
    ['/benchmark', 'Benchmark', 'tools', null, 'missing', 'P3', ''],
    ['/about', 'About', 'site', null, 'missing', 'P3', 'Crypto docs are not an about page.']
  ].forEach(function (row) {
    donorRoute({
      source: 'ss',
      path: row[0],
      title: row[1],
      area: row[2],
      ours: row[3],
      status: row[4],
      priority: row[5],
      note: row[6]
    });
  });

  /* --------------------------------------------------------- feature matrix */

  feature({
    id: 'key-pager',
    area: 'directory',
    capability: 'Key directory pagination, random page and jump',
    donor: 'present',
    rotor: 'present',
    status: 'parity',
    priority: '-',
    sources: ['ref-site-a'],
    note: '60 rows per page with First/Previous/Random/Next/Last and a page jump; `?key=` jumps to the page that contains the key.'
  });

  feature({
    id: 'key-balances',
    area: 'directory',
    capability: 'Per-row automatic balance checks',
    donor: 'present',
    rotor: 'partial',
    status: 'partial',
    priority: 'P1',
    sources: ['ref-site-a'],
    note: 'Opt-in per row; only derived public addresses are queried. BTC, the eight EVM rows, TRON, XRP, SOL, SUI and TON have directory providers. LTC/DOGE do have a keyless BlockCypher provider on the single-key page, but a 60-row directory lookup would exceed its keyless rate limit, so their cells stay — (as do BCH/ZEC, which have no free keyless provider) instead of a fake zero.'
  });

  feature({
    id: 'key-types',
    area: 'directory',
    capability: 'Address-type tabs per chain',
    donor: 'present',
    rotor: 'present',
    status: 'parity',
    priority: '-',
    sources: ['ref-site-a'],
    note: 'BTC and LTC expose legacy/segwit/script/taproot; BCH legacy + CashAddr; TON v4R2 + W5; DOGE and ZEC compressed + uncompressed (`key.js` ID_LABELS, `crates/rotor-wasm/src/derive.rs`, `address-codecs.js`). The page derives the selected curve (secp256k1/ed25519) instead of printing both curves at once.'
  });

  feature({
    id: 'key-wif-links',
    area: 'directory',
    capability: 'WIF links on Bitcoin rows',
    donor: 'present',
    rotor: 'present',
    status: 'parity',
    priority: '-',
    sources: ['ref-site-a'],
    note: 'BTC rows link to /key/<WIF>; details show compressed and uncompressed WIF.'
  });

  feature({
    id: 'seed-directory',
    area: 'seeds',
    capability: 'Seed directory with 60-row pages',
    donor: 'present',
    rotor: 'partial',
    status: 'partial',
    priority: 'P1',
    sources: ['ref-site-a'],
    note: 'All chains except TON: rows, pager, word counts, phrase/key/WIF copy, path and address types are present. Balance checks run for BTC and the EVM chains only (mnemonic-seeds providerMeta); TON is an explicit unsupported state.'
  });

  feature({
    id: 'seed-row-key',
    area: 'seeds',
    capability: 'Seed row private key/WIF and copy actions',
    donor: 'present',
    rotor: 'present',
    status: 'parity',
    priority: '-',
    sources: ['ref-site-a'],
    note: 'Bitcoin rows expose the compressed WIF; other curves expose the derived hex key, each with a copy action.'
  });

  feature({
    id: 'seed-studio',
    area: 'seeds',
    capability: 'Seed studio: entropy, BIP39/Electrum, passphrase, paths',
    donor: 'partial',
    rotor: 'present',
    status: 'parity',
    priority: '-',
    sources: ['ref-site-a'],
    note: 'Crypto adds Electrum old and Electrum BIP39 and all BIP39 entropy lengths.'
  });

  feature({
    id: 'seed-converter',
    area: 'seeds',
    capability: 'Mnemonic converter: word counter, 20 addresses, Copy All, aggregates, hardened, breadcrumbs',
    donor: 'present',
    rotor: 'partial',
    status: 'partial',
    priority: 'P1',
    sources: ['ref-site-a'],
    note: 'Word counter, 20 addresses, Load next 5, Copy All and Active/Sum aggregates are present, as are breadcrumbs. There is no separate hardened checkbox, and the lifetime Received total is not shown because the public providers do not return it.'
  });

  feature({
    id: 'puzzle-home',
    area: 'puzzle',
    capability: 'Puzzle home: 160-table, All/Solved/Unsolved filters, search, stats',
    donor: 'present',
    rotor: 'present',
    status: 'parity',
    priority: '-',
    sources: ['ref-site-a', 'ref-site-b'],
    note: '160 rows with Balance/TX/Actions columns, solved filters, search and BTC claimed/left stats.'
  });

  feature({
    id: 'puzzle-random',
    area: 'puzzle',
    capability: 'Puzzle random: Community Hunt, results table, offline advice',
    donor: 'present',
    rotor: 'present',
    status: 'parity',
    priority: '-',
    sources: ['ref-site-a'],
    note: 'Community Hunt stats, live results table, presets, local WASM worker and a key-copy match panel.'
  });

  feature({
    id: 'puzzle-detail',
    area: 'puzzle',
    capability: 'Puzzle detail: copy target/range, difficulty/TX, decimal, grid',
    donor: 'present',
    rotor: 'present',
    status: 'parity',
    priority: '-',
    sources: ['ref-site-a'],
    note: 'Target/range copy, difficulty, decimal key space, TX link, /private-keys cross-link and the 1–160 picker.'
  });

  feature({
    id: 'puzzle-worker',
    area: 'puzzle',
    capability: 'Browser WASM puzzle worker',
    donor: 'present',
    rotor: 'present',
    status: 'parity',
    priority: '-',
    sources: ['ref-site-a'],
    note: 'Solo Random/Solo Seq and a separate Team mode; no silent mix of local and lease work.'
  });

  feature({
    id: 'brainwallet-directory',
    area: 'brainwallet',
    capability: 'Brainwallet directory index',
    donor: 'present',
    rotor: 'present',
    status: 'parity',
    priority: '-',
    sources: ['ref-site-a'],
    note: '18 chain tiles, an 18,890 counter, explainer blocks and links to the generator/key/seed tools.'
  });

  feature({
    id: 'brainwallet-calc',
    area: 'brainwallet',
    capability: 'Single brainwallet calculator',
    donor: 'present',
    rotor: 'present',
    status: 'parity',
    priority: '-',
    sources: ['ref-site-a'],
    note: 'Shared SHA-256 engine, BTC legacy/SegWit/Taproot or ETH rows, explorer links and copy.'
  });

  feature({
    id: 'brainwallet-chains',
    area: 'brainwallet',
    capability: 'Per-chain brainwallet listing pages (18 chains)',
    donor: 'present',
    rotor: 'present',
    status: 'parity',
    priority: '-',
    sources: ['ref-site-a'],
    note: '60 rows × 315 pages per chain with key and phrase copy, the hex key plus WIF(c)/WIF(u) links to /key/<key> on BTC/BCH/LTC/DOGE with the chain’s own WIF encoding (BTC/BCH 0x80, LTC 0xb0, DOGE 0x9e), address/explorer/copy, address types and optional balances.'
  });

  feature({
    id: 'brainwallet-generator',
    area: 'brainwallet',
    capability: 'Brainwallet generator: network dropdown, counts, Copy All, CSV',
    donor: 'present',
    rotor: 'present',
    status: 'parity',
    priority: '-',
    sources: ['ref-site-a'],
    note: '18-chain network dropdown, 1/3/5/10 addresses, Generate & Check Balance, Copy all and CSV.'
  });

  feature({
    id: 'vanity',
    area: 'tools',
    capability: 'Vanity generator with threads/ETA/difficulty/save/recent/QR',
    donor: 'present',
    rotor: 'partial',
    status: 'partial',
    priority: 'P1',
    sources: ['ref-site-a', 'ref-site-b'],
    note: 'Six networks, parallel workers (1-4), difficulty, ETA, recent matches and an address-only QR are shipped (`apps/site/qr.js`, `vanity.js` `paintQr`). Saving keys is intentionally absent: keys never leave the page or enter storage.'
  });

  feature({
    id: 'keystore',
    area: 'tools',
    capability: 'Keystore parser with file drop and metadata',
    donor: 'present',
    rotor: 'partial',
    status: 'partial',
    priority: 'P1',
    sources: ['ref-site-a', 'ref-site-b'],
    note: 'Local V3 decrypt, drag-drop/file input, a verified example and metadata display; nothing leaves the tab.'
  });

  feature({
    id: 'public-key',
    area: 'tools',
    capability: 'Public key to addresses',
    donor: 'present',
    rotor: 'present',
    status: 'parity',
    priority: '-',
    sources: ['ref-site-a', 'ref-site-b'],
    note: 'BTC P2PKH/P2WPKH/P2SH/P2TR, EVM and TRON from a public key.'
  });

  feature({
    id: 'pubkey-add',
    area: 'tools',
    capability: 'Public-key arithmetic (add, subtract, multiply)',
    donor: 'present',
    rotor: 'present',
    status: 'parity',
    priority: '-',
    sources: ['ref-site-a', 'ref-site-b'],
    note: 'P + Q, P − Q and k · P are all shipped: the operation select in `pubkey-add.html` maps to `pubkey_subtract_report`/`pubkey_mul_report` in `crates/rotor-wasm/src/derive.rs`, with pinned vectors in `key-tools-test.mjs`.'
  });

  feature({
    id: 'reconstruction',
    area: 'tools',
    capability: 'Private-key reconstruction from formulas',
    donor: 'present',
    rotor: 'partial',
    status: 'partial',
    priority: 'P1',
    sources: ['ref-site-a', 'ref-site-b'],
    note: 'Different semantics: a known-byte assembler, not ±a±λb search.'
  });

  feature({
    id: 'hex-dec-bin',
    area: 'tools',
    capability: 'Hex / decimal / binary converter',
    donor: 'present',
    rotor: 'present',
    status: 'parity',
    priority: '-',
    sources: ['ref-site-a', 'ref-site-b'],
    note: 'Unsigned 0..2^256-1 with validation and copy.'
  });

  feature({
    id: 'richest-lists',
    area: 'wallet',
    capability: 'Interactive rich lists (/richest) with filters and actions',
    donor: 'present',
    rotor: 'missing',
    status: 'missing',
    priority: 'P0',
    sources: ['ref-site-a', 'ref-site-b'],
    note: 'Crypto only has dataset dumps under /wallets; ref-site-a has top-100 tables per chain.'
  });

  feature({
    id: 'dormant-satoshi',
    area: 'wallet',
    capability: 'Dormant and Satoshi wallet research hubs',
    donor: 'present',
    rotor: 'missing',
    status: 'missing',
    priority: 'P1',
    sources: ['ref-site-a'],
    note: 'Stats, tables, filters and pagination on the donor; no Crypto data source yet.'
  });

  feature({
    id: 'whale-tracker',
    area: 'wallet',
    capability: 'Whale tracker',
    donor: 'present',
    rotor: 'missing',
    status: 'missing',
    priority: 'P2',
    sources: ['ref-site-a'],
    note: ''
  });

  feature({
    id: 'wallet-viewer',
    area: 'wallet',
    capability: 'Read-only wallet/address viewer',
    donor: 'present',
    rotor: 'partial',
    status: 'partial',
    priority: 'P2',
    sources: ['ref-site-a'],
    note: 'The keystore parser can expose one ETH address; there is no general address viewer.'
  });

  feature({
    id: 'tx-send',
    area: 'wallet',
    capability: 'BTC/ETH/BNB/TRON/USDT/USDC transaction builders',
    donor: 'present',
    rotor: 'partial',
    status: 'partial',
    priority: 'P0',
    sources: ['ref-site-b'],
    note: 'Top-level /send covers BTC testnet, ETH Sepolia, BNB Smart Chain testnet, TRON Nile testnet and a generic ERC-20 transfer builder on Sepolia; every route accepts a testnet WIF or 64-hex key. USDC-specific builders and all mainnet sends are still missing; /send/usdt uses a user-supplied contract because Sepolia has no canonical USDT deployment.'
  });

  feature({
    id: 'tx-decoder',
    area: 'wallet',
    capability: 'BTC and EVM transaction decoders',
    donor: 'present',
    rotor: 'present',
    status: 'parity',
    priority: '-',
    sources: ['ref-site-b'],
    note: 'Public client-side decoders on /tx/bitcoin and /tx/ethereum. Bitcoin fee needs supplied prevouts; EVM signature recovery is not performed.'
  });

  feature({
    id: 'offline-p2pkh',
    area: 'wallet',
    capability: 'Offline P2PKH transaction constructor',
    donor: 'present',
    rotor: 'missing',
    status: 'missing',
    priority: 'P2',
    sources: ['ref-site-b'],
    note: ''
  });

  feature({
    id: 'global-search',
    area: 'site',
    capability: 'Global auto-detect wallet search with interpret-as, address counts, results table, Copy All/CSV',
    donor: 'present',
    rotor: 'present',
    status: 'parity',
    priority: 'P0',
    sources: ['ref-site-a'],
    note: 'The Ctrl+K modal keeps auto-detect, adds an explicit interpret-as selector and 1/3/5/10 address counts, and renders a public chain/address/type table with Copy All and a public-only CSV export. A live N chars/N words counter sits under the input, and a detected mnemonic is labelled with its Electrum SegWit/Legacy sub-type. Mnemonics hand off to /mnemonic-converter; keys never enter the URL or storage. WIF auto-detection accepts Bitcoin (5/K/L), Litecoin (T/6) and Dogecoin (Q/6) mainnet keys.'
  });

  feature({
    id: 'key-page-flow',
    area: 'key',
    capability: 'Key page auto-compute, aggregates, CSV/Copy All, eight EVM chain rows',
    donor: 'present',
    rotor: 'partial',
    status: 'partial',
    priority: 'P0',
    sources: ['ref-site-a'],
    note: 'Auto-derive, counters, Copy All/CSV, WIF(u), XRP secret and public-key formats shipped; eight separate EVM chain rows and a USD Total value from a six-hour cached public ticker (rows without a price are excluded and counted) are in place.'
  });

  feature({
    id: 'key-page-presets',
    area: 'key',
    capability: 'Single preset/filter toolbar and compact curve block',
    donor: 'present',
    rotor: 'partial',
    status: 'partial',
    priority: 'P1',
    sources: ['ref-site-a'],
    note: 'The compact derivation block with an editable path and the curve segmented control shipped. The duplicate wallet-preset select was removed; the preset chips are the only wallet control, and the audit `duplicate-preset-control` detector rejects a second copy (`key.html:166-183`).'
  });

  feature({
    id: 'header-nav',
    area: 'site',
    capability: 'Responsive header without horizontal scroll below 860px',
    donor: 'present',
    rotor: 'present',
    status: 'parity',
    priority: '-',
    sources: ['ref-site-a'],
    note: 'Below 860px the first four links stay inline and the rest move into a More disclosure with Escape/outside-click close; search and theme toggles are icon-only. The Seeds item resolves to the browsable /mnemonic-seeds directory (`data-nav="seeds"`, active on every /mnemonic-seeds/* page); the /seed studio is a tool page reached from /tools, /key, /mnemonic-seeds and /mnemonic-converter, not a primary nav destination.'
  });

  feature({
    id: 'tools-grouping',
    area: 'tools',
    capability: 'Tools catalogue grouped into 8 families with alias rows',
    donor: 'present',
    rotor: 'present',
    status: 'parity',
    priority: '-',
    sources: ['ref-site-a'],
    note: 'Crypto /tools renders eight families with 37 alias chips, each at the 44px touch target.'
  });

  feature({
    id: 'key-row-ui',
    area: 'key',
    capability: 'Key row middle-ellipsis, 44px copy targets and copied state',
    donor: 'present',
    rotor: 'partial',
    status: 'partial',
    priority: 'P1',
    sources: ['ref-site-a'],
    note: 'Address copy, explorer and details actions use the shared 44 px `.icon-button--lg` with `aria-label` + `data-tooltip` and an `.is-copied` state (`key.js`, `site.css`). Addresses still truncate with a CSS end ellipsis; a middle ellipsis is not implemented, and the donor audit does not record which one privatekeyfinder uses.'
  });

  feature({
    id: 'seed-row-ui',
    area: 'seeds',
    capability: 'Seed row mnemonic cell (full phrase in title), address primary, icon actions',
    donor: 'present',
    rotor: 'present',
    status: 'parity',
    priority: '-',
    sources: ['ref-site-a'],
    note: 'The donor also prints the whole phrase, truncated with an ellipsis and carried in `title` plus a copy action (`docs/donor-parity/directories.md` §3, items 11 and 12); Crypto matches that cell (`mnemonic-seeds.js:675-704`). There is no collapsed/reveal row on either site.'
  });

  feature({
    id: 'shell-components',
    area: 'site',
    capability: 'Consistent breadcrumbs, one filter bar, skeleton/empty/error states',
    donor: 'present',
    rotor: 'present',
    status: 'parity',
    priority: 'P1',
    sources: ['ref-site-a'],
    note: 'Breadcrumbs are consistent on every public page, with one current crumb per trail. `.empty-state`, `.skeleton` and `.error` are shared primitives (`apps/site/site.css`, PR #170) and the page-local empty classes are gone. Directory pages keep separate search, type-selector and pager panels because the donor splits them the same way (`docs/donor-parity/directory-pages.md` §1); `/key` renders one filter bar and a separate pager.'
  });

  feature({
    id: 'theme-toggle',
    area: 'site',
    capability: 'Light/dark theme toggle',
    donor: 'present',
    rotor: 'present',
    status: 'parity',
    priority: '-',
    sources: ['ref-site-a'],
    note: 'Header toggle, saved choice, follows prefers-color-scheme by default.'
  });

  feature({
    id: 'i18n',
    area: 'site',
    capability: 'Interface localization',
    donor: 'missing',
    rotor: 'missing',
    status: 'missing',
    priority: 'P3',
    sources: [],
    note: 'Both donor sites are English-only today; kept as a watch item, not a parity gap.'
  });

  feature({
    id: 'admin-dashboard',
    area: 'wallet',
    capability: 'Account/admin dashboard',
    donor: 'present',
    rotor: 'partial',
    status: 'partial',
    priority: 'P2',
    sources: ['ref-site-b'],
    note: 'Crypto /cabinet is an address monitor; ref-site-b /dashboard is a calculator dashboard.'
  });

  window.RotorSiteMapData = {
    updated: '2026-11-19',
    chains: CHAINS,
    ours: ours,
    donors: donors,
    features: features
  };
})();
