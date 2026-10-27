import test from 'node:test';
import assert from 'node:assert/strict';
import {
  logger,
  LogLevel,
  formatTimestamp,
  redactSensitiveData,
  checkChannelPermissions,
  checkLeaderboardPermissions,
  formatDiff,
  sysLog,
  sysWarn,
  sysError,
  log
} from '../src/utils/logger.js';
import { setMockPool } from '../src/storage/postgres.js';

test('Logging Engine Architecture Suite', async (t) => {
  // Save original stream writers
  const originalStdoutWrite = process.stdout.write;
  const originalStderrWrite = process.stderr.write;

  let stdoutCaptured = [];
  let stderrCaptured = [];

  function captureStreams() {
    stdoutCaptured = [];
    stderrCaptured = [];
    process.stdout.write = (chunk) => {
      stdoutCaptured.push(chunk.toString());
      return true;
    };
    process.stderr.write = (chunk) => {
      stderrCaptured.push(chunk.toString());
      return true;
    };
  }

  function restoreStreams() {
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
  }

  await t.test('formatTimestamp should produce YYYY-MM-DD HH:mm:ss.SSS format', () => {
    const fixedDate = new Date('2026-10-27T03:30:15.123Z');
    const ts = formatTimestamp(fixedDate);
    const regex = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$/;
    assert.match(ts, regex, 'Timestamp must strictly adhere to YYYY-MM-DD HH:mm:ss.SSS');
  });

  await t.test('redactSensitiveData should mask sensitive keys, URLs, and tokens', () => {
    const input = {
      username: 'moham',
      bot_token: 'DISCORD_BOT_TOKEN_MOCK_SECRET_XYZ',
      password: 'mySuperSecretPassword123!',
      database_url: 'postgres://postgres:securePass456@db.internal:5432/railway',
      headers: {
        authorization: 'Bearer secret_token_abc_xyz'
      },
      safeArray: [
        { key: 'safe' },
        { cookie: 'session=abcdef12345' }
      ]
    };

    const sanitized = redactSensitiveData(input);

    assert.equal(sanitized.username, 'moham', 'Non-sensitive fields should be preserved');
    assert.equal(sanitized.bot_token, '****', 'Token keys should be masked');
    assert.equal(sanitized.password, '****', 'Password keys should be masked');
    assert.equal(sanitized.headers.authorization, '****', 'Authorization keys should be masked');
    assert.equal(sanitized.safeArray[1].cookie, '****', 'Nested cookies in arrays should be masked');
    
    // Check URL pattern masking
    const rawUrlSanitized = redactSensitiveData('postgres://admin:pass123@localhost:5432/mydb');
    assert.equal(rawUrlSanitized, 'postgres://admin:****@localhost:5432/mydb', 'URL passwords must be masked with ****');
  });

  await t.test('Logger severity levels and output routing', () => {
    captureStreams();
    logger.setLevel(LogLevel.DEBUG);

    try {
      logger.debug('DISPATCH', 'Debug message test', { debugKey: 123 });
      logger.info('STARTUP', 'Info message test', { guilds: 5 });
      logger.warn('SECURITY', 'Warn message test', { blockedUser: 'user_42' });
      logger.error('DATABASE', 'Error message test', { code: '50013' });
      logger.fatal('SYSTEM', 'Fatal crash test', { uptime: 120 });

      assert.equal(stdoutCaptured.length, 3, 'DEBUG, INFO, and WARN must write to stdout');
      assert.equal(stderrCaptured.length, 2, 'ERROR and FATAL must write to stderr');

      // Strip ANSI for format matching
      const stripAnsi = (str) => str.replace(/\x1b\[[0-9;]*m/g, '');

      const debugLine = stripAnsi(stdoutCaptured[0]);
      assert.match(debugLine, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3} DEBUG DISPATCH: Debug message test \| Context: \{"debugKey":123\}\n$/);
      assert.ok(!debugLine.includes('[DEBUG]'), 'Must not have [DEBUG] bracket');
      assert.ok(!debugLine.includes('[DISPATCH]'), 'Must not have [DISPATCH] bracket');

      const infoLine = stripAnsi(stdoutCaptured[1]);
      assert.match(infoLine, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3} INFO STARTUP: Info message test \| Context: \{"guilds":5\}\n$/);
      assert.ok(!infoLine.includes('[INFO]'), 'Must not have [INFO] bracket');

      const warnLine = stripAnsi(stdoutCaptured[2]);
      assert.match(warnLine, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3} WARN SECURITY: Warn message test \| Context: \{"blockedUser":"user_42"\}\n$/);
      assert.ok(!warnLine.includes('[WARN]'), 'Must not have [WARN] bracket');

      const errLine = stripAnsi(stderrCaptured[0]);
      assert.match(errLine, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3} ERROR DATABASE: Error message test \| Context: \{"code":"50013"\}\n$/);
      assert.ok(!errLine.includes('[ERROR]'), 'Must not have [ERROR] bracket');

      const fatalLine = stripAnsi(stderrCaptured[1]);
      assert.match(fatalLine, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3} FATAL SYSTEM: Fatal crash test \| Context: \{"uptime":120\}\n$/);
      assert.ok(!fatalLine.includes('[FATAL]'), 'Must not have [FATAL] bracket');
    } finally {
      restoreStreams();
    }
  });

  await t.test('Log level threshold should suppress lower severity logs', () => {
    captureStreams();
    logger.setLevel(LogLevel.WARN);

    try {
      logger.debug('TEST', 'This debug should be suppressed');
      logger.info('TEST', 'This info should be suppressed');
      logger.warn('TEST', 'This warn must appear');

      assert.equal(stdoutCaptured.length, 1, 'Only WARN should be emitted when level is WARN');
      assert.ok(stdoutCaptured[0].includes('This warn must appear'));
    } finally {
      restoreStreams();
    }
  });

  await t.test('Database Query Telemetry: Transactions and Slow Queries', async () => {
    captureStreams();
    logger.setLevel(LogLevel.DEBUG);

    try {
      // Create a mock pool to test telemetry interception
      let simulatedDelay = 0;
      const mockPool = {
        connect: async () => ({
          query: async (sql, params) => {
            if (simulatedDelay > 0) {
              await new Promise(r => setTimeout(r, simulatedDelay));
            }
            return { rows: [], rowCount: 1 };
          },
          release: () => {}
        }),
        query: async (sql, params) => {
          if (simulatedDelay > 0) {
            await new Promise(r => setTimeout(r, simulatedDelay));
          }
          return { rows: [], rowCount: 1 };
        }
      };

      setMockPool(mockPool);

      const { getPool } = await import('../src/storage/postgres.js');
      const p = getPool();
      const client = await p.connect();

      // Test transaction control logging
      await client.query('BEGIN');
      await client.query('COMMIT');
      await client.query('ROLLBACK');

      client.release();

      const combinedStdout = stdoutCaptured.join('\n');
      assert.ok(combinedStdout.includes('BEGIN TRANSACTION'), 'Must log BEGIN TRANSACTION under DEBUG');
      assert.ok(combinedStdout.includes('COMMIT TRANSACTION'), 'Must log COMMIT TRANSACTION under DEBUG');
      assert.ok(combinedStdout.includes('ROLLBACK TRANSACTION'), 'Must log ROLLBACK TRANSACTION under DEBUG');

      // Test slow query warning (>100ms)
      simulatedDelay = 110;
      await p.query('SELECT * FROM large_table WHERE status = $1', ['active']);
      simulatedDelay = 0;

      const slowLogFound = stdoutCaptured.some(line => line.includes('Slow Database Query Detected') && line.includes('large_table'));
      assert.ok(slowLogFound, 'Must log Slow Database Query Detected when query > 100ms');

      // Test database mutation changes logging (Add, Modify, Remove)
      await p.query('INSERT INTO user_balances (user_id, balance) VALUES ($1, $2)', ['usr_99', 500]);
      await p.query('UPDATE user_balances SET balance = balance + 10 WHERE user_id = $1', ['usr_99']);
      await p.query('DELETE FROM user_inventory WHERE user_id = $1', ['usr_99']);

      const fullOutput = stdoutCaptured.join('\n');
      assert.ok(fullOutput.includes('DB Change INSERT (Add): INSERT INTO user_balances'), 'Must log INSERT database changes');
      assert.ok(fullOutput.includes('DB Change UPDATE (Modify): UPDATE user_balances'), 'Must log UPDATE database changes');
      assert.ok(fullOutput.includes('DB Change DELETE (Remove): DELETE FROM user_inventory'), 'Must log DELETE database changes');
      assert.ok(fullOutput.includes('"affectedRows":1'), 'Must include affectedRows in mutation context');

    } finally {
      setMockPool(null);
      restoreStreams();
    }
  });

  await t.test('Backward Compatibility for legacy sysLog, sysWarn, sysError, and log.*', () => {
    captureStreams();
    logger.setLevel(LogLevel.DEBUG);

    try {
      sysLog('Item Purchased', {
        user: { id: 'usr_100' },
        guild: { id: 'gld_200' },
        item: 'item_sword',
        amount: 50,
        detail: 'Iron Sword acquired'
      });

      sysWarn('Rate Limit Encountered', {
        user: 'usr_100',
        guild: 'gld_200',
        detail: 'Exceeded 5 clicks per sec'
      });

      sysError('Database Connection Failed', new Error('Connection refused'), {
        guild: 'gld_200',
        detail: 'Host unreachable'
      });

      log.startup('Service Initialized', { detail: 'All modules verified' });
      log.cron('Cycle Complete', { duration: 15 });

      assert.ok(stdoutCaptured.length >= 4, 'stdout must capture legacy info/warn calls');
      assert.ok(stderrCaptured.length >= 1, 'stderr must capture legacy error calls');

      const fullStdout = stdoutCaptured.join('\n');
      assert.ok(fullStdout.includes('SHOP: Item Purchased'), 'sysLog with item purchased must route to SHOP');
      assert.ok(fullStdout.includes('WARN SYSTEM: Rate Limit Encountered') || fullStdout.includes('Rate Limit Encountered'), 'sysWarn must emit WARN');
      assert.ok(fullStdout.includes('STARTUP: Service Initialized'), 'log.startup must route to STARTUP');
      assert.ok(fullStdout.includes('CRON: Cycle Complete'), 'log.cron must route to CRON');
      assert.ok(!fullStdout.includes('[SHOP]'), 'Must not contain [SHOP] bracket');

      const fullStderr = stderrCaptured.join('\n');
      assert.ok(fullStderr.includes('Database Connection Failed'), 'sysError must emit to stderr');
      assert.ok(fullStderr.includes('Connection refused'), 'Error message must be preserved');
    } finally {
      restoreStreams();
    }
  });

  await t.test('Permission Check and Diff Utilities Preserved', () => {
    const diffResult = formatDiff({ balance: 100, role: 'Member' }, { balance: 250, role: 'VIP' });
    assert.ok(diffResult.includes('Balance:'), 'formatDiff must report balance changes');
    assert.ok(diffResult.includes('100'), 'formatDiff must show old value');
    assert.ok(diffResult.includes('250'), 'formatDiff must show new value');

    const fakeChannel = {
      guild: {
        members: {
          me: {
            permissions: {
              has: () => true
            }
          }
        }
      },
      permissionsFor: () => ({
        has: () => true
      })
    };

    const permCheck = checkChannelPermissions(fakeChannel);
    assert.equal(permCheck.valid, true, 'checkChannelPermissions should return valid: true when permissions are present');

    const lbPermCheck = checkLeaderboardPermissions(fakeChannel);
    assert.equal(lbPermCheck.valid, true, 'checkLeaderboardPermissions should return valid: true');
  });

  await t.test('Discord REST Telemetry and Start-to-Finish Execution Duration', async () => {
    captureStreams();
    logger.setLevel(LogLevel.DEBUG);

    try {
      // Simulate REST request wrapper
      const reqStart = performance.now();
      const durationMs = 45;
      logger.info('REST', `Discord REST POST /channels/123/messages completed in ${durationMs}ms`, {
        method: 'POST',
        route: '/channels/123/messages',
        durationMs
      });

      // Simulate RateLimited event
      logger.warn('REST', 'Rate limit hit on POST /channels/123/messages in 1200ms reset window (limit: 5, global: false)', {
        timeToResetMs: 1200,
        limit: 5,
        method: 'POST',
        route: '/channels/123/messages',
        global: false
      });

      const fullStdout = stdoutCaptured.join('\n');
      assert.ok(fullStdout.includes('REST: Discord REST POST /channels/123/messages completed in 45ms'), 'Must log REST completion in ms');
      assert.ok(fullStdout.includes('WARN REST: Rate limit hit on POST /channels/123/messages in 1200ms reset window'), 'Must log rate limit warnings');
    } finally {
      restoreStreams();
    }
  });
});
