# Design: Rust self-update

## D1. HTTP без TLS-крейтов — WinHTTP через `windows-sys`

C++ использует WinHTTP; повторяем это на Rust. Плюсы: ноль C-зависимостей и
TLS-крейтов (rustls/ring требуют C-компилятор, которого на локальной GNU-сборке
нет), поведение 1:1 с C++. Минус: только Windows — как и в C++ (`#ifdef _WIN32`).

`windows-sys = "0.59"` (не 0.61: raw-dylib ломает локальную self-contained
MinGW-линковку, 0.59 уже транзитивно есть через `ctrlc 3.4.7`). Фичи:
`Win32_Foundation`, `Win32_Networking_WinHttp`.

## D2. Разбор JSON — как в C++

Нужны два поля (`tag_name`) и URL-ы ассетов по суффиксу имени. Регулярка/`serde`
не нужны: тот же построчный поиск `"name"` → ближайший `browser_download_url`,
что и `SelfUpdate.cpp:71-94`. Функция разбора отделена от сети и тестируется
офлайн на фикстуре.

## D3. Имена ассетов по варианту сборки

- CPU-сборка: `rotor.exe` / `rotor.exe.sha256`.
- `--features gpu`: `rotor-gpu.exe` / `rotor-gpu.exe.sha256`.
Выбор — `cfg!(feature = "gpu")`; C++-ассет `Rotor-Cuda.exe` не рассматривается,
чтобы Rust-бинарь не подменился C++-версией.

## D4. Подмена запущенного exe

1. Скачать в `<self>.new`, проверить SHA-256 (первый токен `.sha256`).
2. `fs::rename(self, self.old)` (на Windows разрешено для запущенного exe;
   `std::fs::rename` использует MoveFileEx с REPLACE_EXISTING).
3. `fs::rename(new, self)`; при ошибке — откат `.old` → `self`.
4. При `restart` — `Command::new(self).args(args).spawn()` и выход 0.
5. На старте `cleanup_old()` удаляет `.old`.

## D5. Версия

`pub const VERSION: &str = match option_env!("ROTOR_VERSION") { Some(v) => v, None => "dev" };`
(константный `match`: `Option::unwrap_or` не const в текущем Rust). Release-workflow
выставляет `ROTOR_VERSION=${tag}`. Строка `-v` остаётся C++-совместимой
(`Rotor-Cuda v2.0-rotor  mytab0r`), версия используется только для сравнения в
self-update, как `ROTOR_VERSION` в C++.

## D6. Release asset

Новый `rust-release.yml` (тег `v*`, windows-2022): `cargo build --release`,
smoke `--version`, `rotor.exe` + `<sha256>  rotor.exe` прикладываются к тому же
GitHub Release, что и C++-zip. GPU-бинарь в релиз не входит (нужен cudart DLL).

## Документированные отклонения

- Обновление проверяет только TLS+checksum, без подписи — как в C++.
- Jobs `--check-update/--update` на не-Windows — явная ошибка, а не no-op.
- Исправлен баг C++: `asset_url()` искал `"browser_download_url"` (с кавычкой) в
  подстроке, начинающейся с самого слова без кавычки, поэтому URL ассета всегда
  был пуст и `--update` в C++ падал с «missing asset». Rust-версия парсит значение
  от двоеточия и находит URL; тест `parse_cpu_release_picks_rust_assets...`
  это фиксирует.
