import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { ApiMethod } from '@openbench/core';
import { API_SCHEMAS, isOpenBenchError, toWireError } from '@openbench/core';
import type { BridgeCall } from './bridge-client.js';

export const SERVER_NAME = 'openbench';
export const SERVER_VERSION = '0.1.0';

interface ToolDef {
  title: string;
  description: string;
  readOnly?: boolean;
  destructive?: boolean;
}

/** Tool descriptions. Names match the required OpenBench MCP API; each maps 1:1 to an engine API method. */
const TOOLS: Record<ApiMethod, ToolDef> = {
  get_project_state: {
    title: 'Состояние проекта',
    description:
      'Return the project open in the OpenBench window: components with their pin IDs, wires, nets with current values, Word Generator words, Logic Analyzer channel bindings, simulation status and diagnostics.',
    readOnly: true,
  },
  new_project: { title: 'Новый проект', description: 'Replace the open project with an empty one (unsaved changes in the GUI are discarded).', destructive: true },
  add_component: {
    title: 'Добавить элемент',
    description:
      'Add a component at canvas coordinates (grid 10). Types: INPUT (manual switch), OUTPUT (probe), CONST0, CONST1, BUFFER, NOT, AND, NAND, OR, NOR, XOR, XNOR, WORD_GENERATOR (pins D0..D15, D0 = LSB, one per project), LOGIC_ANALYZER (pins CH0..CH15, one per project). AND/NAND/OR/NOR/XOR/XNOR accept inputs=2..8 (input pins A..H, default 2). Returns the component ID and its valid pin IDs ("and1.A", "and1.B", "and1.OUT").',
  },
  set_gate_inputs: {
    title: 'Число входов вентиля',
    description:
      'Change the number of inputs (2..8, pins A..H) of an AND/NAND/OR/NOR/XOR/XNOR gate; returns the new pin IDs. Shrinking is rejected with INVALID_CONNECTION while a removed pin is still wired — disconnect it first.',
  },
  move_component: { title: 'Переместить элемент', description: 'Move a component to new top-left coordinates (snapped to the 10-unit grid). Wires follow.' },
  remove_component: { title: 'Удалить элемент', description: 'Remove a component and every wire attached to it.', destructive: true },
  connect_pins: {
    title: 'Соединить выводы',
    description:
      'Draw a wire between two pins ("comp.PIN") or junctions. Rejected with DRIVER_CONFLICT if it would put two outputs on one net; one output may drive any number of inputs (fan-out).',
  },
  disconnect_pins: { title: 'Разъединить выводы', description: 'Remove the direct wire between two pins/junctions.', destructive: true },
  set_input: { title: 'Установить INPUT', description: 'Set a manual INPUT switch to 0 or 1; the circuit is re-evaluated immediately.' },
  set_word_sequence: {
    title: 'Слова Word Generator',
    description: 'Replace the Word Generator sequence with 16-bit words (numbers or strings "0x0003" / "0b11"). Bit k drives pin Dk (D0 = least significant).',
  },
  configure_word_generator: { title: 'Настроить Word Generator', description: 'Set Cycle mode (wrap to the first word at the end) and the Run speed in steps per second.' },
  attach_analyzer_channel: {
    title: 'Подключить канал анализатора',
    description:
      'Connect Logic Analyzer channel CHn (0..15) to a pin or net ID (a net ID equals its driver pin ID, e.g. "and1.OUT"), replacing the previous connection; target null disconnects. Adds a Logic Analyzer if the project has none.',
  },
  simulation_step: {
    title: 'Шаг симуляции',
    description:
      'Execute N deterministic ticks (1..10000). Each tick applies the next Word Generator word and the INPUT values, evaluates the circuit and records one Logic Analyzer frame. Without Cycle the run stops at the end of the sequence.',
  },
  simulation_reset: { title: 'Сброс симуляции', description: 'Return to address 0 / tick 0 (generator outputs become X); clears analyzer history unless clearHistory=false.' },
  simulation_run: { title: 'Пуск', description: 'Start continuous playback in the GUI at the configured steps/second (use simulation_step for deterministic scripted runs).' },
  simulation_stop: { title: 'Стоп', description: 'Stop continuous playback.' },
  get_signal_values: {
    title: 'Значения сигналов',
    description: 'Read current values (0, 1, X = unknown, E = driver conflict) of nets, pins or INPUT/OUTPUT components. Without ids returns all nets, probes and analyzer channels (null = channel not connected).',
    readOnly: true,
  },
  get_analyzer_history: {
    title: 'История анализатора',
    description: 'Return recorded Logic Analyzer samples for the given channels and tick range (values per tick; null = not connected).',
    readOnly: true,
  },
  get_validation_errors: { title: 'Диагностика', description: 'Return circuit diagnostics: driver conflicts, missing drivers, unconnected inputs, combinational loops.', readOnly: true },
  undo: { title: 'Отменить', description: 'Undo the last project edit (same history as Ctrl+Z in the GUI).' },
  redo: { title: 'Повторить', description: 'Redo the last undone edit.' },
  export_analyzer_csv: {
    title: 'Экспорт CSV',
    description: 'Export analyzer history as CSV. Without path returns the CSV text; with path writes a .csv file relative to the OpenBench workspace directory.',
  },
  save_project: {
    title: 'Сохранить проект',
    description: 'Save the open project as *.openbench.json at a path relative to the OpenBench workspace directory (default: <title>.openbench.json). Absolute paths and ".." are rejected.',
  },
  open_project: {
    title: 'Открыть проект',
    description: 'Open a *.openbench.json file from the OpenBench workspace directory (relative path); the file is validated (schemaVersion 1) before it replaces the open project.',
    destructive: true,
  },
};

function ok(result: unknown): CallToolResult {
  const structured = result !== null && typeof result === 'object' && !Array.isArray(result) ? (result as Record<string, unknown>) : { result };
  return { content: [{ type: 'text', text: JSON.stringify(result, null, 1) }], structuredContent: structured };
}

function error(e: unknown): CallToolResult {
  const w = toWireError(e);
  const text = JSON.stringify({ error: w });
  return { isError: true, content: [{ type: 'text', text }] };
}

export function createServer(bridge: BridgeCall): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions:
        'OpenBench is a digital-logic lab bench. Every tool operates on the project currently open in the OpenBench desktop window (it must be running). ' +
        'Typical flow: add_component (use returned pin IDs) → connect_pins → set_word_sequence → attach_analyzer_channel → simulation_reset → simulation_step → get_analyzer_history. ' +
        'Signals are 0, 1, X (unknown) or E (driver conflict); analyzer channels that are not connected read null.',
    },
  );
  for (const method of Object.keys(TOOLS) as ApiMethod[]) {
    const def = TOOLS[method];
    server.registerTool(
      method,
      {
        title: def.title,
        description: def.description,
        inputSchema: API_SCHEMAS[method].shape,
        annotations: { readOnlyHint: def.readOnly ?? false, destructiveHint: def.destructive ?? false, openWorldHint: false },
      },
      async (args: unknown) => {
        try {
          return ok(await bridge.call(method, args ?? {}));
        } catch (e) {
          if (isOpenBenchError(e) || e instanceof Error) return error(e);
          return error(new Error(String(e)));
        }
      },
    );
  }
  return server;
}
