import { nextComponentId, nextId, nextInputKey } from './circuit.js';
import { fail } from './errors.js';
import { componentBounds, footprint, pinDef, pinPosition, projectOnPolyline, simplify, snap } from './geometry.js';
import { wirePolyline } from './routing.js';
import { buildNetlist, pinDirection } from './netlist.js';
import type { Circuit, Component, ComponentType, Endpoint, Junction, PinDirection, Point, Wire } from './types.js';
import { ANALYZER_CHANNELS, COMPONENT_TYPES, MAX_GATE_INPUTS, MAX_WORDS, MIN_GATE_INPUTS, isMultiInputGateType, isPinEndpoint, splitPinId } from './types.js';

/** Endpoint given by id, or a point on an existing wire (a junction will be inserted there). */
export type EndpointSpec = Endpoint | { wireId: string; x: number; y: number };

export type EditCommand =
  | { type: 'addComponent'; componentType: ComponentType; x: number; y: number; label?: string; id?: string; key?: string; inputs?: number }
  | {
      type: 'moveItems';
      components?: { id: string; x: number; y: number }[];
      junctions?: { id: string; x: number; y: number }[];
    }
  | { type: 'removeItems'; componentIds?: string[]; wireIds?: string[]; junctionIds?: string[] }
  | { type: 'connect'; a: EndpointSpec; b: EndpointSpec; points?: Point[] }
  | { type: 'disconnect'; a: Endpoint; b: Endpoint }
  | { type: 'setWirePoints'; wireId: string; points: Point[] | null }
  | { type: 'setComponentProps'; id: string; label?: string | null; key?: string | null; inputs?: number }
  | { type: 'setWords'; words: number[] }
  | { type: 'configureWordGenerator'; cycle?: boolean; stepsPerSecond?: number }
  | {
      type: 'configureAnalyzer';
      channels?: { index: number; label?: string; visible?: boolean }[];
      maxHistory?: number;
      clocksPerDivision?: number;
    }
  | { type: 'attachAnalyzerChannel'; channel: number; target: Endpoint | null }
  | { type: 'setTitle'; title: string }
  | { type: 'setViewport'; x: number; y: number; zoom: number };

export interface PinInfo {
  id: string;
  name: string;
  direction: PinDirection;
  x: number;
  y: number;
}

export function componentPins(c: Component): PinInfo[] {
  return footprint(c).pins.map((p) => {
    const pos = pinPosition(c, p);
    return { id: `${c.id}.${p.name}`, name: p.name, direction: p.direction, x: pos.x, y: pos.y };
  });
}

export interface EditResult {
  circuit: Circuit;
  result: Record<string, unknown>;
}

export function applyEdit(circuit: Circuit, cmd: EditCommand): EditResult {
  switch (cmd.type) {
    case 'addComponent':
      return addComponent(circuit, cmd);
    case 'moveItems':
      return { circuit: moveItems(circuit, cmd), result: {} };
    case 'removeItems':
      return removeItems(circuit, cmd);
    case 'connect':
      return connect(circuit, cmd.a, cmd.b, cmd.points);
    case 'disconnect':
      return disconnect(circuit, cmd.a, cmd.b);
    case 'setWirePoints':
      return setWirePoints(circuit, cmd.wireId, cmd.points);
    case 'setComponentProps':
      return setComponentProps(circuit, cmd);
    case 'setWords':
      return setWords(circuit, cmd.words);
    case 'configureWordGenerator': {
      const wg = { ...circuit.instruments.wordGenerator };
      if (cmd.cycle !== undefined) wg.cycle = cmd.cycle;
      if (cmd.stepsPerSecond !== undefined) {
        if (!(cmd.stepsPerSecond >= 0.1 && cmd.stepsPerSecond <= 1000))
          fail('INVALID_ARGUMENT', 'stepsPerSecond должен быть в диапазоне 0.1…1000');
        wg.stepsPerSecond = cmd.stepsPerSecond;
      }
      return { circuit: { ...circuit, instruments: { ...circuit.instruments, wordGenerator: wg } }, result: { wordGenerator: wg } };
    }
    case 'configureAnalyzer':
      return configureAnalyzer(circuit, cmd);
    case 'attachAnalyzerChannel':
      return attachAnalyzerChannel(circuit, cmd.channel, cmd.target);
    case 'setTitle':
      return { circuit: { ...circuit, title: cmd.title.slice(0, 200) }, result: {} };
    case 'setViewport':
      return { circuit: { ...circuit, viewport: { x: cmd.x, y: cmd.y, zoom: cmd.zoom } }, result: {} };
  }
}

