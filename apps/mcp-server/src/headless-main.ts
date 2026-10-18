#!/usr/bin/env node
import { join } from 'node:path';
import { homedir } from 'node:os';
import { Session } from '@openbench/core';
import { discoveryPath } from './discovery.js';
import { HeadlessHost } from './headless-host.js';

/**
 * Headless OpenBench engine for CI and scripted labs: provides the same bridge as the
 * desktop window, without a GUI. Do not run it together with the desktop app — both use
 * the same discovery file and the last one started wins.
 */
const workspace = process.env.OPENBENCH_WORKSPACE ?? join(homedir(), 'Documents', 'OpenBench');
const host = new HeadlessHost(new Session(), workspace, discoveryPath());
const info = await host.start(Number(process.env.OPENBENCH_BRIDGE_PORT ?? 0));
process.stderr.write(`openbench-headless: listening on 127.0.0.1:${info.port}, workspace ${workspace}\n`);
const stop = () => void host.stop().finally(() => process.exit(0));
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
