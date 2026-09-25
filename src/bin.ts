#!/usr/bin/env node
import { runCli } from './cli.js';

const code = await runCli(process.argv.slice(2));
process.exitCode = code;
// Pooled HTTP connections (Freestyle SDK, AWS SDK) can keep the event loop
// alive; exit as soon as stdout and stderr have been flushed.
process.stdout.write('', () => process.stderr.write('', () => process.exit(code)));
