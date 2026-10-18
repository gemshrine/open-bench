// Scenario 4 (GUI ⇄ MCP synchronisation) against the REAL desktop app.
//
// Prerequisites (Windows, WebView2):
//   1. npm run build -w @openbench/mcp-server
//   2. start OpenBench with remote debugging of its webview, e.g. in PowerShell:
//        $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=9333"
//        npm run tauri dev        (or start the built openbench.exe)
//   3. node apps/desktop/e2e-tauri/sync-check.mjs
//
// The script talks to the app exactly like a user and an AI client would: MCP calls go through
// the bundled stdio MCP server and the loopback bridge; GUI actions are real input events
// delivered to the app's webview over the Chrome DevTools Protocol.

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const cdp = process.env.OPENBENCH_CDP ?? 'http://127.0.0.1:9333';
const server = fileURLToPath(new URL('../../mcp-server/dist/openbench-mcp.mjs', import.meta.url));

const transport = new StdioClientTransport({ command: process.execPath, args: [server], env: { ...process.env }, stderr: 'inherit' });
const mcp = new Client({ name: 'openbench-sync-check', version: '1.0.0' });
await mcp.connect(transport);
const call = async (name, args = {}) => {
  const r = await mcp.callTool({ name, arguments: args });
  if (r.isError) throw new Error(`${name}: ${r.content[0].text}`);
  return r.structuredContent;
};

const browser = await chromium.connectOverCDP(cdp);
const page = browser.contexts()[0].pages().find((p) => p.url().includes('localhost') || p.url().includes('127.0.0.1') || p.url().startsWith('tauri'));
assert.ok(page, 'OpenBench webview not found over CDP');

// 1. MCP builds a circuit → it appears in the GUI.
await call('new_project', { title: 'Синхронизация' });
await call('add_component', { type: 'INPUT', x: 40, y: 60, id: 'sw', label: 'a' });
await call('add_component', { type: 'NOT', x: 140, y: 60 });
await call('add_component', { type: 'OUTPUT', x: 240, y: 60, id: 'lamp' });
await call('connect_pins', { from: 'sw.OUT', to: 'not1.A' });
await call('connect_pins', { from: 'not1.OUT', to: 'lamp.IN' });
await page.locator('[data-component="not1"]').waitFor();
assert.equal(await page.locator('[data-component]').count(), 3, 'GUI shows the 3 components added over MCP');
assert.equal(await page.locator('polyline[data-wire]').count(), 2, 'GUI shows the 2 wires added over MCP');
let v = (await call('get_signal_values', { ids: ['sw', 'lamp'] })).values;
assert.deepEqual(v, { sw: 0, lamp: 1 });

// 2. The user flips the switch in the GUI (select it, press its key [1]) → MCP sees it.
// Hit-testing is done by canvas coordinates: click on the body of the switch (40..80, 60..80).
const at = await page.evaluate(() => window.__openbench.toScreen({ x: 60, y: 70 }));
await page.mouse.click(at.x, at.y);
await page.keyboard.press('1');
v = (await call('get_signal_values', { ids: ['sw', 'lamp'] })).values;
assert.deepEqual(v, { sw: 1, lamp: 0 });

// 3. The user toggles it back with the Properties button.
await page.getByTestId('toggle-input').click();
v = (await call('get_signal_values', { ids: ['sw', 'lamp'] })).values;
assert.deepEqual(v, { sw: 0, lamp: 1 });

const probeFill = await page.locator('[data-component="lamp"] circle').getAttribute('fill');
assert.equal(probeFill, '#ff7c7c', 'probe is lit in the GUI');

console.log('sync-check: OK — MCP edits are visible in the GUI and GUI input changes are visible over MCP');
await mcp.close();
await browser.close().catch(() => undefined);
