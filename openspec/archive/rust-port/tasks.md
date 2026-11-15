# Tasks: Rust-порт CPU-части

## 0. Скелет  (blocked by: —)
- [x] `Cargo.toml`, `src/lib.rs`, `src/main.rs`, `src/cli.rs`; `cargo build` зелёный.
- [x] Парсер: точные токены, значение следующим аргументом, операнды, все флаги
      `Main.cpp:266-286`; `--help` дословно, `-v`, `-l`.
- [x] Ошибки парсинга: `  Error: <msg>`, код 1.
- [x] `Rotor-Cuda_START.bat` при старте, если `Rotor-Cuda_Continue.bat` пуст
      (`CmdParse.cpp:86-103`).

## 1. Крипто-ядро и самопроверка  (blocked by: 0)
- [x] `field.rs`: GF(p), p = 2^256−2^32−977; mul через 512-бит + pseudo-Mersenne fold,
      add/sub/neg/invert/sqrt/from_be/to_be.
- [x] `scalar.rs`: GF(n) — add/sub/mul/from_be/to_be/bit; скорость не критична.
- [x] `point.rs`: якобиевы точки, mixed add, double, `batch_to_affine` (одна инверсия).
- [x] `secp.rs`: G, `mul_g`, parse 02/03/04, compress/decompress, hash160, ETH-адрес.
- [x] `hashes.rs`: SHA-256, RIPEMD-160, Keccak-256.
- [x] `base58.rs`: Base58Check decode/encode, WIF decode/encode.
- [x] `selfcheck.rs`: `-c` с векторами из `SECP256k1.cpp:96-155` (генератор, double, add,
      GenKey `46b9e861…`, пары адрес/WIF), `Int`-вектор `3EF7CEF6…`.
- [x] `tests/crypto.rs`: векторы + свойства (kG+G=(k+1)G, batch==поштучно, sqrt,
      Base58/WIF roundtrip).

## 2. Вход и фильтры  (blocked by: 0)
- [x] Диапазоны уже разобраны в `cli.rs`; `bit_length`, hex-вывод и нарезка — в
      `engine.rs` (`Split`).
- [x] `filter.rs`: Bloom с параметрами libbloom и **MurmurHash2 32-bit** (`Bloom.cpp:256-301`);
      точная проверка по отсортированным записям.
- [x] Загрузка `.bin`: записи 20 (hash160/ETH) или 32 (xpoint) байта, без заголовка;
      длина не кратна записи → громкая ошибка.
- [x] Тест: `Others/Puzzles_1_37_ETH.bin` = 37 записей, false-negative = 0.
- BinaryFuse — сознательно отложен (результат не меняется: HashMap/точный поиск).

## 3. CPU-движок  (blocked by: 1, 2)
- [x] `engine.rs`: поток на поддиапазон (`diff=(end-start)/threads`), батч 2048 точек,
      одна batch-инверсия на батч, hash160, фильтр.
- [x] Режимы `address` и `addresses` (BTC), `-u/-b`.
- [x] `Found.txt`: `PubAddress` / `Priv (WIF)` / `Priv (HEX)` / `PubK (HEX)` / разделитель
      (`Rotor.cpp:352-367`); stdout-дубль с отступом.
- [x] Прогресс-строка (`Rotor.cpp:1846,1859`), `-t`, `-d`; Ctrl-C → корректный выход.
- [x] `-g` без GPU-feature: громкая ошибка и код ≠ 0 (осознанное отклонение от no-op).

## 4. Остальные режимы  (blocked by: 3)
- [x] `xpoint`/`xpoints` (сравнение X), ETH (`--coin eth`, keccak160).
- [x] `-r` random mode, `-n`/`-z` битовые диапазоны.

## 5. Чекпоинты  (blocked by: 3)
- [x] `-n` (минуты) → `Rotor-Cuda_Continue.bat`: `:loop` / командная строка / `goto :loop` /
      `created: <ctime>` / `<count>` / две строки-предупреждения (`Rotor.cpp:1606-1614`).
- [x] Возобновление: `count` прибавляется к стартовому ключу и счётчику (`Rotor.cpp:213-255`).
- [x] Чекпоинт только при `rkey == 0` и `next > 0`.

## 6. CPU-BSGS  (blocked by: 1, 2)
- [x] Baby table: `jG` для `j=1..m`, `m = isqrt(span+1)+1` при `m=0`; ключ —
      **FNV-1a/64 по 32-байтному big-endian X** (`BsgsCpu.cpp:19-23,85-96`);
      `HashMap<u64,u32>`; `table_checksum` — FNV-1a/64 по LE-байтам folds.
- [x] Giant walk: `R = target − kStart·G`, шаг `−m·G`, индексы `i=0..=span/m+1`;
      при совпадении fold — точная EC-перепроверка (`BsgsCpu.cpp:119-166`).
- [x] Полный 256-битный span; если `m > u32::MAX` — громкая ошибка (C++ молча
      берёт младшие 64 бита, `BsgsCpu.cpp:79-82`).
- [x] `TableManifest`: version=1, curve="secp256k1", baby_size, range_id, checksum;
      `compatible()` как в `BsgsCpu.h:21-33`.
- [x] Вывод: `GIANT STEPS/BABY SIZE`, `====> KEY FOUND: <hex>`, append
      `<pubkey> <hex>\n` в `-o`; не найдено → код 1.
- [x] Фикстуры из `bsgs_selftest.cpp`: база 1000, span 4095, auto-m и m=64,
      границы giant/baby, out-of-range reject, детерминизм, manifest reject.

## 7. Приёмка
- [x] `cargo test` + `cargo clippy -- -D warnings` + `cargo fmt --check`
      (в debug и release, 69 тестов).
- [x] `rotor -c` проходит; вывод повторяет шапку C++.
- [x] BSGS-паритет на фикстурах и на pubkey #71: ключ проверяется как `k·G == target`
      и адрес совпадает. Полный диапазон #71 (2^68, m≈2^34) для CPU-BSGS нереален —
      это ограничение алгоритма, не реализации; проверены диапазоны до 2^31.
- [x] Address-скан малого диапазона находит ключ, у которого hash160 совпадает с целью.
- [x] `.bin`-вход и `Found.txt` совместимы с C++-форматом (проверка по структуре).
- [x] GitHub Actions `rust.yml` добавлен (fmt/clippy/test на ubuntu и windows);
      локально workflow не запускался — нужен push.
- [x] README: сборка, отклонения, статус GPU/self-update/BinaryFuse.
- [x] Archive change, влить дельту в `openspec/specs/`.
