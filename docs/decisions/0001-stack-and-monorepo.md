# ADR 0001: стек и структура репозитория

**Статус:** принято

## Решение

* Монорепозиторий на **npm workspaces**: `packages/core`, `apps/desktop`, `apps/mcp-server`.
  Использован npm, а не pnpm: он входит в Node.js и не требует установки дополнительного
  инструмента.
* **TypeScript 6.0** (`strict`, `noUncheckedIndexedAccess`). TypeScript 7 (нативный порт)
  пока не поддерживается `typescript-eslint` (peer `<6.1`), поэтому остаёмся на 6.0.
* UI: **React 19 + Vite 8**, без UI-фреймворков. Стили — простой CSS в классическом
  настольном оформлении.
* Оболочка: **Tauri 2** (Rust). Плагины: только `tauri-plugin-dialog` (системные диалоги
  открытия и сохранения). Чтение и запись файлов выполняют собственные команды с
  атомарной записью.
* MCP: официальный **@modelcontextprotocol/sdk 1.x**, транспорт stdio. Сервер собирается
  esbuild в один файл `dist/openbench-mcp.mjs`, которому нужен только Node.js ≥ 20.
* Тесты: **Vitest** (ядро, интеграция MCP), **Playwright** (e2e редактора в браузере и
  проверка настоящего окна Tauri через CDP), `cargo test` (Rust).

## Лицензии зависимостей (проверено при добавлении)

| Пакет | Лицензия |
|---|---|
| react, react-dom, vite, @vitejs/plugin-react, vitest, zod, eslint, typescript-eslint, esbuild, tsx, @modelcontextprotocol/sdk, tokio | MIT |
| typescript, @playwright/test | Apache-2.0 |
| tauri, tauri-build, tauri-plugin-dialog, @tauri-apps/*, serde, serde_json, getrandom | MIT OR Apache-2.0 |

Copyleft-зависимостей нет. Собственный код распространяется под MIT.