function findComponent(c: Circuit, id: string): Component {
  const comp = c.components.find((x) => x.id === id);
  if (!comp) fail('INVALID_ID', `Компонент "${id}" не найден`);
  return comp;
}

function checkCoord(v: number, name: string): void {
  if (!Number.isFinite(v) || Math.abs(v) > 100000) fail('INVALID_ARGUMENT', `Недопустимая координата ${name}: ${v}`);
}

function checkGateInputs(type: ComponentType, inputs: number): void {
  if (!isMultiInputGateType(type)) fail('INVALID_ARGUMENT', `Число входов задаётся только вентилям AND/NAND/OR/NOR/XOR/XNOR, а не ${type}`);
  if (!Number.isInteger(inputs) || inputs < MIN_GATE_INPUTS || inputs > MAX_GATE_INPUTS)
    fail('INVALID_ARGUMENT', `Число входов: целое ${MIN_GATE_INPUTS}…${MAX_GATE_INPUTS}, получено ${String(inputs)}`);
}

function addComponent(c: Circuit, cmd: Extract<EditCommand, { type: 'addComponent' }>): EditResult {
  if (!(COMPONENT_TYPES as readonly string[]).includes(cmd.componentType))
    fail('INVALID_ARGUMENT', `Неизвестный тип "${String(cmd.componentType)}". Допустимые: ${COMPONENT_TYPES.join(', ')}`);
  checkCoord(cmd.x, 'x');
  checkCoord(cmd.y, 'y');
  if (cmd.inputs !== undefined) checkGateInputs(cmd.componentType, cmd.inputs);
  if (cmd.componentType === 'WORD_GENERATOR' && c.components.some((x) => x.type === 'WORD_GENERATOR'))
    fail('INVALID_ARGUMENT', 'Word Generator уже есть в схеме (допускается один)');
  if (cmd.componentType === 'LOGIC_ANALYZER' && c.components.some((x) => x.type === 'LOGIC_ANALYZER'))
    fail('INVALID_ARGUMENT', 'Logic Analyzer уже есть в схеме (допускается один)');
  let id = cmd.id;
  if (id !== undefined) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) fail('INVALID_ARGUMENT', 'ID: 1–64 символа, латиница, цифры, "_" и "-"');
    if (c.components.some((x) => x.id === id) || c.junctions.some((x) => x.id === id) || c.wires.some((x) => x.id === id))
      fail('INVALID_ID', `ID "${id}" уже занят`);
  } else {
    id = nextComponentId(c, cmd.componentType);
  }
  const comp: Component = { id, type: cmd.componentType, x: snap(cmd.x), y: snap(cmd.y) };
  if (cmd.label !== undefined) comp.label = cmd.label.slice(0, 64);
  if (cmd.inputs !== undefined && cmd.inputs !== MIN_GATE_INPUTS) comp.inputs = cmd.inputs;
  if (cmd.componentType === 'INPUT') {
    comp.value = 0;
    const key = cmd.key ?? nextInputKey(c);
    if (key !== undefined) comp.key = key.slice(0, 1).toLowerCase();
  }
  return {
    circuit: { ...c, components: [...c.components, comp] },
    result: { component: comp, pins: componentPins(comp) },
  };
}

