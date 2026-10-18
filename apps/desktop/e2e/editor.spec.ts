import { readFile } from 'node:fs/promises';
import type { Page } from '@playwright/test';
import { expect, test } from '@playwright/test';
import { footprint, pinDef } from '@openbench/core';
import type { Circuit, ComponentType } from '@openbench/core';

async function circuit(page: Page): Promise<Circuit> {
  return page.evaluate(() => window.__openbench!.session.circuit);
}

async function toScreen(page: Page, x: number, y: number): Promise<{ x: number; y: number }> {
  return page.evaluate(([px, py]) => window.__openbench!.toScreen!({ x: px!, y: py! }), [x, y]);
}

async function pinScreen(page: Page, pinId: string): Promise<{ x: number; y: number }> {
  const c = await circuit(page);
  const [compId, pin] = pinId.split('.') as [string, string];
  const comp = c.components.find((x) => x.id === compId)!;
  const def = pinDef(comp.type, pin)!;
  return toScreen(page, comp.x + def.x, comp.y + def.y);
}

/** Place a component from the palette by click-to-place, centred at canvas point (x, y). */
async function place(page: Page, type: ComponentType, x: number, y: number): Promise<string> {
  await page.getByTestId(`palette-${type}`).click();
  const p = await toScreen(page, x, y);
  await page.mouse.click(p.x, p.y);
  const c = await circuit(page);
  const comp = c.components[c.components.length - 1]!;
  expect(comp.type).toBe(type);
  const f = footprint(type);
  expect(comp.x).toBe(Math.round((x - f.width / 2) / 10) * 10);
  return comp.id;
}

/** Draw a wire by dragging from one pin to another. */
async function wire(page: Page, from: string, to: string): Promise<void> {
  const a = await pinScreen(page, from);
  const b = await pinScreen(page, to);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move((a.x + b.x) / 2, (a.y + b.y) / 2, { steps: 4 });
  await page.mouse.move(b.x, b.y, { steps: 4 });
  await page.mouse.up();
}

async function buildAndScenario(page: Page): Promise<void> {
  await place(page, 'WORD_GENERATOR', 120, 30);
  await place(page, 'AND', 200, 160);
  await place(page, 'LOGIC_ANALYZER', 420, 110);
  await wire(page, 'wg.D0', 'and1.A');
  await wire(page, 'wg.D1', 'and1.B');
  await wire(page, 'and1.OUT', 'la.CH0');
  await wire(page, 'wg.D0', 'la.CH1');
  await wire(page, 'wg.D1', 'la.CH2');
  expect((await circuit(page)).wires).toHaveLength(5);

  // Words 0000, 0001, 0002, 0003 entered in the Word Generator window.
  await page.getByTestId('open-wg').click();
  const wg = page.getByTestId('word-generator');
  await wg.getByTestId('wg-final').fill('3');
  await wg.getByTestId('wg-final').press('Enter');
  for (let addr = 1; addr <= 3; addr++) {
    await wg.locator(`[data-addr="${addr}"]`).click();
    await wg.getByTestId('wg-binary').fill(addr.toString(2).padStart(16, '0'));
    await wg.getByTestId('wg-binary').press('Enter');
  }
  expect((await circuit(page)).instruments.wordGenerator.words).toEqual([0, 1, 2, 3]);
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('schematic')).toBeVisible();
});

test('scenario 1: Word Generator → AND → Logic Analyzer in the GUI', async ({ page }) => {
  await buildAndScenario(page);
  for (let i = 0; i < 4; i++) await page.getByTestId('step').click();
  const history = await page.evaluate(() => window.__openbench!.session.history.map((f) => f.channels.slice(0, 3)));
  expect(history.map((h) => h[0])).toEqual([0, 0, 0, 1]);
  expect(history.map((h) => h[1])).toEqual([0, 1, 0, 1]);
  expect(history.map((h) => h[2])).toEqual([0, 0, 1, 1]);

  await page.getByTestId('open-la').click();
  const la = page.getByTestId('logic-analyzer');
  // Waveforms are drawn for the connected channels; the others show no trace and "—".
  await expect(la.locator('path[data-channel="0"]')).toHaveCount(1);
  await expect(la.locator('path[data-channel="3"]')).toHaveCount(0);
  await expect(la.getByTestId('la-ch0')).toHaveText('1');
  await expect(la.getByTestId('la-ch3')).toHaveText('');
  await expect(la.getByTestId('la-ch3')).toHaveAttribute('title', /не подключён/);
  await expect(page.getByTestId('status-tick')).toHaveText('tick 4');
  // The AND waveform must be low for three ticks then high: check its geometry.
  const d = await la.locator('path[data-channel="0"]').getAttribute('d');
  const ys = [...d!.matchAll(/L[\d.]+,([\d.]+)/g)].map((m) => Number(m[1]));
  expect(new Set(ys).size).toBe(2);
  await page.screenshot({ path: 'test-results/and-scenario.png' });
});

