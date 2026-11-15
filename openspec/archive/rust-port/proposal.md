# Rust-порт Rotor-Cuda (CPU-часть)

## Goal

Переписать CPU-часть Rotor-Cuda на Rust, сохранив drop-in поведение CLI и файловых
форматов. CUDA-кернелы (`Rotor-Cuda/GPU/*.cu`, `bsgs/BsgsGpu.cu`) остаются на C++/CUDA
и подключаются отдельным feature-ом через `cudarc` в следующем change.

## Why

C++-ядро (≈10.8k строк CPU + 2.2k bsgs) собрано из трёх форков KeyHunt/VanitySearch/
Rotor, содержит мёртвые файлы (`sha256.cpp` в корне, `GPU/GPUGroup.h`), копии
`GPUHash - Copy*.h`, ручную 320-битную знаковую арифметику с UB-приведениями и
неинициализированными конструкторами. Rust даёт memory safety, единый пакетный
менеджер, нормальные тесты и переносимую сборку без MSBuild-патчей vcxproj.

## Scope

Входит:
- CLI (`-m address|addresses|xpoint|xpoints|bsgs`, `--range`, `--coin`, `-i/-o`,
  `-t`, `-r`, `-n`, `-z`, `-d`, `-u/-b`, `-l`, `-g/--gpui/--gpux` — `-g` принимается и
  явно сообщает, что GPU-бэкенд не собран).
- Генерация `Rotor-Cuda_START.bat` при старте и чтение `Rotor-Cuda_Continue.bat`.
- secp256k1: парсинг публичного ключа, G-таблица, точечное сложение/удвоение,
  batch inversion, hash160, Ethereum-адрес.
- Хэши: SHA-256, RIPEMD-160, Keccak-160 (чистый Rust).
- Base58Check: decode адреса, WIF.
- Фильтры: Bloom (libbloom-параметры) и точная проверка по `.bin`-спискам
  hash160/xpoint; BinaryFuse отложен (результат не меняется).
- CPU-брутфорс: многопоточный обход диапазона, random-режим (`-r/-n/-z`),
  прогресс-строки, `Found.txt`, чекпоинты и `Rotor-Cuda_Continue.bat`.
- CPU-BSGS: baby table, giant walk, DP-фильтр, EC-перепроверка, вывод ключа.

Не входит (отдельные change):
- GPU-кернелы и `-g`-исполнение (CUDA остаётся C++).
- Self-update (`--check-update`/`--update`) — заглушка с явной ошибкой.
- Indexed/`-i`-генераторы, BinSort-утилиты.

## Constraints

- GPLv3, копирайты KeyHunt/VanitySearch/JeanLucPons/Mehdi256 сохраняются.
- Только авторизованные публичные puzzle-события; дисклеймер из README сохраняется.
- Никаких C-зависимостей: сборка `cargo build --release` без GMP/CUDA.
- CLI-совместимость: команды из README должны работать без правок.
- Провал — громкий: неверный ключ/диапазон/файл → ненулевой код возврата.

## Acceptance

- `cargo test` покрывает: secp256k1-векторы из `SECP256k1.cpp:96-155`, hash160/Keccak,
  WIF/Base58, парсер диапазонов, Bloom (нет false negative), BSGS-фикстуры из
  `bsgs_selftest.cpp`.
- `rotor -c` (самопроверка) проходит без внешних зависимостей.
- `rotor -m address --range ... <addr>` на малом диапазоне находит ключ, для которого
  `hash160(pubkey)` совпадает с целевым — проверяется внутри процесса, без сборки C++.
- `rotor --mode bsgs` находит скаляр на фикстурах `bsgs_selftest.cpp` и на диапазонах
  до 2^31; для pubkey #71 проверяется, что он парсится, лежит на кривой и что
  восстановленный ключ удовлетворяет `k·G = target`. Полный диапазон #71 (2^68,
  m ≈ 2^34) для CPU-BSGS нереален — ограничение алгоритма, а не реализации.
- Форматы `Found.txt` и `.bin` проверяются структурно (поля/размеры записей).
- Сборка C++/CUDA для приёмки не требуется.

## Risks

- CPU-скорость Rust-реализации может быть ниже C++ (SSE-хэши, ручная арифметика).
  Митигация: k256 + пакетное хэширование; сравнение Gk/s в отчёте.
- Точная семантика чекпоинтов/`Continue.bat` может отличаться — фиксируется в
  design.md по факту чтения `Rotor.cpp`.