function moveItems(c: Circuit, cmd: Extract<EditCommand, { type: 'moveItems' }>): Circuit {
  const delta = new Map<string, Point>();
  const comps = c.components.map((comp) => {
    const m = cmd.components?.find((x) => x.id === comp.id);
    if (!m) return comp;
    checkCoord(m.x, 'x');
    checkCoord(m.y, 'y');
    const nx = snap(m.x);
    const ny = snap(m.y);
    delta.set(comp.id, { x: nx - comp.x, y: ny - comp.y });
    return { ...comp, x: nx, y: ny };
  });
  for (const m of cmd.components ?? []) findComponent(c, m.id);
  const junctions = c.junctions.map((j) => {
    const m = cmd.junctions?.find((x) => x.id === j.id);
    if (!m) return j;
    checkCoord(m.x, 'x');
    checkCoord(m.y, 'y');
    const nx = snap(m.x, 5);
    const ny = snap(m.y, 5);
    delta.set(j.id, { x: nx - j.x, y: ny - j.y });
    return { ...j, x: nx, y: ny };
  });
  for (const m of cmd.junctions ?? []) if (!c.junctions.some((j) => j.id === m.id)) fail('INVALID_ID', `Узел "${m.id}" не найден`);
  const ownerDelta = (e: Endpoint): Point | undefined => delta.get(isPinEndpoint(e) ? splitPinId(e).componentId : e);
  const wires = c.wires.map((w) => {
    if (!w.points) return w;
    const da = ownerDelta(w.a);
    const db = ownerDelta(w.b);
    // Wire moves as a whole only when both ends move together.
    if (da && db && da.x === db.x && da.y === db.y) return { ...w, points: w.points.map((p) => ({ x: p.x + da.x, y: p.y + da.y })) };
    return w;
  });
  return { ...c, components: comps, junctions, wires };
}

function removeItems(c: Circuit, cmd: Extract<EditCommand, { type: 'removeItems' }>): EditResult {
  const compIds = new Set(cmd.componentIds ?? []);
  const wireIds = new Set(cmd.wireIds ?? []);
  const junctionIds = new Set(cmd.junctionIds ?? []);
  for (const id of compIds) findComponent(c, id);
  for (const id of wireIds) if (!c.wires.some((w) => w.id === id)) fail('INVALID_ID', `Провод "${id}" не найден`);
  for (const id of junctionIds) if (!c.junctions.some((j) => j.id === id)) fail('INVALID_ID', `Узел "${id}" не найден`);
  const touches = (e: Endpoint): boolean => (isPinEndpoint(e) ? compIds.has(splitPinId(e).componentId) : junctionIds.has(e));
  const removedWires = c.wires.filter((w) => wireIds.has(w.id) || touches(w.a) || touches(w.b)).map((w) => w.id);
  let next: Circuit = {
    ...c,
    components: c.components.filter((x) => !compIds.has(x.id)),
    junctions: c.junctions.filter((j) => !junctionIds.has(j.id)),
    wires: c.wires.filter((w) => !removedWires.includes(w.id)),
  };
  next = cleanupJunctions(next, c);
  return { circuit: next, result: { removedComponents: [...compIds], removedWires } };
}

/**
 * Removes junctions that became useless: degree 0 is deleted, degree 1 is deleted together
 * with its dangling wire, degree 2 is merged into a single wire keeping the drawn shape.
 * `geometrySource` is the circuit used to materialize auto-routed shapes before merging.
 */
export function cleanupJunctions(c: Circuit, geometrySource: Circuit = c): Circuit {
  let cur = c;
  for (let guard = 0; guard < 10000; guard++) {
    const degree = new Map<string, Wire[]>();
    for (const j of cur.junctions) degree.set(j.id, []);
    for (const w of cur.wires) {
      degree.get(w.a)?.push(w);
      degree.get(w.b)?.push(w);
    }
    const victim = cur.junctions.find((j) => (degree.get(j.id)?.length ?? 0) <= 2);
    if (!victim) return cur;
    const ws = degree.get(victim.id)!;
    if (ws.length <= 1) {
      cur = {
        ...cur,
        junctions: cur.junctions.filter((j) => j.id !== victim.id),
        wires: cur.wires.filter((w) => !ws.includes(w)),
      };
      continue;
    }
    const [w1, w2] = ws as [Wire, Wire];
    const from = w1.a === victim.id ? w1.b : w1.a;
    const to = w2.a === victim.id ? w2.b : w2.a;
    if (from === to) {
      // Two parallel wires between the same endpoints through a junction: drop both.
      cur = { ...cur, junctions: cur.junctions.filter((j) => j.id !== victim.id), wires: cur.wires.filter((w) => w !== w1 && w !== w2) };
      continue;
    }
    const p1 = orientedPolyline(geometrySource, w1, from) ?? orientedPolyline(cur, w1, from);
    const p2 = orientedPolyline(geometrySource, w2, victim.id) ?? orientedPolyline(cur, w2, victim.id);
    let points: Point[] | undefined;
    if (p1 && p2) points = simplify([...p1, ...p2.slice(1)]).slice(1, -1);
    const merged: Wire = { id: w1.id, a: from, b: to };
    if (points && points.length > 0) merged.points = points;
    cur = {
      ...cur,
      junctions: cur.junctions.filter((j) => j.id !== victim.id),
      wires: [...cur.wires.filter((w) => w !== w1 && w !== w2), merged],
    };
  }
  return cur;
}

