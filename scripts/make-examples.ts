/**
 * Regenerates examples/*.openbench.json and docs/project.schema.json from the core package,
 * so the shipped examples are always valid for the current file format.
 *   npx tsx scripts/make-examples.ts
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Session, projectJsonSchema, serializeCircuit } from '../packages/core/src/index.ts';
import type { EditCommand } from '../packages/core/src/index.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function build(title: string, cmds: EditCommand[]): string {
  const s = new Session();
  s.edit({ type: 'setTitle', title });
  for (const c of cmds) s.edit(c);
  return serializeCircuit({ ...s.circuit, viewport: { x: 20, y: 20, zoom: 1.5 } });
}

const gateLab = (gate: 'AND' | 'XOR', title: string): string => {
  const g = `${gate.toLowerCase()}1`;
  return build(title, [
    { type: 'addComponent', componentType: 'WORD_GENERATOR', x: 40, y: 20 },
    { type: 'addComponent', componentType: gate, x: 140, y: 120 },
    { type: 'addComponent', componentType: 'OUTPUT', x: 240, y: 120, label: 'Y' },
    { type: 'addComponent', componentType: 'LOGIC_ANALYZER', x: 320, y: 20 },
    { type: 'connect', a: 'wg.D0', b: `${g}.A` },
    { type: 'connect', a: 'wg.D1', b: `${g}.B` },
    { type: 'connect', a: `${g}.OUT`, b: 'out1.IN' },
    { type: 'attachAnalyzerChannel', channel: 0, target: `${g}.OUT` },
    { type: 'attachAnalyzerChannel', channel: 1, target: 'wg.D0' },
    { type: 'attachAnalyzerChannel', channel: 2, target: 'wg.D1' },
    { type: 'configureAnalyzer', channels: [{ index: 0, label: 'Y' }, { index: 1, label: 'A = D0' }, { index: 2, label: 'B = D1' }] },
    { type: 'setWords', words: [0x0000, 0x0001, 0x0002, 0x0003] },
  ]);
};

writeFileSync(join(root, 'examples', 'and-test.openbench.json'), gateLab('AND', 'Лабораторная 1: элемент И'));
writeFileSync(join(root, 'examples', 'xor-test.openbench.json'), gateLab('XOR', 'Лабораторная 2: исключающее ИЛИ'));

// RS latch on NAND gates with two switches, as in classic lab handouts.
writeFileSync(
  join(root, 'examples', 'rs-latch.openbench.json'),
  build('RS-триггер на элементах И-НЕ', [
    { type: 'addComponent', componentType: 'INPUT', x: 60, y: 110, label: 'S̄', key: '1' },
    { type: 'addComponent', componentType: 'INPUT', x: 60, y: 220, label: 'R̄', key: '2' },
    { type: 'addComponent', componentType: 'NAND', x: 220, y: 110 },
    { type: 'addComponent', componentType: 'NAND', x: 220, y: 220 },
    { type: 'addComponent', componentType: 'OUTPUT', x: 340, y: 110, label: 'Q' },
    { type: 'addComponent', componentType: 'OUTPUT', x: 340, y: 220, label: 'Q̄' },
    { type: 'connect', a: 'in1.OUT', b: 'nand1.A' },
    { type: 'connect', a: 'in2.OUT', b: 'nand2.B' },
    { type: 'connect', a: 'nand1.OUT', b: 'out1.IN' },
    { type: 'connect', a: 'nand2.OUT', b: 'out2.IN' },
    { type: 'connect', a: 'nand1.OUT', b: 'nand2.A' },
    { type: 'connect', a: 'nand2.OUT', b: 'nand1.B' },
  ]),
);

writeFileSync(join(root, 'docs', 'project.schema.json'), JSON.stringify(projectJsonSchema(), null, 2) + '\n');
console.log('examples and schema written');
