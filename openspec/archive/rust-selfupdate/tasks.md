# Tasks: Rust self-update

## 1. Модуль  (blocked by: —)
- [x] `src/selfupdate.rs`: `version_cmp` (семантика C++ selftest), `VERSION`.
- [x] `parse_release_json_for`: `tag_name`, ассеты по суффиксу `rotor.exe`/`rotor.exe.sha256`
      (или `rotor-gpu.*` при feature); ошибки GitHub API (`message`) пробрасываются.
- [x] WinHTTP (`windows-sys 0.59`): `https_get(host, path)`, `check_latest`, `download`.
- [x] `sha256_file`, `install_new_exe` (rename+rollback), `apply_update(args, restart)`,
      `cleanup_old`.
- [x] Не-Windows: `check_latest`/`apply_update` возвращают явную ошибку.

## 2. CLI  (blocked by: 1)
- [x] `src/main.rs`: `cleanup_old()` на старте (Windows), `--check-update`,
      `--update` с выводом формата C++ (`current/latest/available`, `updating ...`).
- [x] `Cargo.toml`: target-gated `windows-sys = "0.59"` с WinHTTP/Foundation.

## 3. Тесты  (blocked by: 1)
- [x] `tests/selfupdate.rs`: все кейсы `version_cmp` из `selfupdate_selftest.cpp`.
- [x] Разбор JSON на фикстуре (tag, оба ассета, C++-ассет игнорируется, gpu-суффиксы).
- [x] Ошибки разбора: нет `tag_name`, нет exe/sha ассетов, GitHub API `message`.
- [x] SHA-256 файла и swap на временных файлах (включая `.old` cleanup и откат).

## 4. Release  (blocked by: 2)
- [x] `.github/workflows/rust-release.yml`: тег `v*`, `ROTOR_VERSION`, CPU-бинарь,
      `rotor.exe` + `rotor.exe.sha256`, attach к релизу. Workflow не запускался
      (нужен push/тег).
- [x] README: self-update реализован (Windows), имена ассетов, ограничения.

## 5. Приёмка
- [x] `cargo test` (95), clippy, fmt — зелёные.
- [x] Linux-совместимость: `cargo check --target x86_64-unknown-linux-gnu --all-targets`
      проходит (FFI под `cfg(windows)`, на Linux — явная ошибка).
- [x] `--check-update` реально дошёл до GitHub через WinHTTP: получен JSON-ответ
      с rate-limit сообщением, оно выведено как ошибка (сеть и TLS работают).
      Полный `--update` не прогонялся: в текущем релизе нет `rotor.exe`, а rate
      limit IP исчерпан.
- [x] Независимое ревью критика: PASS (замечания — только минорные; HTTP-статус,
      перезапуск и доковый D5 закрыты/задокументированы) и archive change.
