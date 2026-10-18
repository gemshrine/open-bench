# Подключение OpenBench к MCP-клиенту

MCP-сервер OpenBench — это локальный процесс, который общается с клиентом по **stdio** и
управляет **открытым окном OpenBench**. Сетевой порт MCP-сервер не открывает. С окном он
связан через loopback-мост с токеном (см. [architecture.md](architecture.md#ipc-gui--mcp)).

## 1. Сборка сервера

```bash
npm install
npm run build -w @openbench/mcp-server     # → apps/mcp-server/dist/openbench-mcp.mjs
```

Собранный файл самодостаточен: для запуска нужен только Node.js ≥ 20.

## 2. Claude Code

Зарегистрируйте сервер (transport по умолчанию — stdio). Путь укажите свой, абсолютный:

```bash
# Windows (PowerShell или cmd)
claude mcp add openbench -- node "D:/development/open-bench/apps/mcp-server/dist/openbench-mcp.mjs"

# Linux / macOS
claude mcp add openbench -- node /home/user/open-bench/apps/mcp-server/dist/openbench-mcp.mjs
```

Чтобы конфигурация хранилась в репозитории и была общей для команды, добавьте
`--scope project`. Claude Code создаст в корне проекта файл `.mcp.json`:

```json
{
  "mcpServers": {
    "openbench": {
      "type": "stdio",
      "command": "node",
      "args": ["D:/development/open-bench/apps/mcp-server/dist/openbench-mcp.mjs"],
      "env": {}
    }
  }
}
```

Проверка: `claude mcp list` должен показать `openbench`. Внутри Claude Code команда
`/mcp` показывает статус и список инструментов.

Необязательные переменные окружения (`-e KEY=value` в `claude mcp add` или `env` в
`.mcp.json`):

| Переменная | Назначение |
|---|---|
| `OPENBENCH_BRIDGE_FILE` | нестандартный путь к `bridge.json` (тот же нужно задать и GUI) |

Рабочая папка для `save_project` / `open_project` задаётся на стороне **GUI** переменной
`OPENBENCH_WORKSPACE`. По умолчанию это `Документы/OpenBench`. Путь к ней показан во
всплывающей подсказке строки состояния «MCP: порт …».

## 3. Использование

1. Запустите OpenBench (`npm run tauri dev` или установленное приложение). В строке
   состояния появится «MCP: порт NNNNN».
2. В Claude Code попросите, например:

   > Собери в OpenBench схему: Word Generator, элемент AND, Logic Analyzer.
   > D0 → AND.A, D1 → AND.B, выход AND на CH0, D0 на CH1, D1 на CH2.
   > Слова 0000, 0001, 0002, 0003. Выполни 4 шага и покажи историю каналов.

   Агент вызовет `new_project`, `add_component` (получит реальные ID выводов),
   `connect_pins`, `attach_analyzer_channel`, `set_word_sequence`, `simulation_step` и
   `get_analyzer_history`. Схема появится в окне по мере вызовов, результат будет
   `CH0 = [0,0,0,1]`, `CH1 = [0,1,0,1]`, `CH2 = [0,0,1,1]`.

## Инструменты

| Инструмент | Назначение |
|---|---|
| `get_project_state` | проект, компоненты с ID выводов, провода, сети и значения, приборы, симуляция, диагностика |
| `new_project` | пустой проект |
| `add_component` | добавить элемент → ID и список выводов; у AND/NAND/OR/NOR/XOR/XNOR — `inputs` 2…8 |
| `set_gate_inputs` | изменить число входов вентиля (2…8) → новый список выводов |
| `move_component` / `remove_component` | переместить / удалить (вместе с проводами) |
| `connect_pins` / `disconnect_pins` | соединить / разъединить выводы (`comp.PIN`) |
| `set_input` | INPUT = 0/1 |
| `set_word_sequence` | слова (числа или `"0x0003"`, `"0b11"`) |
| `configure_word_generator` | `cycle`, `stepsPerSecond` |
| `attach_analyzer_channel` | CHn ↔ вывод/сеть (`null` — отключить) |
| `simulation_step` | N тиков (1…10000) |
| `simulation_reset` | сброс (`clearHistory`) |
| `simulation_run` / `simulation_stop` | непрерывное воспроизведение в GUI |
| `get_signal_values` | значения сетей/выводов/пробников |
| `get_analyzer_history` | история каналов в диапазоне ticks |
| `get_validation_errors` | диагностика схемы |
| `undo` / `redo` | общая с GUI история правок |
| `export_analyzer_csv` | CSV (текстом или в файл в рабочей папке) |
| `save_project` / `open_project` | файлы `*.openbench.json` только в рабочей папке |

## Ошибки

Ошибка возвращается как результат с `isError: true` и JSON
`{"error":{"code","message","details?"}}`.

| Код | Когда |
|---|---|
| `GUI_NOT_RUNNING` | окно OpenBench не запущено, ещё загружается или закрылось |
| `NO_PROJECT` | (зарезервировано) проект не открыт |
| `INVALID_ID` | нет такого компонента, вывода, провода или узла (в сообщении — список допустимых выводов) |
| `INVALID_ARGUMENT` | параметры не прошли проверку схемы |
| `INVALID_CONNECTION` | соединение с самим собой, повтор, уже одна сеть |
| `DRIVER_CONFLICT` | соединение объединило бы два выхода |
| `SEQUENCE_EMPTY`, `SEQUENCE_END` | шаг невозможен: пустая последовательность или её конец без Cycle |
| `LIMIT_EXCEEDED` | превышен лимит (слова, шаги) |
| `SCHEMA_ERROR` | файл проекта некорректен или другой версии |
| `PATH_NOT_ALLOWED`, `FILE_ERROR` | путь вне рабочей папки или ошибка ввода-вывода |

Неудачный вызов не изменяет проект.

## Без окна (CI)

`npm run build:headless -w @openbench/mcp-server` собирает `openbench-headless.mjs`. Это
тот же мост и тот же движок без GUI, для автоматических проверок. Не запускайте его
одновременно с окном OpenBench: оба используют один `bridge.json`.