/** Polyline of a wire oriented to start at `start`. */
function orientedPolyline(c: Circuit, w: Wire, start: Endpoint): Point[] | undefined {
  const poly = wirePolyline(c, w);
  if (!poly) return undefined;
  return w.a === start ? poly : [...poly].reverse();
}

function endpointDirection(c: Circuit, e: Endpoint): PinDirection | undefined {
  return isPinEndpoint(e) ? pinDirection(c, e) : undefined;
}

function validateEndpoint(c: Circuit, e: Endpoint): void {
  if (typeof e !== 'string' || e.length === 0) fail('INVALID_ARGUMENT', 'Пустой идентификатор вывода');
  if (isPinEndpoint(e)) {
    const { componentId, pin } = splitPinId(e);
    const comp = c.components.find((x) => x.id === componentId);
    if (!comp) fail('INVALID_ID', `Компонент "${componentId}" не найден (вывод ${e})`);
    if (!pinDef(comp, pin))
      fail('INVALID_ID', `У ${componentId} (${comp.type}) нет вывода "${pin}". Доступные: ${footprint(comp).pins.map((p) => `${componentId}.${p.name}`).join(', ')}`);
  } else if (!c.junctions.some((j) => j.id === e)) {
    fail('INVALID_ID', `Узел "${e}" не найден. Укажите вывод в формате <компонент>.<вывод>, например and1.A`);
  }
}

/** Inserts a junction on a wire at the projection of (x, y); returns the new circuit and junction id. */
export function splitWire(c: Circuit, wireId: string, x: number, y: number): { circuit: Circuit; junctionId: string } {
  const w = c.wires.find((x2) => x2.id === wireId);
  if (!w) fail('INVALID_ID', `Провод "${wireId}" не найден`);
  const poly = wirePolyline(c, w);
  if (!poly) fail('INTERNAL', `Провод ${wireId} ссылается на несуществующие концы`);
  const proj = projectOnPolyline(poly, { x, y })!;
  const pt = proj.point;
  const jid = nextId(c, 'j');
  const junction: Junction = { id: jid, x: pt.x, y: pt.y };
  const first = simplify([...poly.slice(0, proj.segment + 1), pt]);
  const second = simplify([pt, ...poly.slice(proj.segment + 1)]);
  // Both halves keep the exact drawn shape of the original wire.
  const w1: Wire = { id: w.id, a: w.a, b: jid };
  const inner1 = first.slice(1, -1);
  if (inner1.length > 0) w1.points = inner1;
  const w2: Wire = { id: nextId({ ...c, junctions: [...c.junctions, junction] }, 'w'), a: jid, b: w.b };
  const inner2 = second.slice(1, -1);
  if (inner2.length > 0) w2.points = inner2;
  return {
    circuit: {
      ...c,
      junctions: [...c.junctions, junction],
      wires: [...c.wires.filter((x2) => x2.id !== w.id), w1, w2],
    },
    junctionId: jid,
  };
}