test('scenario 2: XOR', async ({ page }) => {
  await place(page, 'WORD_GENERATOR', 120, 30);
  await place(page, 'XOR', 200, 160);
  await place(page, 'LOGIC_ANALYZER', 420, 110);
  await wire(page, 'wg.D0', 'xor1.A');
  await wire(page, 'wg.D1', 'xor1.B');
  await wire(page, 'xor1.OUT', 'la.CH0');
  await page.evaluate(() => window.__openbench!.session.edit({ type: 'setWords', words: [0, 1, 2, 3] }));
  for (let i = 0; i < 4; i++) await page.keyboard.press('F6');
  const ch0 = await page.evaluate(() => window.__openbench!.session.history.map((f) => f.channels[0]));
  expect(ch0).toEqual([0, 1, 1, 0]);
});

test('scenario 3: save, reopen and get the same circuit and results', async ({ page }) => {
  await buildAndScenario(page);
  const before = await circuit(page);
  const downloadPromise = page.waitForEvent('download');
  await page.getByTestId('save').click();
  const download = await downloadPromise;
  const text = await readFile((await download.path())!, 'utf8');
  expect(JSON.parse(text).schemaVersion).toBe(1);

  await page.reload();
  expect((await circuit(page)).components).toHaveLength(0);
  const chooserPromise = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Открыть…' }).click();
  const chooser = await chooserPromise;
  await chooser.setFiles({ name: 'and.openbench.json', mimeType: 'application/json', buffer: Buffer.from(text) });
  await expect.poll(async () => (await circuit(page)).components.length).toBe(3);
  const after = await circuit(page);
  expect({ ...after, viewport: undefined }).toEqual({ ...before, viewport: undefined });
  for (let i = 0; i < 4; i++) await page.getByTestId('step').click();
  const ch0 = await page.evaluate(() => window.__openbench!.session.history.map((f) => f.channels[0]));
  expect(ch0).toEqual([0, 0, 0, 1]);
});

test('editing: undo/redo, delete, Esc, input toggle and driver-conflict message', async ({ page }) => {
  const sw = await place(page, 'INPUT', 60, 60);
  const lamp = await place(page, 'OUTPUT', 200, 60);
  await wire(page, `${sw}.OUT`, `${lamp}.IN`);
  expect((await circuit(page)).wires).toHaveLength(1);
  const probe = page.locator(`[data-component="${lamp}"] circle`);
  await expect(probe).toHaveAttribute('fill', '#fff');
  await page.keyboard.press('1'); // the switch got key [1]
  await expect(probe).toHaveAttribute('fill', '#ff7c7c');

  await page.keyboard.press('Control+z');
  expect((await circuit(page)).wires).toHaveLength(0);
  await page.keyboard.press('Control+y');
  expect((await circuit(page)).wires).toHaveLength(1);

  // Two outputs on one net are refused with a visible message.
  const vcc = await place(page, 'CONST1', 120, 140);
  await wire(page, `${vcc}.OUT`, `${lamp}.IN`);
  await expect(page.getByTestId('status-error')).toContainText('Конфликт драйверов');
  expect((await circuit(page)).wires).toHaveLength(1);

  // Esc cancels click-to-place.
  await page.getByTestId('palette-AND').click();
  await page.keyboard.press('Escape');
  const p = await toScreen(page, 300, 200);
  await page.mouse.click(p.x, p.y);
  expect((await circuit(page)).components.filter((c) => c.type === 'AND')).toHaveLength(0);

  // Select and delete the probe: its wire goes too.
  const lp = await toScreen(page, 200, 60);
  await page.mouse.click(lp.x + 4, lp.y);
  await page.keyboard.press('Delete');
  const c = await circuit(page);
  expect(c.components.map((x) => x.id)).not.toContain(lamp);
  expect(c.wires).toHaveLength(0);
});

test('branching a wire creates a junction dot (T-connection)', async ({ page }) => {
  await place(page, 'INPUT', 40, 60);
  await place(page, 'OUTPUT', 260, 60);
  await place(page, 'OUTPUT', 260, 140);
  await wire(page, 'in1.OUT', 'out1.IN');
  // Drag from the middle of the existing wire to the second probe.
  const mid = await toScreen(page, 150, 60);
  const target = await pinScreen(page, 'out2.IN');
  await page.mouse.move(mid.x, mid.y);
  await page.mouse.down();
  await page.mouse.move(mid.x, mid.y + 30, { steps: 5 });
  await page.mouse.move(target.x, target.y, { steps: 5 });
  await page.mouse.up();
  const c = await circuit(page);
  expect(c.junctions).toHaveLength(1);
  expect(c.wires).toHaveLength(3);
  await page.keyboard.press('1');
  const values = await page.evaluate(() => [...window.__openbench!.session.result.pins.entries()].filter(([k]) => k.endsWith('.IN')));
  expect(Object.fromEntries(values)).toEqual({ 'out1.IN': 1, 'out2.IN': 1 });
});
