/* Single source of truth for /site-map.
 *
 * Update this file when a route or a capability lands; the page only renders
 * this data. Donor routes were read from
 * https://privatekeyfinder.io/sitemap.xml and the secretscan.org navigation on
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
      status: 'partial',
      priority: 'P1',
      donorIds: ['pkf:/private-keys/' + item[0]],
      note: 'Missing CSV export and balance sorting; fewer address types on BCH/TON/DOGE/ZEC. The donor also has BTC 4 and LTC 3 types.'
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
    note: 'Local derivation and explorer links are present. Missing donor auto-compute with HEX/Decimal/WIF/WIF(u)/Keypair(SOL)/Secret(XRP)/PubKey formats, the Chain/Type/Address/Status table, eight EVM chain rows, Total Value/Has Balance/Active/Checked aggregates, CSV and Copy All.'
  });

  oursRoute({
    path: '/key/hex',
    title: 'Hex key calculator',
    area: 'key',
    status: 'partial',
    priority: 'P0',
    donorIds: ['pkf:/key/<hex|wif|decimal>', 'ss:/PrivateKeyHex'],
    note: '64 hexadecimal characters to WIF, public key and addresses.'
  });

  oursRoute({
    path: '/key/wif',
    title: 'WIF calculator',
    area: 'key',
    status: 'partial',
    priority: 'P0',
    donorIds: ['pkf:/key/<hex|wif|decimal>', 'ss:/PrivateKeyWif', 'ss:/PrivateKey_wif_to_hex'],
    note: 'Wallet Import Format from 5…, K… or L… to hex and addresses.'
  });

  oursRoute({
    path: '/key/decimal',
    title: 'Decimal key calculator',
    area: 'key',
    status: 'partial',
    priority: 'P0',
    donorIds: ['pkf:/key/<hex|wif|decimal>'],
    note: 'A decimal integer below the curve order to hex, WIF and addresses.'
  });

  oursRoute({
    path: '/mnemonic-seeds',
    title: 'Mnemonic seeds directory',
    area: 'seeds',
    status: 'partial',
    priority: 'P0',
    donorIds: ['pkf:/mnemonic-seeds'],
    note: '60 seed rows per page with paths, address types and balances. Rows do not show the private key or WIF with a copy action; TON is an explicit unsupported state.'
  });

  CHAINS.forEach(function (item) {
    oursRoute({
      path: '/mnemonic-seeds/' + item[0],
      title: item[1] + ' mnemonic seeds',
      area: 'seeds',
      status: 'partial',
      priority: 'P0',
      donorIds: ['pkf:/mnemonic-seeds/' + item[0]],
      note: 'Rows need the private key/WIF with a copy action. ' +
        (item[0] === 'ton'
          ? 'TON derivation is an explicit unsupported state.'
          : 'Balances and the pager are present.')
    });
  });

  oursRoute({
    path: '/seed',
    title: 'Seed studio',
    area: 'seeds',
    status: 'ours-only',
    priority: '-',
    donorIds: [],
    note: 'BIP39 entropy 12/15/18/21/24 plus Electrum old and Electrum BIP39, passphrase, paths and address counts. The donor has no equivalent studio.'
  });

  oursRoute({
    path: '/mnemonic-converter',
    title: 'Mnemonic converter',
    area: 'seeds',
    status: 'partial',
    priority: 'P1',
    donorIds: ['pkf:/mnemonic-converter'],
    note: 'Missing the donor word counter, 20-address option, “Load next 5”, Copy All, Received/Active aggregates, hardened checkbox and breadcrumbs.'
  });

  oursRoute({
    path: '/bitcoin-puzzle',
    title: 'Bitcoin puzzle index',
    area: 'puzzle',
    status: 'partial',
    priority: 'P0',
    donorIds: ['pkf:/bitcoin-puzzle', 'ss:/bitcoin-puzzle'],
    note: 'Missing the 160-puzzle table, All/Solved/Unsolved filters, search, Balance/TX/Actions columns and the BTC stats strip.'
  });

  oursRoute({
    path: '/bitcoin-puzzle/<n>/detail',
    href: '/bitcoin-puzzle/71/detail',
    title: 'Puzzle detail',
    area: 'puzzle',
    status: 'partial',
    priority: 'P1',
    donorIds: ['pkf:/bitcoin-puzzle/<n>/detail'],
    note: 'Missing copy actions for target/range, Difficulty/TX, decimal key space, the /private-keys cross-link and the 1–160 grid.'
  });

  oursRoute({
    path: '/bitcoin-puzzle/<n>/random',
    href: '/bitcoin-puzzle/71/random',
    title: 'Puzzle random keys',
    area: 'puzzle',
    status: 'partial',
    priority: 'P0',
    donorIds: ['pkf:/bitcoin-puzzle/<n>/random'],
    note: 'Local WASM worker is present. Missing Community Hunt (hunters, keys remaining, %, team speed), the results table and the offline advice block.'
  });

  oursRoute({
    path: '/brainwallet',
    title: 'Brainwallet index',
    area: 'brainwallet',
    status: 'partial',
    priority: 'P0',
    donorIds: ['pkf:/brainwallet'],
    note: 'Rotor opens a calculator. The donor index has 18 chain tiles, an 18,890 counter and four explainer blocks.'
  });

  oursRoute({
    path: '/brainwallet/bitcoin',
    title: 'Bitcoin brainwallet',
    area: 'brainwallet',
    status: 'partial',
    priority: 'P0',
    donorIds: ['pkf:/brainwallet/bitcoin'],
    note: 'Calculator only. The donor lists 60 rows × 315 pages with async address/balance, two copy icons per row, four BTC address types and a Balance/Received/TX summary.'
  });

  oursRoute({
    path: '/brainwallet/ethereum',
    title: 'Ethereum brainwallet',
    area: 'brainwallet',
    status: 'partial',
    priority: 'P0',
    donorIds: ['pkf:/brainwallet/ethereum'],
    note: 'Calculator only. The donor has the same paginated address directory as Bitcoin.'
  });

  oursRoute({
    path: '/brainwallet-generator',
    title: 'Brainwallet generator',
    area: 'brainwallet',
    status: 'partial',
    priority: 'P1',
    donorIds: ['pkf:/brainwallet-generator'],
    note: 'Donor alias to the calculator. Missing the network dropdown, Generate & Check Balance, 1/3/5/10 counts, Copy All and CSV.'
  });

  oursRoute({
    path: '/tools',
    title: 'Tools index',
    area: 'tools',
    status: 'ours-only',
    priority: '-',
    donorIds: [],
    note: 'Rotor-wide calculator catalogue and per-chain generator entry points.'
  });

  oursRoute({
    path: '/vanity',
    title: 'Vanity generator',
    area: 'tools',
    status: 'partial',
    priority: 'P1',
    donorIds: ['pkf:/vanity-generator', 'ss:/vanity-generator'],
    note: 'Six networks. Missing donor threads, ETA, difficulty, save action, recent-10 list and QR.'
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
    note: 'P + Q only. The donor also offers subtraction and multiplication.'
  });

  oursRoute({
    path: '/reconstruction',
    title: 'Byte-fragment assembler',
    area: 'tools',
    status: 'partial',
    priority: 'P1',
    donorIds: ['pkf:/reconstruction', 'ss:/Reconstruction'],
    note: 'Different semantics: Rotor assembles known bytes at fixed offsets and never guesses. Donor reconstruction uses ±a±λb formulas.'
  });

  oursRoute({
    path: '/keystore-parser',
    title: 'Keystore parser',
    area: 'tools',
    status: 'partial',
    priority: 'P1',
    donorIds: ['pkf:/keystore-parser', 'ss:/keystore-parser'],
    note: 'Local V3 decrypt is present. Missing drag-and-drop file input, examples and metadata display.'
  });

  oursRoute({
    path: '/wallets',
    title: 'Wallet database storefront',
    area: 'wallet',
    status: 'ours-only',
    priority: '-',
    donorIds: ['ss:/wallets'],
    note: 'Rotor mirrors six Rich-Address-Wallet downloads through its origin. privatekeyfinder.io has no real catalogue (soft landing); secretscan.org shows a market/price table.'
  });

  oursRoute({
    path: '/cabinet/wallet',
    title: 'Cabinet wallet',
    area: 'wallet',
    status: 'ours-only',
    priority: '-',
    donorIds: [],
    note: 'Encrypted local vault and Sepolia review/confirm flow. No donor equivalent.'
  });

  oursRoute({
    path: '/cabinet',
    title: 'Cabinet',
    area: 'wallet',
    status: 'partial',
    priority: 'P2',
    donorIds: ['ss:/dashboard'],
    note: 'Address monitor and account workspace. secretscan.org /dashboard is a calculator dashboard, not the same product.'
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
      status: 'partial',
      ours: '/private-keys/' + item[0],
      note: (item[0] === 'zcash' || item[0] === 'zksync')
        ? 'Live on the donor but absent from its sitemap.'
        : ''
    });
  });

  donorRoute({
    source: 'pkf',
    path: '/key/<hex|wif|decimal>',
    href: '/key/0000000000000000000000000000000000000000000000000000000000000001',
    title: 'Key entity pages',
    area: 'key',
    status: 'partial',
    ours: '/key'
  });

  donorRoute({
    source: 'pkf',
    path: '/mnemonic-seeds',
    title: 'Mnemonic seeds directory',
    area: 'seeds',
    status: 'partial',
    ours: '/mnemonic-seeds'
  });

  CHAINS.forEach(function (item) {
    donorRoute({
      source: 'pkf',
      path: '/mnemonic-seeds/' + item[0],
      title: item[1] + ' mnemonic seeds',
      area: 'seeds',
      status: 'partial',
      ours: '/mnemonic-seeds/' + item[0]
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
    status: 'partial',
    ours: '/bitcoin-puzzle'
  });

  donorRoute({
    source: 'pkf',
    path: '/bitcoin-puzzle/<n>/detail',
    href: '/bitcoin-puzzle/71/detail',
    title: 'Puzzle detail',
    area: 'puzzle',
    status: 'partial',
    ours: '/bitcoin-puzzle/<n>/detail'
  });

  donorRoute({
    source: 'pkf',
    path: '/bitcoin-puzzle/<n>/random',
    href: '/bitcoin-puzzle/71/random',
    title: 'Puzzle random keys',
    area: 'puzzle',
    status: 'partial',
    ours: '/bitcoin-puzzle/<n>/random'
  });

  donorRoute({
    source: 'pkf',
    path: '/brainwallet',
    title: 'Brainwallet directory',
    area: 'brainwallet',
    status: 'partial',
    ours: '/brainwallet'
  });

  CHAINS.forEach(function (item) {
    var oursPath = item[0] === 'bitcoin' || item[0] === 'ethereum'
      ? '/brainwallet/' + item[0]
      : null;
    donorRoute({
      source: 'pkf',
      path: '/brainwallet/' + item[0],
      title: item[1] + ' brainwallets',
      area: 'brainwallet',
      status: oursPath ? 'partial' : 'missing',
      priority: 'P0',
      ours: oursPath,
      note: oursPath
        ? 'Rotor has a calculator, not the donor listing.'
        : 'No Rotor directory for this chain. Live on the donor but absent from its sitemap.'
    });
  });

  donorRoute({
    source: 'pkf',
    path: '/brainwallet-generator',
    title: 'Brainwallet generator',
    area: 'brainwallet',
    status: 'partial',
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
    note: 'Donor reconstructs from ±a±λb formulas; Rotor only assembles known bytes.'
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

  /* secretscan.org navigation, 2026-11-19. */
  [
    ['/PrivateKeyHex', 'Private key (HEX)', 'key', '/key/hex', 'partial', 'P0', 'Rotor lacks the donor aggregates and CSV/Copy All.'],
    ['/PrivateKeyWif', 'Private key (WIF)', 'key', '/key/wif', 'partial', 'P0', 'Rotor lacks the donor aggregates and CSV/Copy All.'],
    ['/PrivateKeyEth', 'Ethereum private key', 'key', '/key?chain=ethereum', 'partial', 'P0', 'Rotor collapses EVM rows to Ethereum instead of showing eight chains.'],
    ['/PrivateKeyTron', 'TRON private key', 'key', '/key?chain=tron', 'partial', 'P0', 'Rotor lacks the donor aggregates and CSV/Copy All.'],
    ['/PrivateKeySegwit', 'SegWit private key', 'key', '/key?chain=bitcoin&type=segwit', 'partial', 'P0', 'Rotor lacks the donor aggregates and CSV/Copy All.'],
    ['/PrivateKey_wif_to_hex', 'WIF to HEX', 'key', '/key/wif', 'partial', 'P0', 'Rotor lacks the donor aggregates and CSV/Copy All.'],
    ['/Bech32', 'Bech32 address calculator', 'key', '/key?chain=bitcoin&type=segwit', 'partial', 'P0', 'Rotor lacks the donor aggregates and CSV/Copy All.'],
    ['/PublicKey', 'Public key calculator', 'tools', '/public-key', 'parity', '-', ''],
    ['/PubkeyAdd', 'Add public keys', 'tools', '/pubkey-add', 'partial', 'P1', 'Rotor only adds (P + Q); the donor also subtracts and multiplies.'],
    ['/Reconstruction', 'Private key reconstruction', 'tools', '/reconstruction', 'partial', 'P1', 'Formula search vs a known-byte assembler.'],
    ['/HexDecBin', 'Hex / decimal / binary', 'tools', '/hex-dec-bin', 'parity', '-', ''],
    ['/Transaction_decoded_Bitcoin', 'Bitcoin transaction decoder', 'tools', null, 'missing', 'P0', 'Raw hex to inputs, outputs, scripts, fees and JSON.'],
    ['/decode_ethereum_transaction', 'Ethereum transaction decoder', 'tools', null, 'missing', 'P0', 'Raw hex to inputs, outputs, scripts, fees and JSON.'],
    ['/Easy_bitcoin_transaction_online', 'Bitcoin transaction builder', 'tools', null, 'missing', 'P0', 'Rotor only has the Sepolia flow inside /cabinet/wallet.'],
    ['/Easy_ethereum_transaction_online', 'Ethereum transaction builder', 'tools', null, 'missing', 'P0', 'Rotor only has the Sepolia flow inside /cabinet/wallet.'],
    ['/Easy_bnb_transaction_online', 'BNB transaction builder', 'tools', null, 'missing', 'P0', 'No BNB builder in Rotor.'],
    ['/Easy_tron_trx_transaction_online', 'TRON TRX transaction builder', 'tools', null, 'missing', 'P0', 'No TRON builder in Rotor.'],
    ['/Easy_usdt_erc20_transaction_online', 'USDT ERC20 transaction builder', 'tools', null, 'missing', 'P0', 'No USDT builder in Rotor.'],
    ['/wallets', 'Wallet market table', 'wallet', '/wallets', 'ours-only', '-', 'Rotor mirrors real dataset downloads; secretscan.org shows prices and terms.'],
    ['/richest', 'Rich lists', 'wallet', null, 'missing', 'P0', 'The secretscan.org nav link currently answers 404.'],
    ['/bitcoin-puzzle', 'Bitcoin puzzle', 'puzzle', '/bitcoin-puzzle', 'partial', 'P0', 'Rotor has a local worker but not the donor puzzle tables.'],
    ['/vanity-generator', 'Vanity generator', 'tools', '/vanity', 'partial', 'P1', 'Rotor lacks threads, ETA, difficulty, save/recent and QR.'],
    ['/keystore-parser', 'Keystore parser', 'tools', '/keystore-parser', 'partial', 'P1', 'Rotor lacks drag-and-drop, examples and metadata.'],
    ['/dashboard', 'Account dashboard', 'wallet', '/cabinet', 'partial', 'P2', 'Rotor /cabinet is an address monitor, not a calculator dashboard.'],
    ['/results', 'Scanner results', 'tools', null, 'missing', 'P2', 'No scanner in Rotor, so there is nothing honest to show.'],
    ['/scaner', 'Address scanner', 'tools', null, 'missing', 'P2', 'No fake progress: a real scanner is required first.'],
    ['/programs', 'Program catalogue', 'site', null, 'missing', 'P3', ''],
    ['/rent', 'Rental / paid compute', 'site', null, 'missing', 'P3', ''],
    ['/benchmark', 'Benchmark', 'tools', null, 'missing', 'P3', ''],
    ['/about', 'About', 'site', null, 'missing', 'P3', 'Rotor docs are not an about page.']
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
    sources: ['privatekeyfinder.io'],
    note: '60 rows per page with First/Previous/Random/Next/Last and a page jump.'
  });

  feature({
    id: 'key-balances',
    area: 'directory',
    capability: 'Per-row automatic balance checks',
    donor: 'present',
    rotor: 'present',
    status: 'parity',
    priority: '-',
    sources: ['privatekeyfinder.io'],
    note: 'Opt-in per row; only derived public addresses are queried.'
  });

  feature({
    id: 'key-types',
    area: 'directory',
    capability: 'Address-type tabs per chain',
    donor: 'present',
    rotor: 'partial',
    status: 'partial',
    priority: 'P1',
    sources: ['privatekeyfinder.io'],
    note: 'BTC and LTC have multi-type tabs. BCH, TON, DOGE and ZEC expose one type, while the donor also offers CashAddr+Legacy, v4R2+w5 and compressed+uncompressed forms.'
  });

  feature({
    id: 'key-wif-links',
    area: 'directory',
    capability: 'WIF links on Bitcoin rows',
    donor: 'present',
    rotor: 'present',
    status: 'parity',
    priority: '-',
    sources: ['privatekeyfinder.io'],
    note: 'BTC rows link to /key/<WIF>; details show compressed and uncompressed WIF.'
  });

  feature({
    id: 'key-csv-sort',
    area: 'directory',
    capability: 'Directory CSV export and sort by balance',
    donor: 'present',
    rotor: 'missing',
    status: 'missing',
    priority: 'P1',
    sources: ['privatekeyfinder.io'],
    note: 'Our /private-keys/<chain> derives, pages and filters, but cannot export or sort by balance.'
  });

  feature({
    id: 'seed-directory',
    area: 'seeds',
    capability: 'Seed directory with 60-row pages',
    donor: 'present',
    rotor: 'partial',
    status: 'partial',
    priority: 'P0',
    sources: ['privatekeyfinder.io'],
    note: 'Rows, pager, word counts, path, address types and balances exist; TON is unsupported.'
  });

  feature({
    id: 'seed-row-key',
    area: 'seeds',
    capability: 'Seed row private key/WIF and copy actions',
    donor: 'present',
    rotor: 'missing',
    status: 'missing',
    priority: 'P0',
    sources: ['privatekeyfinder.io'],
    note: 'The seed directory row shows the address but not the private key/WIF with a copy action.'
  });

  feature({
    id: 'seed-studio',
    area: 'seeds',
    capability: 'Seed studio: entropy, BIP39/Electrum, passphrase, paths',
    donor: 'partial',
    rotor: 'present',
    status: 'parity',
    priority: '-',
    sources: ['privatekeyfinder.io'],
    note: 'Rotor adds Electrum old and Electrum BIP39 and all BIP39 entropy lengths.'
  });

  feature({
    id: 'seed-converter',
    area: 'seeds',
    capability: 'Mnemonic converter: word counter, 20 addresses, Copy All, aggregates, hardened, breadcrumbs',
    donor: 'present',
    rotor: 'partial',
    status: 'partial',
    priority: 'P1',
    sources: ['privatekeyfinder.io'],
    note: 'Rotor has the conversion and up to 10 addresses, but not the full donor control set.'
  });

  feature({
    id: 'puzzle-home',
    area: 'puzzle',
    capability: 'Puzzle home: 160-table, All/Solved/Unsolved filters, search, stats',
    donor: 'present',
    rotor: 'missing',
    status: 'missing',
    priority: 'P0',
    sources: ['privatekeyfinder.io', 'secretscan.org'],
    note: 'Rotor has a puzzle worker entry, not the browsable 160-puzzle table.'
  });

  feature({
    id: 'puzzle-random',
    area: 'puzzle',
    capability: 'Puzzle random: Community Hunt, results table, offline advice',
    donor: 'present',
    rotor: 'partial',
    status: 'partial',
    priority: 'P0',
    sources: ['privatekeyfinder.io'],
    note: 'Local WASM start/stop/reset/check and match UI exist; community and results views do not.'
  });

  feature({
    id: 'puzzle-detail',
    area: 'puzzle',
    capability: 'Puzzle detail: copy target/range, difficulty/TX, decimal, grid',
    donor: 'present',
    rotor: 'partial',
    status: 'partial',
    priority: 'P1',
    sources: ['privatekeyfinder.io'],
    note: 'Balance, range, progress and explorer links exist; copy actions and metadata do not.'
  });

  feature({
    id: 'puzzle-worker',
    area: 'puzzle',
    capability: 'Browser WASM puzzle worker',
    donor: 'present',
    rotor: 'present',
    status: 'parity',
    priority: '-',
    sources: ['privatekeyfinder.io'],
    note: 'Solo Random/Solo Seq and a separate Team mode; no silent mix of local and lease work.'
  });

  feature({
    id: 'brainwallet-directory',
    area: 'brainwallet',
    capability: 'Brainwallet directory index',
    donor: 'present',
    rotor: 'missing',
    status: 'missing',
    priority: 'P0',
    sources: ['privatekeyfinder.io'],
    note: 'Donor has 18 chain tiles, a counter and explainer blocks; Rotor /brainwallet is a calculator.'
  });

  feature({
    id: 'brainwallet-calc',
    area: 'brainwallet',
    capability: 'Single brainwallet calculator',
    donor: 'present',
    rotor: 'present',
    status: 'parity',
    priority: '-',
    sources: ['privatekeyfinder.io'],
    note: 'Shared SHA-256 engine, BTC legacy/SegWit/Taproot or ETH rows, explorer links and copy.'
  });

  feature({
    id: 'brainwallet-chains',
    area: 'brainwallet',
    capability: 'Per-chain brainwallet listing pages (18 chains)',
    donor: 'present',
    rotor: 'missing',
    status: 'missing',
    priority: 'P0',
    sources: ['privatekeyfinder.io'],
    note: 'Donor lists 60 rows × 315 pages per chain; Rotor only has BTC/ETH calculators.'
  });

  feature({
    id: 'brainwallet-generator',
    area: 'brainwallet',
    capability: 'Brainwallet generator: network dropdown, counts, Copy All, CSV',
    donor: 'present',
    rotor: 'partial',
    status: 'partial',
    priority: 'P1',
    sources: ['privatekeyfinder.io'],
    note: 'Rotor has a fill-only random phrase, not the donor generator controls.'
  });

  feature({
    id: 'vanity',
    area: 'tools',
    capability: 'Vanity generator with threads/ETA/difficulty/save/recent/QR',
    donor: 'present',
    rotor: 'partial',
    status: 'partial',
    priority: 'P1',
    sources: ['privatekeyfinder.io', 'secretscan.org'],
    note: 'Rotor supports six networks and local prefix/suffix generation.'
  });

  feature({
    id: 'keystore',
    area: 'tools',
    capability: 'Keystore parser with file drop and metadata',
    donor: 'present',
    rotor: 'partial',
    status: 'partial',
    priority: 'P1',
    sources: ['privatekeyfinder.io', 'secretscan.org'],
    note: 'Local V3 decrypt works; file drop, examples and metadata display are missing.'
  });

  feature({
    id: 'public-key',
    area: 'tools',
    capability: 'Public key to addresses',
    donor: 'present',
    rotor: 'present',
    status: 'parity',
    priority: '-',
    sources: ['privatekeyfinder.io', 'secretscan.org'],
    note: 'BTC P2PKH/P2WPKH/P2SH/P2TR, EVM and TRON from a public key.'
  });

  feature({
    id: 'pubkey-add',
    area: 'tools',
    capability: 'Public-key arithmetic (add, subtract, multiply)',
    donor: 'present',
    rotor: 'partial',
    status: 'partial',
    priority: 'P1',
    sources: ['privatekeyfinder.io', 'secretscan.org'],
    note: 'Rotor implements P + Q only.'
  });

  feature({
    id: 'reconstruction',
    area: 'tools',
    capability: 'Private-key reconstruction from formulas',
    donor: 'present',
    rotor: 'partial',
    status: 'partial',
    priority: 'P1',
    sources: ['privatekeyfinder.io', 'secretscan.org'],
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
    sources: ['privatekeyfinder.io', 'secretscan.org'],
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
    sources: ['privatekeyfinder.io', 'secretscan.org'],
    note: 'Rotor only has dataset dumps under /wallets; privatekeyfinder.io has top-100 tables per chain.'
  });

  feature({
    id: 'dormant-satoshi',
    area: 'wallet',
    capability: 'Dormant and Satoshi wallet research hubs',
    donor: 'present',
    rotor: 'missing',
    status: 'missing',
    priority: 'P1',
    sources: ['privatekeyfinder.io'],
    note: 'Stats, tables, filters and pagination on the donor; no Rotor data source yet.'
  });

  feature({
    id: 'whale-tracker',
    area: 'wallet',
    capability: 'Whale tracker',
    donor: 'present',
    rotor: 'missing',
    status: 'missing',
    priority: 'P2',
    sources: ['privatekeyfinder.io'],
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
    sources: ['privatekeyfinder.io'],
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
    sources: ['secretscan.org'],
    note: 'Rotor only has the Sepolia review/confirm flow inside /cabinet/wallet; no mainnet or USDT builders.'
  });

  feature({
    id: 'tx-decoder',
    area: 'wallet',
    capability: 'BTC and EVM transaction decoders',
    donor: 'present',
    rotor: 'missing',
    status: 'missing',
    priority: 'P0',
    sources: ['secretscan.org'],
    note: 'Raw hex to inputs, outputs, scripts, fees and JSON is absent.'
  });

  feature({
    id: 'offline-p2pkh',
    area: 'wallet',
    capability: 'Offline P2PKH transaction constructor',
    donor: 'present',
    rotor: 'missing',
    status: 'missing',
    priority: 'P2',
    sources: ['secretscan.org'],
    note: ''
  });

  feature({
    id: 'global-search',
    area: 'site',
    capability: 'Global auto-detect wallet search with interpret-as, address counts, results table, Copy All/CSV',
    donor: 'present',
    rotor: 'partial',
    status: 'partial',
    priority: 'P0',
    sources: ['privatekeyfinder.io'],
    note: 'The Ctrl+K modal covers HEX, WIF, keypair, mnemonic and brainwallet and redirects to /key; it has no interpret-as selector, 1/3/5/10 address counts, results table, Copy All or CSV.'
  });

  feature({
    id: 'key-page-flow',
    area: 'key',
    capability: 'Key page auto-compute, aggregates, CSV/Copy All, eight EVM chain rows',
    donor: 'present',
    rotor: 'partial',
    status: 'partial',
    priority: 'P0',
    sources: ['privatekeyfinder.io'],
    note: 'Rotor still uses Calculate/±1/Generate/Clear buttons, collapses EVM to Ethereum and has no Total Value/Has Balance/Active/Checked aggregates.'
  });

  feature({
    id: 'key-page-presets',
    area: 'key',
    capability: 'Single preset/filter toolbar and compact curve block',
    donor: 'present',
    rotor: 'partial',
    status: 'partial',
    priority: 'P0',
    sources: ['privatekeyfinder.io'],
    note: 'Presets are duplicated between the toolbar select and the advanced block; the curve block should collapse into the path input. PR #67 is in progress.'
  });

  feature({
    id: 'header-nav',
    area: 'site',
    capability: 'Responsive header without horizontal scroll below 860px',
    donor: 'present',
    rotor: 'partial',
    status: 'partial',
    priority: 'P1',
    sources: ['privatekeyfinder.io'],
    note: 'The header scrolls horizontally instead of offering a hamburger/More menu.'
  });

  feature({
    id: 'tools-grouping',
    area: 'tools',
    capability: 'Tools catalogue grouped into 8 families with alias rows',
    donor: 'present',
    rotor: 'partial',
    status: 'partial',
    priority: 'P1',
    sources: ['privatekeyfinder.io'],
    note: 'Rotor /tools renders 26 flat cards; aliases and family grouping are missing.'
  });

  feature({
    id: 'key-row-ui',
    area: 'key',
    capability: 'Key row middle-ellipsis, 44px copy targets and copied state',
    donor: 'present',
    rotor: 'partial',
    status: 'partial',
    priority: 'P1',
    sources: ['privatekeyfinder.io'],
    note: ''
  });

  feature({
    id: 'seed-row-ui',
    area: 'seeds',
    capability: 'Seed row collapsed phrase, address primary, icon actions',
    donor: 'present',
    rotor: 'partial',
    status: 'partial',
    priority: 'P1',
    sources: ['privatekeyfinder.io'],
    note: ''
  });

  feature({
    id: 'shell-components',
    area: 'site',
    capability: 'Consistent breadcrumbs, one filter bar, skeleton/empty/error states',
    donor: 'present',
    rotor: 'partial',
    status: 'partial',
    priority: 'P1',
    sources: ['privatekeyfinder.io'],
    note: 'Breadcrumbs are inconsistent, pages can show three control panels, and skeleton/empty/error components are not shared.'
  });

  feature({
    id: 'theme-toggle',
    area: 'site',
    capability: 'Light/dark theme toggle',
    donor: 'present',
    rotor: 'present',
    status: 'parity',
    priority: '-',
    sources: ['privatekeyfinder.io'],
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
    sources: ['secretscan.org'],
    note: 'Rotor /cabinet is an address monitor; secretscan.org /dashboard is a calculator dashboard.'
  });

  window.RotorSiteMapData = {
    updated: '2026-11-19',
    chains: CHAINS,
    ours: ours,
    donors: donors,
    features: features
  };
})();
