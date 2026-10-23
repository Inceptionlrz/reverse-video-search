// engine_health 仓储：引擎级熔断与限频计数。
export function createEngineHealthRepo(db) {
  return {
    async ensure(provider, defaults = {}) {
      const row = await db.get('SELECT * FROM engine_health WHERE provider = ?', [provider]);
      if (row) return row;
      await db.run(
        `INSERT INTO engine_health (provider, enabled, consecutive_failures, circuit_until_ms,
           last_success_ms, last_failure_ms, last_error_code)
         VALUES (?, ?, 0, NULL, NULL, NULL, NULL)`,
        [provider, defaults.enabled === false ? 0 : 1],
      );
      return db.get('SELECT * FROM engine_health WHERE provider = ?', [provider]);
    },

    async list() {
      return db.all('SELECT * FROM engine_health ORDER BY provider ASC');
    },

    async get(provider) {
      return db.get('SELECT * FROM engine_health WHERE provider = ?', [provider]);
    },

    async setEnabled(provider, enabled) {
      await this.ensure(provider);
      const res = await db.run('UPDATE engine_health SET enabled = ? WHERE provider = ?', [
        enabled ? 1 : 0,
        provider,
      ]);
      return res.changes;
    },

    async recordSuccess(provider) {
      await this.ensure(provider);
      await db.run(
        `UPDATE engine_health SET consecutive_failures = 0, circuit_until_ms = NULL,
         last_success_ms = ?, last_error_code = NULL WHERE provider = ?`,
        [Date.now(), provider],
      );
    },

    async recordFailure(provider, errorCode, circuitUntilMs = null) {
      await this.ensure(provider);
      await db.run(
        `UPDATE engine_health SET consecutive_failures = consecutive_failures + 1,
         last_failure_ms = ?, last_error_code = ?, circuit_until_ms = COALESCE(?, circuit_until_ms)
         WHERE provider = ?`,
        [Date.now(), errorCode ?? null, circuitUntilMs, provider],
      );
    },

    async resetCircuit(provider) {
      await this.ensure(provider);
      await db.run(
        'UPDATE engine_health SET consecutive_failures = 0, circuit_until_ms = NULL WHERE provider = ?',
        [provider],
      );
    },
  };
}
