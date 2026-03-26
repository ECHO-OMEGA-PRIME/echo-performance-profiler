DROP TABLE IF EXISTS metrics;
DROP TABLE IF EXISTS aggregated_metrics;
DROP TABLE IF EXISTS performance_alerts;
DROP TABLE IF EXISTS baselines;
DROP TABLE IF EXISTS profiling_sessions;

CREATE TABLE metrics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  service_name TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  method TEXT NOT NULL DEFAULT 'GET',
  status_code INTEGER NOT NULL DEFAULT 200,
  latency_ms REAL NOT NULL,
  cpu_time_ms REAL,
  memory_mb REAL,
  request_size INTEGER,
  response_size INTEGER,
  region TEXT,
  recorded_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_metrics_service ON metrics(service_name);
CREATE INDEX idx_metrics_recorded ON metrics(recorded_at);
CREATE INDEX idx_metrics_service_endpoint ON metrics(service_name, endpoint);
CREATE INDEX idx_metrics_service_recorded ON metrics(service_name, recorded_at);

CREATE TABLE aggregated_metrics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  service_name TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  period TEXT NOT NULL CHECK(period IN ('5min', 'hour', 'day')),
  avg_latency REAL NOT NULL,
  p50_latency REAL,
  p95_latency REAL,
  p99_latency REAL,
  min_latency REAL,
  max_latency REAL,
  request_count INTEGER NOT NULL DEFAULT 0,
  error_count INTEGER NOT NULL DEFAULT 0,
  error_rate REAL NOT NULL DEFAULT 0.0,
  throughput REAL NOT NULL DEFAULT 0.0,
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL
);

CREATE INDEX idx_agg_service ON aggregated_metrics(service_name);
CREATE INDEX idx_agg_period ON aggregated_metrics(period);
CREATE INDEX idx_agg_period_start ON aggregated_metrics(period_start);
CREATE INDEX idx_agg_service_period ON aggregated_metrics(service_name, period, period_start);

CREATE TABLE performance_alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  service_name TEXT NOT NULL,
  endpoint TEXT,
  alert_type TEXT NOT NULL CHECK(alert_type IN ('latency', 'error_rate', 'throughput')),
  severity TEXT NOT NULL DEFAULT 'warning' CHECK(severity IN ('info', 'warning', 'critical')),
  threshold REAL NOT NULL,
  actual_value REAL NOT NULL,
  message TEXT NOT NULL,
  resolved INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at TEXT
);

CREATE INDEX idx_alerts_resolved ON performance_alerts(resolved);
CREATE INDEX idx_alerts_service ON performance_alerts(service_name);
CREATE INDEX idx_alerts_created ON performance_alerts(created_at);

CREATE TABLE baselines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  service_name TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  baseline_latency REAL NOT NULL,
  baseline_error_rate REAL NOT NULL DEFAULT 0.0,
  baseline_throughput REAL NOT NULL DEFAULT 0.0,
  sample_count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(service_name, endpoint)
);

CREATE INDEX idx_baselines_service ON baselines(service_name);

CREATE TABLE profiling_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  service_name TEXT NOT NULL,
  session_type TEXT NOT NULL DEFAULT 'standard',
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT,
  results TEXT,
  status TEXT NOT NULL DEFAULT 'running' CHECK(status IN ('running', 'completed', 'failed'))
);

CREATE INDEX idx_profiling_service ON profiling_sessions(service_name);
CREATE INDEX idx_profiling_status ON profiling_sessions(status);
