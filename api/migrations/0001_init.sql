CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  tool TEXT NOT NULL,
  mode TEXT NOT NULL,                -- preview | full
  status TEXT NOT NULL,              -- queued | running | succeeded | failed | cancelled
  progress REAL NOT NULL DEFAULT 0,
  message TEXT,
  input_key TEXT NOT NULL,
  output_key TEXT,
  poster_key TEXT,
  options TEXT NOT NULL,             -- JSON
  provider_job_id TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  estimate_usd REAL NOT NULL DEFAULT 0,
  cost_usd REAL,                     -- measured from provider execution time
  gpu_seconds REAL,
  stats TEXT,                        -- JSON from the engine
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS jobs_created ON jobs (created_at DESC);

CREATE TABLE IF NOT EXISTS uploads (
  key TEXT PRIMARY KEY,
  name TEXT,
  bytes INTEGER,
  duration REAL,
  created_at INTEGER NOT NULL
);
