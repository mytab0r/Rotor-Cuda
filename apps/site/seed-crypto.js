/* Seed studio cryptography: BIP39/BIP32 helpers, the Electrum standard/segwit
 * seed-version check, and the legacy 1626-word Electrum scheme.
 *
 * Pure helpers only: no DOM, no network, no storage. The legacy wordlist is
 * taken verbatim from Electrum's old_mnemonic.py (MIT, (c) 2011 Thomas Voegtlin).
 * The caller supplies a pubkey lookup so all curve work stays in the wasm core. */
(function (global) {
  'use strict';

  var OLD_WORDS = ["like","just","love","know","never","want","time","out","there","make","look","eye","down","only","think","heart","back","then","into","about","more","away","still","them","take","thing","even","through","long","always","world","too","friend","tell","try","hand","thought","over","here","other","need","smile","again","much","cry","been","night","ever","little","said","end","some","those","around","mind","people","girl","leave","dream","left","turn","myself","give","nothing","really","off","before","something","find","walk","wish","good","once","place","ask","stop","keep","watch","seem","everything","wait","got","yet","made","remember","start","alone","run","hope","maybe","believe","body","hate","after","close","talk","stand","own","each","hurt","help","home","god","soul","new","many","two","inside","should","true","first","fear","mean","better","play","another","gone","change","use","wonder","someone","hair","cold","open","best","any","behind","happen","water","dark","laugh","stay","forever","name","work","show","sky","break","came","deep","door","put","black","together","upon","happy","such","great","white","matter","fill","past","please","burn","cause","enough","touch","moment","soon","voice","scream","anything","stare","sound","red","everyone","hide","kiss","truth","death","beautiful","mine","blood","broken","very","pass","next","forget","tree","wrong","air","mother","understand","lip","hit","wall","memory","sleep","free","high","realize","school","might","skin","sweet","perfect","blue","kill","breath","dance","against","fly","between","grow","strong","under","listen","bring","sometimes","speak","pull","person","become","family","begin","ground","real","small","father","sure","feet","rest","young","finally","land","across","today","different","guy","line","fire","reason","reach","second","slowly","write","eat","smell","mouth","step","learn","three","floor","promise","breathe","darkness","push","earth","guess","save","song","above","along","both","color","house","almost","sorry","anymore","brother","okay","dear","game","fade","already","apart","warm","beauty","heard","notice","question","shine","began","piece","whole","shadow","secret","street","within","finger","point","morning","whisper","child","moon","green","story","glass","kid","silence","since","soft","yourself","empty","shall","angel","answer","baby","bright","dad","path","worry","hour","drop","follow","power","war","half","flow","heaven","act","chance","fact","least","tired","children","near","quite","afraid","rise","sea","taste","window","cover","nice","trust","lot","sad","cool","force","peace","return","blind","easy","ready","roll","rose","drive","held","music","beneath","hang","mom","paint","emotion","quiet","clear","cloud","few","pretty","bird","outside","paper","picture","front","rock","simple","anyone","meant","reality","road","sense","waste","bit","leaf","thank","happiness","meet","men","smoke","truly","decide","self","age","book","form","alive","carry","escape","damn","instead","able","ice","minute","throw","catch","leg","ring","course","goodbye","lead","poem","sick","corner","desire","known","problem","remind","shoulder","suppose","toward","wave","drink","jump","woman","pretend","sister","week","human","joy","crack","grey","pray","surprise","dry","knee","less","search","bleed","caught","clean","embrace","future","king","son","sorrow","chest","hug","remain","sat","worth","blow","daddy","final","parent","tight","also","create","lonely","safe","cross","dress","evil","silent","bone","fate","perhaps","anger","class","scar","snow","tiny","tonight","continue","control","dog","edge","mirror","month","suddenly","comfort","given","loud","quickly","gaze","plan","rush","stone","town","battle","ignore","spirit","stood","stupid","yours","brown","build","dust","hey","kept","pay","phone","twist","although","ball","beyond","hidden","nose","taken","fail","float","pure","somehow","wash","wrap","angry","cheek","creature","forgotten","heat","rip","single","space","special","weak","whatever","yell","anyway","blame","job","choose","country","curse","drift","echo","figure","grew","laughter","neck","suffer","worse","yeah","disappear","foot","forward","knife","mess","somewhere","stomach","storm","beg","idea","lift","offer","breeze","field","five","often","simply","stuck","win","allow","confuse","enjoy","except","flower","seek","strength","calm","grin","gun","heavy","hill","large","ocean","shoe","sigh","straight","summer","tongue","accept","crazy","everyday","exist","grass","mistake","sent","shut","surround","table","ache","brain","destroy","heal","nature","shout","sign","stain","choice","doubt","glance","glow","mountain","queen","stranger","throat","tomorrow","city","either","fish","flame","rather","shape","spin","spread","ash","distance","finish","image","imagine","important","nobody","shatter","warmth","became","feed","flesh","funny","lust","shirt","trouble","yellow","attention","bare","bite","money","protect","amaze","appear","born","choke","completely","daughter","fresh","friendship","gentle","probably","six","deserve","expect","grab","middle","nightmare","river","thousand","weight","worst","wound","barely","bottle","cream","regret","relationship","stick","test","crush","endless","fault","itself","rule","spill","art","circle","join","kick","mask","master","passion","quick","raise","smooth","unless","wander","actually","broke","chair","deal","favorite","gift","note","number","sweat","box","chill","clothes","lady","mark","park","poor","sadness","tie","animal","belong","brush","consume","dawn","forest","innocent","pen","pride","stream","thick","clay","complete","count","draw","faith","press","silver","struggle","surface","taught","teach","wet","bless","chase","climb","enter","letter","melt","metal","movie","stretch","swing","vision","wife","beside","crash","forgot","guide","haunt","joke","knock","plant","pour","prove","reveal","steal","stuff","trip","wood","wrist","bother","bottom","crawl","crowd","fix","forgive","frown","grace","loose","lucky","party","release","surely","survive","teacher","gently","grip","speed","suicide","travel","treat","vein","written","cage","chain","conversation","date","enemy","however","interest","million","page","pink","proud","sway","themselves","winter","church","cruel","cup","demon","experience","freedom","pair","pop","purpose","respect","shoot","softly","state","strange","bar","birth","curl","dirt","excuse","lord","lovely","monster","order","pack","pants","pool","scene","seven","shame","slide","ugly","among","blade","blonde","closet","creek","deny","drug","eternity","gain","grade","handle","key","linger","pale","prepare","swallow","swim","tremble","wheel","won","cast","cigarette","claim","college","direction","dirty","gather","ghost","hundred","loss","lung","orange","present","swear","swirl","twice","wild","bitter","blanket","doctor","everywhere","flash","grown","knowledge","numb","pressure","radio","repeat","ruin","spend","unknown","buy","clock","devil","early","false","fantasy","pound","precious","refuse","sheet","teeth","welcome","add","ahead","block","bury","caress","content","depth","despite","distant","marry","purple","threw","whenever","bomb","dull","easily","grasp","hospital","innocence","normal","receive","reply","rhyme","shade","someday","sword","toe","visit","asleep","bought","center","consider","flat","hero","history","ink","insane","muscle","mystery","pocket","reflection","shove","silently","smart","soldier","spot","stress","train","type","view","whether","bus","energy","explain","holy","hunger","inch","magic","mix","noise","nowhere","prayer","presence","shock","snap","spider","study","thunder","trail","admit","agree","bag","bang","bound","butterfly","cute","exactly","explode","familiar","fold","further","pierce","reflect","scent","selfish","sharp","sink","spring","stumble","universe","weep","women","wonderful","action","ancient","attempt","avoid","birthday","branch","chocolate","core","depress","drunk","especially","focus","fruit","honest","match","palm","perfectly","pillow","pity","poison","roar","shift","slightly","thump","truck","tune","twenty","unable","wipe","wrote","coat","constant","dinner","drove","egg","eternal","flight","flood","frame","freak","gasp","glad","hollow","motion","peer","plastic","root","screen","season","sting","strike","team","unlike","victim","volume","warn","weird","attack","await","awake","built","charm","crave","despair","fought","grant","grief","horse","limit","message","ripple","sanity","scatter","serve","split","string","trick","annoy","blur","boat","brave","clearly","cling","connect","fist","forth","imagination","iron","jock","judge","lesson","milk","misery","nail","naked","ourselves","poet","possible","princess","sail","size","snake","society","stroke","torture","toss","trace","wise","bloom","bullet","cell","check","cost","darling","during","footstep","fragile","hallway","hardly","horizon","invisible","journey","midnight","mud","nod","pause","relax","shiver","sudden","value","youth","abuse","admire","blink","breast","bruise","constantly","couple","creep","curve","difference","dumb","emptiness","gotta","honor","plain","planet","recall","rub","ship","slam","soar","somebody","tightly","weather","adore","approach","bond","bread","burst","candle","coffee","cousin","crime","desert","flutter","frozen","grand","heel","hello","language","level","movement","pleasure","powerful","random","rhythm","settle","silly","slap","sort","spoken","steel","threaten","tumble","upset","aside","awkward","bee","blank","board","button","card","carefully","complain","crap","deeply","discover","drag","dread","effort","entire","fairy","giant","gotten","greet","illusion","jeans","leap","liquid","march","mend","nervous","nine","replace","rope","spine","stole","terror","accident","apple","balance","boom","childhood","collect","demand","depression","eventually","faint","glare","goal","group","honey","kitchen","laid","limb","machine","mere","mold","murder","nerve","painful","poetry","prince","rabbit","shelter","shore","shower","soothe","stair","steady","sunlight","tangle","tease","treasure","uncle","begun","bliss","canvas","cheer","claw","clutch","commit","crimson","crystal","delight","doll","existence","express","fog","football","gay","goose","guard","hatred","illuminate","mass","math","mourn","rich","rough","skip","stir","student","style","support","thorn","tough","yard","yearn","yesterday","advice","appreciate","autumn","bank","beam","bowl","capture","carve","collapse","confusion","creation","dove","feather","girlfriend","glory","government","harsh","hop","inner","loser","moonlight","neighbor","neither","peach","pig","praise","screw","shield","shimmer","sneak","stab","subject","throughout","thrown","tower","twirl","wow","army","arrive","bathroom","bump","cease","cookie","couch","courage","dim","guilt","howl","hum","husband","insult","led","lunch","mock","mostly","natural","nearly","needle","nerd","peaceful","perfection","pile","price","remove","roam","sanctuary","serious","shiny","shook","sob","stolen","tap","vain","void","warrior","wrinkle","affection","apologize","blossom","bounce","bridge","cheap","crumble","decision","descend","desperately","dig","dot","flip","frighten","heartbeat","huge","lazy","lick","odd","opinion","process","puzzle","quietly","retreat","score","sentence","separate","situation","skill","soak","square","stray","taint","task","tide","underneath","veil","whistle","anywhere","bedroom","bid","bloody","burden","careful","compare","concern","curtain","decay","defeat","describe","double","dreamer","driver","dwell","evening","flare","flicker","grandma","guitar","harm","horrible","hungry","indeed","lace","melody","monkey","nation","object","obviously","rainbow","salt","scratch","shown","shy","stage","stun","third","tickle","useless","weakness","worship","worthless","afternoon","beard","boyfriend","bubble","busy","certain","chin","concrete","desk","diamond","doom","drawn","due","felicity","freeze","frost","garden","glide","harmony","hopefully","hunt","jealous","lightning","mama","mercy","peel","physical","position","pulse","punch","quit","rant","respond","salty","sane","satisfy","savior","sheep","slept","social","sport","tuck","utter","valley","wolf","aim","alas","alter","arrow","awaken","beaten","belief","brand","ceiling","cheese","clue","confidence","connection","daily","disguise","eager","erase","essence","everytime","expression","fan","flag","flirt","foul","fur","giggle","glorious","ignorance","law","lifeless","measure","mighty","muse","north","opposite","paradise","patience","patient","pencil","petal","plate","ponder","possibly","practice","slice","spell","stock","strife","strip","suffocate","suit","tender","tool","trade","velvet","verse","waist","witch","aunt","bench","bold","cap","certainly","click","companion","creator","dart","delicate","determine","dish","dragon","drama","drum","dude","everybody","feast","forehead","former","fright","fully","gas","hook","hurl","invite","juice","manage","moral","possess","raw","rebel","royal","scale","scary","several","slight","stubborn","swell","talent","tea","terrible","thread","torment","trickle","usually","vast","violence","weave","acid","agony","ashamed","awe","belly","blend","blush","character","cheat","common","company","coward","creak","danger","deadly","defense","define","depend","desperate","destination","dew","duck","dusty","embarrass","engine","example","explore","foe","freely","frustrate","generation","glove","guilty","health","hurry","idiot","impossible","inhale","jaw","kingdom","mention","mist","moan","mumble","mutter","observe","ode","pathetic","pattern","pie","prefer","puff","rape","rare","revenge","rude","scrape","spiral","squeeze","strain","sunset","suspend","sympathy","thigh","throne","total","unseen","weapon","weary"];
  var OLD_INDEX = Object.create(null);
  for (var wi = 0; wi < OLD_WORDS.length; wi += 1) OLD_INDEX[OLD_WORDS[wi]] = wi;
  var OLD_N = OLD_WORDS.length;

  var CURVE_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
  var HARDENED = 0x80000000;
  var ENCODER = new TextEncoder();
  var DECODER = new TextDecoder('utf-8');

  /* ---------------------------------------------------------------- bytes */

  function utf8(text) {
    return ENCODER.encode(String(text));
  }

  function bytesToHex(bytes) {
    var out = '';
    for (var i = 0; i < bytes.length; i += 1) {
      out += bytes[i].toString(16).padStart(2, '0');
    }
    return out;
  }

  function hexToBytes(hex) {
    var value = String(hex || '');
    if (value.length % 2 !== 0 || !/^[0-9a-f]*$/i.test(value)) {
      throw new Error('Expected an even-length hexadecimal value.');
    }
    var out = new Uint8Array(value.length / 2);
    for (var i = 0; i < out.length; i += 1) {
      out[i] = parseInt(value.substr(i * 2, 2), 16);
    }
    return out;
  }

  function concatBytes(a, b) {
    var out = new Uint8Array(a.length + b.length);
    out.set(a, 0);
    out.set(b, a.length);
    return out;
  }

  function writeU32BE(target, offset, value) {
    target[offset] = (value >>> 24) & 0xff;
    target[offset + 1] = (value >>> 16) & 0xff;
    target[offset + 2] = (value >>> 8) & 0xff;
    target[offset + 3] = value & 0xff;
  }

  function scalarHex(value) {
    return value.toString(16).padStart(64, '0');
  }

  /* --------------------------------------------------------------- sha256 */

  var SHA256_K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
  ]);

  function rotr(value, bits) {
    return (value >>> bits) | (value << (32 - bits));
  }

  function sha256(bytes) {
    var initial = new Uint32Array([
      0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
      0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
    ]);
    var length = bytes.length;
    var bitLength = length * 8;
    var paddedLength = ((length + 9 + 63) >> 6) << 6;
    var padded = new Uint8Array(paddedLength);
    padded.set(bytes, 0);
    padded[length] = 0x80;
    var view = new DataView(padded.buffer);
    view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x100000000));
    view.setUint32(paddedLength - 4, bitLength >>> 0);

    var w = new Uint32Array(64);
    for (var offset = 0; offset < paddedLength; offset += 64) {
      for (var i = 0; i < 16; i += 1) w[i] = view.getUint32(offset + i * 4);
      for (i = 16; i < 64; i += 1) {
        var s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
        var s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
        w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
      }
      var a = initial[0], b = initial[1], c = initial[2], d = initial[3];
      var e = initial[4], f = initial[5], g = initial[6], h = initial[7];
      for (i = 0; i < 64; i += 1) {
        var bigS1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
        var ch = (e & f) ^ (~e & g);
        var temp1 = (h + bigS1 + ch + SHA256_K[i] + w[i]) >>> 0;
        var bigS0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
        var maj = (a & b) ^ (a & c) ^ (b & c);
        var temp2 = (bigS0 + maj) >>> 0;
        h = g; g = f; f = e; e = (d + temp1) >>> 0;
        d = c; c = b; b = a; a = (temp1 + temp2) >>> 0;
      }
      initial[0] = (initial[0] + a) >>> 0;
      initial[1] = (initial[1] + b) >>> 0;
      initial[2] = (initial[2] + c) >>> 0;
      initial[3] = (initial[3] + d) >>> 0;
      initial[4] = (initial[4] + e) >>> 0;
      initial[5] = (initial[5] + f) >>> 0;
      initial[6] = (initial[6] + g) >>> 0;
      initial[7] = (initial[7] + h) >>> 0;
    }

    var out = new Uint8Array(32);
    var outView = new DataView(out.buffer);
    for (i = 0; i < 8; i += 1) outView.setUint32(i * 4, initial[i]);
    return out;
  }

  function sha256d(bytes) {
    return sha256(sha256(bytes));
  }

  /* ---------------------------------------------------------- web crypto */

  async function hmacSha512(keyBytes, dataBytes) {
    if (!global.crypto || !global.crypto.subtle) {
      throw new Error('Electrum seed handling needs Web Crypto (HTTPS or localhost).');
    }
    var key = await global.crypto.subtle.importKey(
      'raw', keyBytes, { name: 'HMAC', hash: 'SHA-512' }, false, ['sign']
    );
    return new Uint8Array(await global.crypto.subtle.sign('HMAC', key, dataBytes));
  }

  async function pbkdf2Sha512(passwordBytes, saltBytes, iterations, length) {
    if (!global.crypto || !global.crypto.subtle) {
      throw new Error('Seed derivation needs Web Crypto (HTTPS or localhost).');
    }
    var key = await global.crypto.subtle.importKey(
      'raw', passwordBytes, { name: 'PBKDF2' }, false, ['deriveBits']
    );
    var bits = await global.crypto.subtle.deriveBits(
      { name: 'PBKDF2', salt: saltBytes, iterations: iterations, hash: 'SHA-512' },
      key,
      length * 8
    );
    return new Uint8Array(bits);
  }

  /* ---------------------------------------------------------- normalizing */

  function normalizeBip39(text) {
    return String(text == null ? '' : text).normalize('NFKD');
  }

  function normalizeElectrum(text) {
    var value = String(text == null ? '' : text).normalize('NFKD').toLowerCase();
    value = value.replace(new RegExp('[' + String.fromCharCode(0x300) + '-' + String.fromCharCode(0x36f) + ']', 'g'), '');
    return value.trim().split(/\s+/).join(' ');
  }

  /* ---------------------------------------------------------- master seeds */

  async function bip39Seed(phrase, passphrase) {
    return pbkdf2Sha512(
      utf8(normalizeBip39(phrase)),
      utf8('mnemonic' + normalizeBip39(passphrase)),
      2048,
      64
    );
  }

  async function electrumSeed(phrase, passphrase) {
    var words = normalizeElectrum(phrase);
    var extension = normalizeElectrum(passphrase);
    return pbkdf2Sha512(
      utf8(words),
      utf8('electrum' + extension),
      2048,
      64
    );
  }

  async function electrumSeedType(phrase) {
    var words = normalizeElectrum(phrase);
    var mac = bytesToHex(await hmacSha512(utf8('Seed version'), utf8(words)));
    if (mac.slice(0, 3) === '100') return 'segwit';
    if (mac.slice(0, 3) === '101') return '2fa';
    if (mac.slice(0, 3) === '102') return '2fa_segwit';
    if (mac.slice(0, 2) === '01') return 'standard';
    return '';
  }

  /* --------------------------------------------------------------- bip32 */

  function parsePath(text) {
    var value = String(text || '').trim();
    if (!/^[mM](?:\/\d+['hH]?)*$/.test(value)) {
      throw new Error("Path must look like m/44'/0'/0'/0/0.");
    }
    if (value === 'm' || value === 'M') return [];
    return value.slice(2).split('/').map(function (part) {
      var hardened = /['hH]$/.test(part);
      var digits = hardened ? part.slice(0, -1) : part;
      var index = Number(digits);
      if (!Number.isSafeInteger(index) || index >= HARDENED) {
        throw new Error('Invalid path index: ' + part);
      }
      return { index: index, hardened: hardened };
    });
  }

  /* Derive one secp256k1 key. `pubkeyFor` returns a compressed pubkey Uint8Array
   * for a 32-byte private key; the caller backs it with the wasm core. */
  async function bip32PrivateKey(seedBytes, pathText, pubkeyFor) {
    var segments = parsePath(pathText);
    var master = await hmacSha512(utf8('Bitcoin seed'), seedBytes);
    var key = master.slice(0, 32);
    var chain = master.slice(32);
    for (var i = 0; i < segments.length; i += 1) {
      var segment = segments[i];
      var index = segment.index + (segment.hardened ? HARDENED : 0);
      var data = new Uint8Array(37);
      if (segment.hardened) {
        data[0] = 0;
        data.set(key, 1);
      } else {
        var pubkey = await pubkeyFor(bytesToHex(key));
        if (!pubkey || pubkey.length !== 33) throw new Error('BIP32 needs a compressed public key.');
        data.set(pubkey, 0);
      }
      writeU32BE(data, 33, index);
      var child = await hmacSha512(chain, data);
      var left = BigInt('0x' + bytesToHex(child.slice(0, 32)));
      var current = BigInt('0x' + bytesToHex(key));
      if (left >= CURVE_N) {
        throw new Error('This BIP32 path produces an invalid child key. Use another path.');
      }
      var next = (left + current) % CURVE_N;
      if (next === 0n) {
        throw new Error('This BIP32 path produces an invalid zero child key. Use another path.');
      }
      key = hexToBytes(scalarHex(next));
      chain = child.slice(32);
    }
    return bytesToHex(key);
  }

  /* --------------------------------------------------------- electrum old */

  function oldDecode(words) {
    var list = Array.isArray(words)
      ? words.map(function (word) { return String(word).toLowerCase(); })
      : normalizeElectrum(words).split(' ').filter(Boolean);
    if (!list.length || list.length % 3 !== 0) {
      throw new Error('An Electrum old phrase has 12 or 24 words.');
    }
    var out = '';
    for (var i = 0; i < list.length; i += 3) {
      var w1 = OLD_INDEX[list[i]];
      var w2 = OLD_INDEX[list[i + 1]];
      var w3 = OLD_INDEX[list[i + 2]];
      if (w1 === undefined) throw new Error('Unknown Electrum old word: "' + list[i] + '".');
      if (w2 === undefined) throw new Error('Unknown Electrum old word: "' + list[i + 1] + '".');
      if (w3 === undefined) throw new Error('Unknown Electrum old word: "' + list[i + 2] + '".');
      var x = w1 + OLD_N * ((w2 - w1 + OLD_N) % OLD_N) + OLD_N * OLD_N * ((w3 - w2 + OLD_N) % OLD_N);
      if (x > 0xffffffff) {
        throw new Error('That Electrum old phrase does not decode to a canonical seed.');
      }
      out += x.toString(16).padStart(8, '0');
    }
    return out;
  }

  function oldEncode(hex) {
    var value = String(hex || '').toLowerCase();
    if (!value || value.length % 8 !== 0 || !/^[0-9a-f]+$/.test(value)) {
      throw new Error('An Electrum old seed is hexadecimal with a multiple of eight characters.');
    }
    var words = [];
    for (var i = 0; i < value.length; i += 8) {
      var x = parseInt(value.slice(i, i + 8), 16);
      var w1 = x % OLD_N;
      var w2 = (Math.floor(x / OLD_N) + w1) % OLD_N;
      var w3 = (Math.floor(x / OLD_N / OLD_N) + w2) % OLD_N;
      words.push(OLD_WORDS[w1], OLD_WORDS[w2], OLD_WORDS[w3]);
    }
    return words.join(' ');
  }

  function validateOld(phrase) {
    var words = normalizeElectrum(phrase).split(' ').filter(Boolean);
    if (words.length !== 12 && words.length !== 24) {
      throw new Error('Electrum old phrases use 12 or 24 words; this one has ' + words.length + '.');
    }
    var seedHex = oldDecode(words);
    if (seedHex.length !== (words.length / 3) * 8) {
      throw new Error('That Electrum old phrase does not decode to a stable seed.');
    }
    return { words: words, seedHex: seedHex };
  }

  function oldStretchedKey(seedHex) {
    /* Electrum stretches the ASCII hex string, not the decoded seed bytes:
     * encoded_hex_seed = hex_seed.encode('ascii'); x = encoded_hex_seed;
     * repeat sha256(x + encoded_hex_seed) 100,000 times. */
    var seed = utf8(String(seedHex || '').toLowerCase());
    if (!seed.length || !/^[0-9a-f]+$/.test(String(seedHex || '').toLowerCase())) {
      throw new Error('The Electrum old seed is not a hexadecimal string.');
    }
    var value = seed;
    for (var i = 0; i < 100000; i += 1) {
      value = sha256(concatBytes(value, seed));
    }
    var stretched = bytesToHex(value);
    var scalar = BigInt('0x' + stretched);
    if (scalar === 0n || scalar >= CURVE_N) {
      throw new Error('The stretched Electrum old key is outside the curve order.');
    }
    return stretched;
  }

  /* Legacy Electrum addresses: master public key plus the per-index sequence
   * from Electrum's old_mnemonic/Old_KeyStore scheme. Returns private keys. */
  async function oldPrivateKeys(seedHex, count, pubkeyFor) {
    var stretched = oldStretchedKey(seedHex);
    var report = await pubkeyFor(stretched);
    var uncompressed = report && (report.pubkey_uncompressed || report);
    if (typeof uncompressed !== 'string' || uncompressed.length !== 130) {
      throw new Error('The wasm core did not return the Electrum master public key.');
    }
    var mpk = hexToBytes(uncompressed.slice(2));
    var master = BigInt('0x' + stretched);
    var keys = [];
    for (var index = 0; index < count; index += 1) {
      var sequence = sha256d(concatBytes(utf8(index + ':0:'), mpk));
      var tweak = BigInt('0x' + bytesToHex(sequence));
      var key = (master + tweak) % CURVE_N;
      if (key === 0n) throw new Error('Electrum old address ' + index + ' is invalid.');
      keys.push(scalarHex(key));
    }
    return { stretched: stretched, masterPublicKey: uncompressed, keys: keys };
  }

  /* ------------------------------------------------------------ generating */

  function generateOld(wordCount) {
    var bytes = wordCount === 24 ? 32 : 16;
    if (wordCount !== 12 && wordCount !== 24) {
      throw new Error('Electrum old phrases use 12 or 24 words.');
    }
    var random = new Uint8Array(bytes);
    global.crypto.getRandomValues(random);
    return oldEncode(bytesToHex(random));
  }

  function entropyBytesForWords(wordCount) {
    var bits = { 12: 128, 15: 160, 18: 192, 21: 224, 24: 256 }[wordCount];
    if (!bits) throw new Error('Use 12, 15, 18, 21 or 24 words.');
    return bits / 8;
  }

  function generateBip39(wordCount) {
    if (!global.RotorSeed) throw new Error('The seed library did not load.');
    var random = new Uint8Array(entropyBytesForWords(wordCount));
    global.crypto.getRandomValues(random);
    return global.RotorSeed.entropyToMnemonic(bytesToHex(random));
  }

  /* Brute-force a BIP39-word phrase whose Electrum seed version is standard. */
  async function generateElectrumBip39(wordCount) {
    if (!global.RotorSeed) throw new Error('The seed library did not load.');
    entropyBytesForWords(wordCount);
    for (var attempt = 0; attempt < 20000; attempt += 1) {
      var phrase = generateBip39(wordCount);
      if (await electrumSeedType(phrase) === 'standard') return phrase;
    }
    throw new Error('Could not generate an Electrum seed version in time. Paste a phrase instead.');
  }

  function bip39Words() {
    if (!global.RotorSeed || !Array.isArray(global.RotorSeed.wordlist)) {
      throw new Error('The BIP39 wordlist did not load. Reload the page.');
    }
    return global.RotorSeed.wordlist;
  }

  var api = {
    CURVE_N: CURVE_N,
    OLD_WORDS: OLD_WORDS,
    sha256: sha256,
    sha256d: sha256d,
    bytesToHex: bytesToHex,
    hexToBytes: hexToBytes,
    utf8: utf8,
    normalizeBip39: normalizeBip39,
    normalizeElectrum: normalizeElectrum,
    hmacSha512: hmacSha512,
    pbkdf2Sha512: pbkdf2Sha512,
    bip39Seed: bip39Seed,
    electrumSeed: electrumSeed,
    electrumSeedType: electrumSeedType,
    parsePath: parsePath,
    bip32PrivateKey: bip32PrivateKey,
    oldDecode: oldDecode,
    oldEncode: oldEncode,
    validateOld: validateOld,
    oldStretchedKey: oldStretchedKey,
    oldPrivateKeys: oldPrivateKeys,
    generateOld: generateOld,
    generateBip39: generateBip39,
    generateElectrumBip39: generateElectrumBip39,
    entropyBytesForWords: entropyBytesForWords,
    bip39Words: bip39Words
  };

  global.RotorSeedCrypto = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
