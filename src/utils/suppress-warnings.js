/**
 * Global Warning Filter
 * Intercepts and suppresses benign Node.js runtime ExperimentalWarnings
 * before third-party dependencies (like discord.js or undici) load.
 */

process.on('warning', (warning) => {
  if (warning.name === 'ExperimentalWarning') return;
  console.warn(warning);
});