function connect(c: Circuit, aSpec: EndpointSpec, bSpec: EndpointSpec, points?: Point[]): EditResult {
  let cur = c;
  const created: string[] = [];
  const resolve = (spec: EndpointSpec): Endpoint => {
    if (typeof spec === 'string') {
      validateEndpoint(cur, spec);
      return spec;
    }
    if (typeof spec !== 'object' || spec === null || typeof spec.wireId !== 'string') fail('INVALID_ARGUMENT', 'Неверный формат конца провода');
    checkCoord(spec.x, 'x');
    checkCoord(spec.y, 'y');
    const r = splitWire(cur, spec.wireId, spec.x, spec.y);
    cur = r.circuit;
    created.push(r.junctionId);
    return r.junctionId;
  };
  const a = resolve(aSpec);
  const b = resolve(bSpec);
  if (a === b) fail('INVALID_CONNECTION', 'Нельзя соединить вывод сам с собой');
  if (cur.wires.some((w) => (w.a === a && w.b === b) || (w.a === b && w.b === a)))
    fail('INVALID_CONNECTION', `${a} и ${b} уже соединены`);
  const netlist = buildNetlist(cur);
  const netA = isPinEndpoint(a) ? netlist.netOfPin.get(a) : netlist.netOfJunction.get(a);
  const netB = isPinEndpoint(b) ? netlist.netOfPin.get(b) : netlist.netOfJunction.get(b);
  if (netA && netB && netA === netB) fail('INVALID_CONNECTION', `${a} и ${b} уже находятся в одной сети ${netA.id}`);
  const driversA = netA ? netA.drivers : endpointDirection(cur, a) === 'output' ? [a] : [];
  const driversB = netB ? netB.drivers : endpointDirection(cur, b) === 'output' ? [b] : [];
  if (driversA.length + driversB.length > 1)
    fail(
      'DRIVER_CONFLICT',
      `Конфликт драйверов: соединение объединит выходы ${[...driversA, ...driversB].join(', ')} в одну сеть. Выход можно подключать только ко входам.`,
      { drivers: [...driversA, ...driversB] },
    );
  if (points) for (const p of points) {
    checkCoord(p.x, 'x');
    checkCoord(p.y, 'y');
  }
  const wid = nextId(cur, 'w');
  const wire: Wire = { id: wid, a, b };
  if (points && points.length > 0) wire.points = points.map((p) => ({ x: p.x, y: p.y }));
  cur = { ...cur, wires: [...cur.wires, wire] };
  const net = buildNetlist(cur).netOfWire.get(wid);
  return { circuit: cur, result: { wireId: wid, junctionIds: created, netId: net?.id ?? null } };
}

function disconnect(c: Circuit, a: Endpoint, b: Endpoint): EditResult {
  validateEndpoint(c, a);
  validateEndpoint(c, b);
  const w = c.wires.find((x) => (x.a === a && x.b === b) || (x.a === b && x.b === a));
  if (!w) fail('INVALID_CONNECTION', `Между ${a} и ${b} нет прямого провода`);
  return removeItems(c, { type: 'removeItems', wireIds: [w.id] });
}

function setWirePoints(c: Circuit, wireId: string, points: Point[] | null): EditResult {
  const w = c.wires.find((x) => x.id === wireId);
  if (!w) fail('INVALID_ID', `Провод "${wireId}" не найден`);
  const nw: Wire = { id: w.id, a: w.a, b: w.b };
  if (points && points.length > 0) {
    for (const p of points) {
      checkCoord(p.x, 'x');
      checkCoord(p.y, 'y');
    }
    nw.points = points;
  }
  return { circuit: { ...c, wires: c.wires.map((x) => (x.id === wireId ? nw : x)) }, result: {} };
}

function setComponentProps(c: Circuit, cmd: Extract<EditCommand, { type: 'setComponentProps' }>): EditResult {
  const comp = findComponent(c, cmd.id);
  const next: Component = { ...comp };
  if (cmd.label !== undefined) {
    if (cmd.label === null || cmd.label === '') delete next.label;
    else next.label = cmd.label.slice(0, 64);
  }
  if (cmd.key !== undefined) {
    if (comp.type !== 'INPUT') fail('INVALID_ARGUMENT', 'Клавиша назначается только элементу INPUT');
    if (cmd.key === null || cmd.key === '') delete next.key;
    else {
      const k = cmd.key.slice(0, 1).toLowerCase();
      if (!/^[0-9a-z]$/.test(k)) fail('INVALID_ARGUMENT', 'Клавиша: цифра или латинская буква');
      next.key = k;
    }
  }
  if (cmd.inputs !== undefined) {
    checkGateInputs(comp.type, cmd.inputs);
    // Shrinking must not silently drop wires: removed pins have to be disconnected first.
    const kept = new Set(footprint({ type: comp.type, inputs: cmd.inputs }).pins.map((p) => `${comp.id}.${p.name}`));
    const busy = c.wires
      .flatMap((w) => [w.a, w.b])
      .filter((e) => isPinEndpoint(e) && splitPinId(e).componentId === comp.id && !kept.has(e));
    if (busy.length > 0)
      fail('INVALID_CONNECTION', `Нельзя уменьшить число входов ${comp.id} до ${cmd.inputs}: подключены ${[...new Set(busy)].sort().join(', ')}. Сначала отключите их.`, {
        pins: [...new Set(busy)].sort(),
      });
    if (cmd.inputs === MIN_GATE_INPUTS) delete next.inputs;
    else next.inputs = cmd.inputs;
  }
  return { circuit: { ...c, components: c.components.map((x) => (x.id === comp.id ? next : x)) }, result: { component: next, pins: componentPins(next) } };
}

