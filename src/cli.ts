#!/usr/bin/env node
const emitWarning = process.emitWarning.bind(process);
process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
  const text = typeof warning === 'string' ? warning : warning.message;
  if (text.includes('SQLite is an experimental feature')) return;
  (emitWarning as (...args: unknown[]) => void)(warning, ...rest);
}) as typeof process.emitWarning;

const { main } = await import('./commands.js');
const { OrcoError } = await import('./store.js');

try {
  main();
} catch (err) {
  if (err instanceof OrcoError) {
    console.error(err.message);
    process.exitCode = 1;
  } else {
    throw err;
  }
}
