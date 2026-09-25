#!/usr/bin/env node
import { runCli } from './cli.js';

// A reader that closes early (`freestyle-volumes list | head -1`) is not an error.
for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'EPIPE') process.exit(process.exitCode ?? 0);
    throw error;
  });
}

const code = await runCli(process.argv.slice(2));
process.exitCode = code;
// Pooled HTTP connections (Freestyle SDK, AWS SDK) can keep the event loop
// alive; exit as soon as stdout and stderr have been flushed.
process.stdout.write('', () => process.stderr.write('', () => process.exit(code)));
