# Rust self-update (Windows) + Rust release asset

## Goal

Закрыть последний CLI-разрыв с C++: `--check-update`/`--update` в Rust-бинаре,
плюс публикация Rust-сборки как отдельного release-asset, чтобы обновлению было
что скачивать.

## Why

Сейчас `--update` печатает «не поддерживается», а release-workflow публикует
только C++ `Rotor-Cuda.exe`. Без собственного asset самообновление Rust-бинаря
невозможно (скачивать C++ exe нельзя — это подмена реализации).

## Scope

- `src/selfupdate.rs`: `version_cmp`, разбор GitHub release JSON, HTTPS GET через
  WinHTTP (`windows-sys`, без TLS-зависимостей), скачивание, SHA-256-проверка,
  подмена запущенного exe (rename → `.old`), перезапуск, очистка `.old`.
- Ожидаемые asset-имена: `rotor.exe` / `rotor.exe.sha256`; для сборки с feature
  `gpu` — `rotor-gpu.exe` / `rotor-gpu.exe.sha256`.
- `src/main.rs`: `--check-update`, `--update`; `cleanup_old()` на старте.
- `.github/workflows/rust-release.yml`: на тег `v*` собрать CPU-бинарь, проверить
  `--version`, приложить `rotor.exe` + `.sha256` к тому же GitHub Release.
- README: статус self-update, Windows-only, имена ассетов.

## Out of scope

- Подпись обновлений (как в C++, только TLS + SHA-256).
- GPU-release (нужен cudart DLL рядом) — отдельный change.
- Linux/macOS self-update.

## Acceptance

- `cargo test` покрывает `version_cmp` (кейсы C++ selftest), разбор JSON на
  фикстуре, SHA-256-проверку и swap на временных файлах.
- `rotor --check-update` на Windows печатает `current/latest/available` в формате C++;
  `--update` скачивает, проверяет хэш и подменяет бинарь; при ошибке — ненулевой код.
- На не-Windows `--update` явно сообщает о неподдержке.
- Release-workflow собирает `rotor.exe` и `.sha256` без C++/GMP.
