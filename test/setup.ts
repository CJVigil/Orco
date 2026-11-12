// Tests run with the scope gate (#108) off for new projects; test/scope.test.ts turns it on.
process.env.ORCO_SCOPE_GATE ??= 'off';

// ORCO_TEST_DATABASE_URL=postgres://… or mongodb://… runs the whole suite on that database (#148).
if (process.env.ORCO_TEST_DATABASE_URL) {
  const { setTestDatabaseHook } = await import('../src/db.js');
  const { openScratch } = await import('../src/storage/open.js');
  setTestDatabaseHook(openScratch);
}
