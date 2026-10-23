-- RVS 建表与索引。字段严格按 docs/SPEC.md 第 5 节，不做自增改造。
-- 本文件由 server/lib/db/migrate.mjs 以 fs 读取，不参与 ESM import 图。

CREATE TABLE IF NOT EXISTS tasks (
  id              TEXT PRIMARY KEY,
  created_at      INTEGER NOT NULL,
  source_type     TEXT NOT NULL DEFAULT 'file',
  source_name     TEXT,
  display_name    TEXT,
  source_path     TEXT,
  source_url      TEXT,
  status          TEXT NOT NULL DEFAULT 'created',
  phase           TEXT NOT NULL DEFAULT 'created',
  duration_ms     INTEGER,
  width           INTEGER,
  height          INTEGER,
  codec           TEXT,
  extract_mode    TEXT NOT NULL DEFAULT 'interval',
  max_frames      INTEGER NOT NULL DEFAULT 12,
  scene_threshold REAL NOT NULL DEFAULT 0.25,
  ffmpeg_error    TEXT,
  created_ms      INTEGER,
  updated_ms      INTEGER,
  frames_done     INTEGER NOT NULL DEFAULT 0,
  analyses_done   INTEGER NOT NULL DEFAULT 0,
  analyses_total  INTEGER NOT NULL DEFAULT 0,
  confirmed       INTEGER NOT NULL DEFAULT 0,
  deleted_at      INTEGER
);

CREATE TABLE IF NOT EXISTS frames (
  id           TEXT PRIMARY KEY,
  task_id      TEXT NOT NULL,
  seq          INTEGER NOT NULL,
  file_name    TEXT,
  file_path    TEXT,
  url_path     TEXT,
  time_ms      INTEGER,
  width        INTEGER,
  height       INTEGER,
  dhash        TEXT,
  dup_group    INTEGER,
  is_duplicate INTEGER NOT NULL DEFAULT 0,
  enabled      INTEGER NOT NULL DEFAULT 1,
  UNIQUE(task_id, seq)
);

CREATE TABLE IF NOT EXISTS analyses (
  id              TEXT PRIMARY KEY,
  task_id         TEXT NOT NULL,
  frame_id        TEXT NOT NULL,
  provider        TEXT NOT NULL,
  attempt_mode    TEXT,
  hit_source      TEXT,
  status          TEXT NOT NULL DEFAULT 'queued',
  error_code      TEXT,
  error_message   TEXT,
  request_url     TEXT,
  http_status     INTEGER,
  latency_ms      INTEGER,
  started_ms      INTEGER,
  finished_ms     INTEGER,
  degradation_log TEXT,
  manual_path     TEXT,
  manual_url      TEXT,
  created_ms      INTEGER,
  UNIQUE(frame_id, provider)
);

CREATE TABLE IF NOT EXISTS results (
  id                    TEXT PRIMARY KEY,
  url                   TEXT NOT NULL,
  canonical_url         TEXT NOT NULL UNIQUE,
  domain                TEXT,
  title                 TEXT,
  provider              TEXT,
  rank                  INTEGER,
  score_basis           TEXT NOT NULL DEFAULT 'none',
  local_hash_similarity REAL,
  sort_score            REAL,
  thumb_url             TEXT,
  thumb_local_path      TEXT,
  thumb_status          TEXT NOT NULL DEFAULT 'remote',
  discovered_ms         INTEGER
);

CREATE TABLE IF NOT EXISTS result_hits (
  id                    TEXT PRIMARY KEY,
  result_id             TEXT NOT NULL,
  analysis_id           TEXT NOT NULL,
  frame_id              TEXT,
  task_id               TEXT,
  provider              TEXT,
  rank                  INTEGER,
  score_basis           TEXT NOT NULL DEFAULT 'none',
  local_hash_similarity REAL,
  sort_score            REAL,
  UNIQUE(analysis_id, rank)
);

CREATE TABLE IF NOT EXISTS engine_health (
  provider             TEXT PRIMARY KEY,
  enabled              INTEGER NOT NULL DEFAULT 1,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  circuit_until_ms     INTEGER,
  last_success_ms      INTEGER,
  last_failure_ms      INTEGER,
  last_error_code      TEXT
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_frames_task ON frames(task_id);
CREATE INDEX IF NOT EXISTS idx_analyses_task ON analyses(task_id);
CREATE INDEX IF NOT EXISTS idx_analyses_frame ON analyses(frame_id);
CREATE INDEX IF NOT EXISTS idx_analyses_status ON analyses(status);
CREATE INDEX IF NOT EXISTS idx_hits_result ON result_hits(result_id);
CREATE INDEX IF NOT EXISTS idx_hits_task ON result_hits(task_id);
CREATE INDEX IF NOT EXISTS idx_results_sort ON results(sort_score);
CREATE INDEX IF NOT EXISTS idx_tasks_updated ON tasks(updated_ms);