export function validateWords(words: unknown): number[] {
  if (!Array.isArray(words)) fail('INVALID_ARGUMENT', 'words должен быть массивом чисел 0…65535');
  if (words.length > MAX_WORDS) fail('LIMIT_EXCEEDED', `Не более ${MAX_WORDS} слов в последовательности`);
  return words.map((w, i) => {
    if (typeof w !== 'number' || !Number.isInteger(w) || w < 0 || w > 0xffff)
      fail('INVALID_ARGUMENT', `Слово #${i} (${String(w)}) вне диапазона 0x0000…0xFFFF`);
    return w;
  });
}

function setWords(c: Circuit, words: number[]): EditResult {
  const valid = validateWords(words);
  const wg = { ...c.instruments.wordGenerator, words: valid };
  return { circuit: { ...c, instruments: { ...c.instruments, wordGenerator: wg } }, result: { count: valid.length } };
}

function configureAnalyzer(c: Circuit, cmd: Extract<EditCommand, { type: 'configureAnalyzer' }>): EditResult {
  const la = { ...c.instruments.logicAnalyzer, channels: c.instruments.logicAnalyzer.channels.map((x) => ({ ...x })) };
  for (const ch of cmd.channels ?? []) {
    if (!Number.isInteger(ch.index) || ch.index < 0 || ch.index >= ANALYZER_CHANNELS) fail('INVALID_ARGUMENT', `Канал ${ch.index} вне диапазона 0…15`);
    const target = la.channels[ch.index]!;
    if (ch.label !== undefined) target.label = ch.label.slice(0, 32);
    if (ch.visible !== undefined) target.visible = ch.visible;
  }
  if (cmd.maxHistory !== undefined) {
    if (!Number.isInteger(cmd.maxHistory) || cmd.maxHistory < 16 || cmd.maxHistory > 1_000_000) fail('INVALID_ARGUMENT', 'maxHistory: 16…1000000');
    la.maxHistory = cmd.maxHistory;
  }
  if (cmd.clocksPerDivision !== undefined) {
    if (!Number.isInteger(cmd.clocksPerDivision) || cmd.clocksPerDivision < 1 || cmd.clocksPerDivision > 64) fail('INVALID_ARGUMENT', 'clocksPerDivision: 1…64');
    la.clocksPerDivision = cmd.clocksPerDivision;
  }
  return { circuit: { ...c, instruments: { ...c.instruments, logicAnalyzer: la } }, result: { logicAnalyzer: la } };
}

function attachAnalyzerChannel(c: Circuit, channel: number, target: Endpoint | null): EditResult {
  if (!Number.isInteger(channel) || channel < 0 || channel >= ANALYZER_CHANNELS) fail('INVALID_ARGUMENT', `Канал ${channel} вне диапазона 0…15`);
  let cur = c;
  let la = cur.components.find((x) => x.type === 'LOGIC_ANALYZER');
  let addedAnalyzer: string | null = null;
  if (!la) {
    const right = cur.components.reduce((m, x) => Math.max(m, componentBounds(x).x + componentBounds(x).width), 0);
    const top = cur.components.reduce((m, x) => Math.min(m, x.y), Number.POSITIVE_INFINITY);
    const r = addComponent(cur, { type: 'addComponent', componentType: 'LOGIC_ANALYZER', x: right + 80, y: Number.isFinite(top) ? top : 0 });
    cur = r.circuit;
    la = cur.components.find((x) => x.type === 'LOGIC_ANALYZER')!;
    addedAnalyzer = la.id;
  }
  const pin = `${la.id}.CH${channel}`;
  if (target !== null) validateEndpoint(cur, target);
  const attached = cur.wires.filter((w) => w.a === pin || w.b === pin).map((w) => w.id);
  if (attached.length > 0) cur = removeItems(cur, { type: 'removeItems', wireIds: attached }).circuit;
  if (target === null) return { circuit: cur, result: { channel, pin, netId: null, addedAnalyzer } };
  const r = connect(cur, target, pin);
  return { circuit: r.circuit, result: { channel, pin, netId: r.result.netId, wireId: r.result.wireId, addedAnalyzer } };
}
