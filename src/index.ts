import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { Env, MetricInput, MetricRecord, AggregatedMetric, PerformanceAlert, Baseline, ProfilingSession, ServiceSummary, LatencyDistribution, DashboardData } from './types';
import { ok, err, authenticate, percentile, stddev, round, ago, floorToInterval, getCache, setCache } from './utils';
import { logger } from './logger';

const ALLOWED_ORIGINS = ['https://echo-ept.com','https://www.echo-ept.com','https://echo-op.com','https://profinishusa.com','https://bgat.echo-op.com'];

type HonoEnv = { Bindings: Env };

const app = new Hono<HonoEnv>();

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------
app.use('*', cors({ origin: (o) => ALLOWED_ORIGINS.includes(o) ? o : ALLOWED_ORIGINS[0], allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'], allowHeaders: ['Content-Type', 'X-Echo-API-Key'] }));

// Security headers middleware
app.use('*', async (c, next) => {
  await next();
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('X-Frame-Options', 'DENY');
  c.header('X-XSS-Protection', '1; mode=block');
  c.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  c.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  c.header('Referrer-Policy', 'strict-origin-when-cross-origin');
});

// Auth middleware — skip /health
app.use('*', async (c, next) => {
  if (c.req.path === '/' || c.req.path === '/health') return next();
  if (!authenticate(c.req.header('X-Echo-API-Key') ?? null, c.env.ECHO_API_KEY)) {
    return c.json(err('Unauthorized — provide X-Echo-API-Key header'), 401);
  }
  return next();
});

// ---------------------------------------------------------------------------
// 1. GET /health
// ---------------------------------------------------------------------------
app.get("/", (c) => c.json({ service: 'echo-performance-profiler', status: 'operational' }));

app.get('/health', async (c) => {
  const start = Date.now();
  let dbStatus = 'ok';
  try {
    await c.env.DB.prepare('SELECT 1').first();
  } catch {
    dbStatus = 'error';
  }
  return c.json({
    status: 'operational',
    service: 'echo-performance-profiler',
    version: '1.0.0',
    timestamp: new Date().toISOString(),
    uptime_check_ms: Date.now() - start,
    dependencies: { d1: dbStatus, kv: 'ok' },
  });
});

// ---------------------------------------------------------------------------
// 2. GET /stats
// ---------------------------------------------------------------------------
app.get('/stats', async (c) => {
  const [totalRow, servicesRow, alertsRow, latencyRow] = await Promise.all([
    c.env.DB.prepare('SELECT COUNT(*) as cnt FROM metrics').first<{ cnt: number }>(),
    c.env.DB.prepare('SELECT COUNT(DISTINCT service_name) as cnt FROM metrics').first<{ cnt: number }>(),
    c.env.DB.prepare('SELECT COUNT(*) as cnt FROM performance_alerts WHERE resolved = 0').first<{ cnt: number }>(),
    c.env.DB.prepare('SELECT AVG(latency_ms) as avg_lat FROM metrics WHERE recorded_at > ?').bind(ago(1440)).first<{ avg_lat: number | null }>(),
  ]);
  return c.json(ok({
    total_metrics: totalRow?.cnt ?? 0,
    services_tracked: servicesRow?.cnt ?? 0,
    active_alerts: alertsRow?.cnt ?? 0,
    avg_system_latency_ms: round(latencyRow?.avg_lat ?? 0),
  }));
});

// ---------------------------------------------------------------------------
// 3. POST /metrics — record single metric
// ---------------------------------------------------------------------------
app.post('/metrics', async (c) => {
  let body: MetricInput;
  try {
    body = await c.req.json<MetricInput>();
  } catch {
    return c.json(err('Invalid JSON body'), 400);
  }
  if (!body.service_name || !body.endpoint || body.latency_ms == null) {
    return c.json(err('Required fields: service_name, endpoint, latency_ms'), 400);
  }
  const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
  await c.env.DB.prepare(
    `INSERT INTO metrics (service_name, endpoint, method, status_code, latency_ms, cpu_time_ms, memory_mb, request_size, response_size, region, recorded_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    body.service_name, body.endpoint, body.method ?? 'GET', body.status_code ?? 200,
    body.latency_ms, body.cpu_time_ms ?? null, body.memory_mb ?? null,
    body.request_size ?? null, body.response_size ?? null, body.region ?? null, now
  ).run();
  logger.info('Metric recorded', { service: body.service_name, endpoint: body.endpoint, latency_ms: body.latency_ms });
  return c.json(ok({ recorded: true }), 201);
});

// ---------------------------------------------------------------------------
// 4. POST /metrics/batch — batch record
// ---------------------------------------------------------------------------
app.post('/metrics/batch', async (c) => {
  let body: { metrics: MetricInput[] };
  try {
    body = await c.req.json<{ metrics: MetricInput[] }>();
  } catch {
    return c.json(err('Invalid JSON body'), 400);
  }
  if (!Array.isArray(body.metrics) || body.metrics.length === 0) {
    return c.json(err('Provide a non-empty "metrics" array'), 400);
  }
  if (body.metrics.length > 1000) {
    return c.json(err('Max 1000 metrics per batch'), 400);
  }
  const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const stmt = c.env.DB.prepare(
    `INSERT INTO metrics (service_name, endpoint, method, status_code, latency_ms, cpu_time_ms, memory_mb, request_size, response_size, region, recorded_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const batch = body.metrics.map((m) =>
    stmt.bind(
      m.service_name, m.endpoint, m.method ?? 'GET', m.status_code ?? 200,
      m.latency_ms, m.cpu_time_ms ?? null, m.memory_mb ?? null,
      m.request_size ?? null, m.response_size ?? null, m.region ?? null, now
    )
  );
  await c.env.DB.batch(batch);
  logger.info('Batch metrics recorded', { count: body.metrics.length });
  return c.json(ok({ recorded: body.metrics.length }), 201);
});

// ---------------------------------------------------------------------------
// 5. GET /metrics — query with filters
// ---------------------------------------------------------------------------
app.get('/metrics', async (c) => {
  const service = c.req.query('service');
  const endpoint = c.req.query('endpoint');
  const from = c.req.query('from');
  const to = c.req.query('to');
  const limit = Math.min(parseInt(c.req.query('limit') ?? '100', 10), 1000);

  let sql = 'SELECT * FROM metrics WHERE 1=1';
  const params: (string | number)[] = [];

  if (service) { sql += ' AND service_name = ?'; params.push(service); }
  if (endpoint) { sql += ' AND endpoint = ?'; params.push(endpoint); }
  if (from) { sql += ' AND recorded_at >= ?'; params.push(from); }
  if (to) { sql += ' AND recorded_at <= ?'; params.push(to); }
  sql += ' ORDER BY recorded_at DESC LIMIT ?';
  params.push(limit);

  const result = await c.env.DB.prepare(sql).bind(...params).all<MetricRecord>();
  return c.json(ok({ metrics: result.results, count: result.results.length }));
});

// ---------------------------------------------------------------------------
// 6. GET /services — list all services with summary
// ---------------------------------------------------------------------------
app.get('/services', async (c) => {
  const result = await c.env.DB.prepare(`
    SELECT service_name,
      COUNT(*) as total_requests,
      AVG(latency_ms) as avg_latency,
      CAST(SUM(CASE WHEN status_code >= 400 THEN 1 ELSE 0 END) AS REAL) / COUNT(*) as error_rate,
      MAX(recorded_at) as last_seen
    FROM metrics
    WHERE recorded_at > ?
    GROUP BY service_name
    ORDER BY total_requests DESC
  `).bind(ago(1440)).all<ServiceSummary>();
  const services = result.results.map((s) => ({
    ...s,
    avg_latency: round(s.avg_latency),
    error_rate: round(s.error_rate, 4),
  }));
  return c.json(ok({ services, count: services.length }));
});

// ---------------------------------------------------------------------------
// 7. GET /services/:name — detailed service profile
// ---------------------------------------------------------------------------
app.get('/services/:name', async (c) => {
  const name = c.req.param('name');
  const [summary, recent, alerts, baseline] = await Promise.all([
    c.env.DB.prepare(`
      SELECT service_name, COUNT(*) as total_requests, AVG(latency_ms) as avg_latency,
        MIN(latency_ms) as min_latency, MAX(latency_ms) as max_latency,
        CAST(SUM(CASE WHEN status_code >= 400 THEN 1 ELSE 0 END) AS REAL) / COUNT(*) as error_rate,
        MIN(recorded_at) as first_seen, MAX(recorded_at) as last_seen
      FROM metrics WHERE service_name = ? AND recorded_at > ?
    `).bind(name, ago(1440)).first(),
    c.env.DB.prepare('SELECT * FROM metrics WHERE service_name = ? ORDER BY recorded_at DESC LIMIT 20').bind(name).all<MetricRecord>(),
    c.env.DB.prepare('SELECT * FROM performance_alerts WHERE service_name = ? AND resolved = 0 ORDER BY created_at DESC LIMIT 10').bind(name).all<PerformanceAlert>(),
    c.env.DB.prepare('SELECT * FROM baselines WHERE service_name = ?').bind(name).all<Baseline>(),
  ]);

  // Compute percentiles from raw data
  const latencies = await c.env.DB.prepare(
    'SELECT latency_ms FROM metrics WHERE service_name = ? AND recorded_at > ? ORDER BY latency_ms'
  ).bind(name, ago(1440)).all<{ latency_ms: number }>();
  const sorted = latencies.results.map((r) => r.latency_ms);

  return c.json(ok({
    service: name,
    summary: summary ? {
      ...summary,
      avg_latency: round((summary as Record<string, number>).avg_latency ?? 0),
      error_rate: round((summary as Record<string, number>).error_rate ?? 0, 4),
    } : null,
    percentiles: {
      p50: round(percentile(sorted, 50)),
      p95: round(percentile(sorted, 95)),
      p99: round(percentile(sorted, 99)),
    },
    recent_metrics: recent.results,
    active_alerts: alerts.results,
    baselines: baseline.results,
  }));
});

// ---------------------------------------------------------------------------
// 8. GET /services/:name/endpoints — endpoint breakdown
// ---------------------------------------------------------------------------
app.get('/services/:name/endpoints', async (c) => {
  const name = c.req.param('name');
  const result = await c.env.DB.prepare(`
    SELECT endpoint, method, COUNT(*) as request_count,
      AVG(latency_ms) as avg_latency, MIN(latency_ms) as min_latency, MAX(latency_ms) as max_latency,
      CAST(SUM(CASE WHEN status_code >= 400 THEN 1 ELSE 0 END) AS REAL) / COUNT(*) as error_rate
    FROM metrics WHERE service_name = ? AND recorded_at > ?
    GROUP BY endpoint, method ORDER BY request_count DESC
  `).bind(name, ago(1440)).all();
  const endpoints = result.results.map((e: Record<string, unknown>) => ({
    ...e,
    avg_latency: round(e.avg_latency as number),
    error_rate: round(e.error_rate as number, 4),
  }));
  return c.json(ok({ service: name, endpoints }));
});

// ---------------------------------------------------------------------------
// 9. GET /services/:name/trends — performance trends
// ---------------------------------------------------------------------------
app.get('/services/:name/trends', async (c) => {
  const name = c.req.param('name');
  const period = c.req.query('period') ?? 'hour';
  const result = await c.env.DB.prepare(`
    SELECT * FROM aggregated_metrics
    WHERE service_name = ? AND period = ?
    ORDER BY period_start DESC LIMIT 48
  `).bind(name, period).all<AggregatedMetric>();
  return c.json(ok({ service: name, period, trends: result.results }));
});

// ---------------------------------------------------------------------------
// 10. GET /latency — latency distribution across all services
// ---------------------------------------------------------------------------
app.get('/latency', async (c) => {
  const result = await c.env.DB.prepare(`
    SELECT service_name, AVG(latency_ms) as avg, MIN(latency_ms) as min, MAX(latency_ms) as max, COUNT(*) as sample_count
    FROM metrics WHERE recorded_at > ?
    GROUP BY service_name ORDER BY avg DESC
  `).bind(ago(1440)).all();

  const distributions: LatencyDistribution[] = [];
  for (const row of result.results) {
    const svc = row as Record<string, unknown>;
    const latencies = await c.env.DB.prepare(
      'SELECT latency_ms FROM metrics WHERE service_name = ? AND recorded_at > ? ORDER BY latency_ms'
    ).bind(svc.service_name as string, ago(1440)).all<{ latency_ms: number }>();
    const sorted = latencies.results.map((r) => r.latency_ms);
    distributions.push({
      service_name: svc.service_name as string,
      avg: round(svc.avg as number),
      p50: round(percentile(sorted, 50)),
      p95: round(percentile(sorted, 95)),
      p99: round(percentile(sorted, 99)),
      min: round(svc.min as number),
      max: round(svc.max as number),
      sample_count: svc.sample_count as number,
    });
  }
  return c.json(ok({ distributions }));
});

// ---------------------------------------------------------------------------
// 11. GET /latency/:service — service-specific latency
// ---------------------------------------------------------------------------
app.get('/latency/:service', async (c) => {
  const name = c.req.param('service');
  const latencies = await c.env.DB.prepare(
    'SELECT latency_ms FROM metrics WHERE service_name = ? AND recorded_at > ? ORDER BY latency_ms'
  ).bind(name, ago(1440)).all<{ latency_ms: number }>();
  const sorted = latencies.results.map((r) => r.latency_ms);
  if (sorted.length === 0) {
    return c.json(ok({ service: name, message: 'No metrics found in last 24h' }));
  }
  const avg = sorted.reduce((a, b) => a + b, 0) / sorted.length;
  return c.json(ok({
    service: name,
    sample_count: sorted.length,
    avg: round(avg),
    p50: round(percentile(sorted, 50)),
    p95: round(percentile(sorted, 95)),
    p99: round(percentile(sorted, 99)),
    min: round(sorted[0]!),
    max: round(sorted[sorted.length - 1]!),
    stddev: round(stddev(sorted, avg)),
  }));
});

// ---------------------------------------------------------------------------
// 12. GET /errors — error rate analysis
// ---------------------------------------------------------------------------
app.get('/errors', async (c) => {
  const result = await c.env.DB.prepare(`
    SELECT service_name, endpoint,
      COUNT(*) as total_requests,
      SUM(CASE WHEN status_code >= 400 THEN 1 ELSE 0 END) as error_count,
      CAST(SUM(CASE WHEN status_code >= 400 THEN 1 ELSE 0 END) AS REAL) / COUNT(*) as error_rate,
      SUM(CASE WHEN status_code >= 500 THEN 1 ELSE 0 END) as server_errors,
      SUM(CASE WHEN status_code >= 400 AND status_code < 500 THEN 1 ELSE 0 END) as client_errors
    FROM metrics WHERE recorded_at > ?
    GROUP BY service_name, endpoint
    HAVING error_count > 0
    ORDER BY error_rate DESC
  `).bind(ago(1440)).all();
  const errors = result.results.map((r: Record<string, unknown>) => ({
    ...r,
    error_rate: round(r.error_rate as number, 4),
  }));
  return c.json(ok({ errors, count: errors.length }));
});

// ---------------------------------------------------------------------------
// 13. GET /throughput — throughput analysis
// ---------------------------------------------------------------------------
app.get('/throughput', async (c) => {
  const result = await c.env.DB.prepare(`
    SELECT service_name,
      COUNT(*) as total_requests,
      COUNT(*) / 1440.0 as avg_rpm,
      MAX(recorded_at) as last_seen,
      AVG(response_size) as avg_response_size
    FROM metrics WHERE recorded_at > ?
    GROUP BY service_name ORDER BY total_requests DESC
  `).bind(ago(1440)).all();
  const throughput = result.results.map((r: Record<string, unknown>) => ({
    ...r,
    avg_rpm: round(r.avg_rpm as number, 4),
    avg_response_size: round(r.avg_response_size as number ?? 0),
  }));
  return c.json(ok({ throughput }));
});

// ---------------------------------------------------------------------------
// 14. GET /alerts — active performance alerts
// ---------------------------------------------------------------------------
app.get('/alerts', async (c) => {
  const showResolved = c.req.query('resolved') === 'true';
  const sql = showResolved
    ? 'SELECT * FROM performance_alerts ORDER BY created_at DESC LIMIT 100'
    : 'SELECT * FROM performance_alerts WHERE resolved = 0 ORDER BY created_at DESC LIMIT 100';
  const result = await c.env.DB.prepare(sql).all<PerformanceAlert>();
  return c.json(ok({ alerts: result.results, count: result.results.length }));
});

// ---------------------------------------------------------------------------
// 15. POST /alerts/:id/resolve
// ---------------------------------------------------------------------------
app.post('/alerts/:id/resolve', async (c) => {
  const id = parseInt(c.req.param('id'), 10);
  if (isNaN(id)) return c.json(err('Invalid alert ID'), 400);
  const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const result = await c.env.DB.prepare(
    'UPDATE performance_alerts SET resolved = 1, resolved_at = ? WHERE id = ? AND resolved = 0'
  ).bind(now, id).run();
  if (!result.meta.changes || result.meta.changes === 0) {
    return c.json(err('Alert not found or already resolved'), 404);
  }
  logger.info('Alert resolved', { alert_id: id });
  return c.json(ok({ resolved: true, alert_id: id }));
});

// ---------------------------------------------------------------------------
// 16. GET /baselines
// ---------------------------------------------------------------------------
app.get('/baselines', async (c) => {
  const result = await c.env.DB.prepare('SELECT * FROM baselines ORDER BY service_name, endpoint').all<Baseline>();
  return c.json(ok({ baselines: result.results, count: result.results.length }));
});

// ---------------------------------------------------------------------------
// 17. POST /baselines/recalculate
// ---------------------------------------------------------------------------
app.post('/baselines/recalculate', async (c) => {
  const count = await recalculateBaselines(c.env.DB);
  logger.info('Baselines recalculated', { count });
  return c.json(ok({ recalculated: count }));
});

// ---------------------------------------------------------------------------
// 18. POST /profile/:service — start profiling session
// ---------------------------------------------------------------------------
app.post('/profile/:service', async (c) => {
  const name = c.req.param('service');
  let body: { session_type?: string } = {};
  try { body = await c.req.json(); } catch { /* use defaults */ }
  const sessionType = body.session_type ?? 'standard';
  const now = new Date().toISOString().replace('T', ' ').slice(0, 19);

  const result = await c.env.DB.prepare(
    'INSERT INTO profiling_sessions (service_name, session_type, started_at, status) VALUES (?, ?, ?, ?)'
  ).bind(name, sessionType, now, 'running').run();

  const sessionId = result.meta.last_row_id;

  // Collect current metrics snapshot for the session
  const snapshot = await c.env.DB.prepare(`
    SELECT endpoint, method, COUNT(*) as request_count,
      AVG(latency_ms) as avg_latency, MIN(latency_ms) as min_latency, MAX(latency_ms) as max_latency,
      CAST(SUM(CASE WHEN status_code >= 400 THEN 1 ELSE 0 END) AS REAL) / COUNT(*) as error_rate
    FROM metrics WHERE service_name = ? AND recorded_at > ?
    GROUP BY endpoint, method
  `).bind(name, ago(60)).all();

  const latencies = await c.env.DB.prepare(
    'SELECT latency_ms FROM metrics WHERE service_name = ? AND recorded_at > ? ORDER BY latency_ms'
  ).bind(name, ago(60)).all<{ latency_ms: number }>();
  const sorted = latencies.results.map((r) => r.latency_ms);

  const results = {
    snapshot_time: now,
    window_minutes: 60,
    endpoints: snapshot.results,
    overall: {
      sample_count: sorted.length,
      avg: sorted.length > 0 ? round(sorted.reduce((a, b) => a + b, 0) / sorted.length) : 0,
      p50: round(percentile(sorted, 50)),
      p95: round(percentile(sorted, 95)),
      p99: round(percentile(sorted, 99)),
    },
  };

  const completedAt = new Date().toISOString().replace('T', ' ').slice(0, 19);
  await c.env.DB.prepare(
    'UPDATE profiling_sessions SET status = ?, completed_at = ?, results = ? WHERE id = ?'
  ).bind('completed', completedAt, JSON.stringify(results), sessionId).run();

  logger.info('Profiling session completed', { session_id: sessionId, service: name });
  return c.json(ok({ session_id: sessionId, service: name, results }), 201);
});

// ---------------------------------------------------------------------------
// 19. GET /profile/:id — get profiling session results
// ---------------------------------------------------------------------------
app.get('/profile/:id', async (c) => {
  const id = parseInt(c.req.param('id'), 10);
  if (isNaN(id)) return c.json(err('Invalid session ID'), 400);
  const session = await c.env.DB.prepare('SELECT * FROM profiling_sessions WHERE id = ?').bind(id).first<ProfilingSession>();
  if (!session) return c.json(err('Profiling session not found'), 404);
  return c.json(ok({
    ...session,
    results: session.results ? JSON.parse(session.results) : null,
  }));
});

// ---------------------------------------------------------------------------
// 20. GET /dashboard — comprehensive performance dashboard
// ---------------------------------------------------------------------------
app.get('/dashboard', async (c) => {
  const cached = await getCache<DashboardData>(c.env.CACHE, 'dashboard');
  if (cached) return c.json(ok(cached));

  const cutoff = ago(1440);
  const [totalSvc, totalMetrics, avgLat, activeAlerts, totalReqs, errRate] = await Promise.all([
    c.env.DB.prepare('SELECT COUNT(DISTINCT service_name) as cnt FROM metrics WHERE recorded_at > ?').bind(cutoff).first<{ cnt: number }>(),
    c.env.DB.prepare('SELECT COUNT(*) as cnt FROM metrics WHERE recorded_at > ?').bind(cutoff).first<{ cnt: number }>(),
    c.env.DB.prepare('SELECT AVG(latency_ms) as val FROM metrics WHERE recorded_at > ?').bind(cutoff).first<{ val: number | null }>(),
    c.env.DB.prepare('SELECT COUNT(*) as cnt FROM performance_alerts WHERE resolved = 0').first<{ cnt: number }>(),
    c.env.DB.prepare('SELECT COUNT(*) as cnt FROM metrics WHERE recorded_at > ?').bind(cutoff).first<{ cnt: number }>(),
    c.env.DB.prepare(`SELECT CAST(SUM(CASE WHEN status_code >= 400 THEN 1 ELSE 0 END) AS REAL) / MAX(COUNT(*), 1) as val FROM metrics WHERE recorded_at > ?`).bind(cutoff).first<{ val: number | null }>(),
  ]);

  const [slowest, errServices, recentAlerts, trend] = await Promise.all([
    c.env.DB.prepare(`
      SELECT service_name, COUNT(*) as total_requests, AVG(latency_ms) as avg_latency,
        CAST(SUM(CASE WHEN status_code >= 400 THEN 1 ELSE 0 END) AS REAL) / COUNT(*) as error_rate,
        MAX(recorded_at) as last_seen
      FROM metrics WHERE recorded_at > ? GROUP BY service_name ORDER BY avg_latency DESC LIMIT 10
    `).bind(cutoff).all<ServiceSummary>(),
    c.env.DB.prepare(`
      SELECT service_name, COUNT(*) as total_requests, AVG(latency_ms) as avg_latency,
        CAST(SUM(CASE WHEN status_code >= 400 THEN 1 ELSE 0 END) AS REAL) / COUNT(*) as error_rate,
        MAX(recorded_at) as last_seen
      FROM metrics WHERE recorded_at > ? GROUP BY service_name HAVING error_rate > 0 ORDER BY error_rate DESC LIMIT 10
    `).bind(cutoff).all<ServiceSummary>(),
    c.env.DB.prepare('SELECT * FROM performance_alerts WHERE resolved = 0 ORDER BY created_at DESC LIMIT 20').all<PerformanceAlert>(),
    c.env.DB.prepare('SELECT * FROM aggregated_metrics WHERE period = ? ORDER BY period_start DESC LIMIT 24').bind('hour').all<AggregatedMetric>(),
  ]);

  const dashboard: DashboardData = {
    overview: {
      total_services: totalSvc?.cnt ?? 0,
      total_metrics_24h: totalMetrics?.cnt ?? 0,
      avg_system_latency: round(avgLat?.val ?? 0),
      active_alerts: activeAlerts?.cnt ?? 0,
      total_requests_24h: totalReqs?.cnt ?? 0,
      overall_error_rate: round(errRate?.val ?? 0, 4),
    },
    top_slowest_services: slowest.results.map((s) => ({ ...s, avg_latency: round(s.avg_latency), error_rate: round(s.error_rate, 4) })),
    top_error_services: errServices.results.map((s) => ({ ...s, avg_latency: round(s.avg_latency), error_rate: round(s.error_rate, 4) })),
    recent_alerts: recentAlerts.results,
    latency_trend: trend.results,
  };

  await setCache(c.env.CACHE, 'dashboard', dashboard, 60);
  return c.json(ok(dashboard));
});

// ---------------------------------------------------------------------------
// 21. GET /report — performance report
// ---------------------------------------------------------------------------
app.get('/report', async (c) => {
  const format = c.req.query('format') ?? 'json';
  const cached = await getCache<Record<string, unknown>>(c.env.CACHE, 'report');
  if (cached && format === 'json') return c.json(ok(cached));

  const cutoff = ago(1440);
  const [services, alertsData, baselinesData] = await Promise.all([
    c.env.DB.prepare(`
      SELECT service_name, COUNT(*) as total_requests, AVG(latency_ms) as avg_latency,
        MIN(latency_ms) as min_latency, MAX(latency_ms) as max_latency,
        CAST(SUM(CASE WHEN status_code >= 400 THEN 1 ELSE 0 END) AS REAL) / COUNT(*) as error_rate
      FROM metrics WHERE recorded_at > ? GROUP BY service_name ORDER BY avg_latency DESC
    `).bind(cutoff).all(),
    c.env.DB.prepare('SELECT * FROM performance_alerts WHERE resolved = 0 ORDER BY severity DESC, created_at DESC').all<PerformanceAlert>(),
    c.env.DB.prepare('SELECT * FROM baselines ORDER BY service_name').all<Baseline>(),
  ]);

  const report = {
    generated_at: new Date().toISOString(),
    period: '24h',
    services: services.results.map((s: Record<string, unknown>) => ({
      ...s,
      avg_latency: round(s.avg_latency as number),
      error_rate: round(s.error_rate as number, 4),
    })),
    active_alerts: alertsData.results,
    baselines: baselinesData.results,
    summary: {
      total_services: services.results.length,
      total_alerts: alertsData.results.length,
      critical_alerts: alertsData.results.filter((a) => a.severity === 'critical').length,
    },
  };

  await setCache(c.env.CACHE, 'report', report, 300);

  if (format === 'text') {
    let text = `=== ECHO Performance Report ===\nGenerated: ${report.generated_at}\nPeriod: ${report.period}\n\n`;
    text += `--- Services (${report.summary.total_services}) ---\n`;
    for (const svc of report.services) {
      const s = svc as Record<string, unknown>;
      text += `  ${s.service_name}: avg=${s.avg_latency}ms, err_rate=${((s.error_rate as number) * 100).toFixed(2)}%, reqs=${s.total_requests}\n`;
    }
    text += `\n--- Active Alerts (${report.summary.total_alerts}) ---\n`;
    for (const a of report.active_alerts) {
      text += `  [${a.severity.toUpperCase()}] ${a.service_name}: ${a.message}\n`;
    }
    return c.text(text);
  }

  return c.json(ok(report));
});

// ---------------------------------------------------------------------------
// Cron handlers
// ---------------------------------------------------------------------------
async function handleCron(cron: string, env: Env): Promise<void> {
  logger.info('Cron triggered', { cron });

  if (cron === '*/5 * * * *') {
    await aggregate5Min(env);
    await checkAnomalies(env);
  } else if (cron === '0 * * * *') {
    await aggregateHourly(env);
    await pruneOldMetrics(env);
  } else if (cron === '0 6 * * *') {
    await aggregateDaily(env);
    await recalculateBaselines(env.DB);
  }
}

async function aggregate5Min(env: Env): Promise<void> {
  const now = new Date();
  const periodEnd = floorToInterval(now, 5);
  const periodStart = new Date(periodEnd.getTime() - 5 * 60 * 1000);
  const startStr = periodStart.toISOString().replace('T', ' ').slice(0, 19);
  const endStr = periodEnd.toISOString().replace('T', ' ').slice(0, 19);

  const groups = await env.DB.prepare(`
    SELECT service_name, endpoint FROM metrics
    WHERE recorded_at >= ? AND recorded_at < ?
    GROUP BY service_name, endpoint
  `).bind(startStr, endStr).all<{ service_name: string; endpoint: string }>();

  for (const group of groups.results) {
    const latencies = await env.DB.prepare(
      'SELECT latency_ms, status_code FROM metrics WHERE service_name = ? AND endpoint = ? AND recorded_at >= ? AND recorded_at < ? ORDER BY latency_ms'
    ).bind(group.service_name, group.endpoint, startStr, endStr).all<{ latency_ms: number; status_code: number }>();

    const sorted = latencies.results.map((r) => r.latency_ms);
    const errorCount = latencies.results.filter((r) => r.status_code >= 400).length;
    const count = sorted.length;
    if (count === 0) continue;

    const avg = sorted.reduce((a, b) => a + b, 0) / count;
    const throughput = count / 5; // per minute

    await env.DB.prepare(`
      INSERT INTO aggregated_metrics (service_name, endpoint, period, avg_latency, p50_latency, p95_latency, p99_latency, min_latency, max_latency, request_count, error_count, error_rate, throughput, period_start, period_end)
      VALUES (?, ?, '5min', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      group.service_name, group.endpoint, round(avg),
      round(percentile(sorted, 50)), round(percentile(sorted, 95)), round(percentile(sorted, 99)),
      round(sorted[0]!), round(sorted[sorted.length - 1]!),
      count, errorCount, round(errorCount / count, 4), round(throughput, 2),
      startStr, endStr
    ).run();
  }
  logger.info('5-min aggregation complete', { groups: groups.results.length });
}

async function aggregateHourly(env: Env): Promise<void> {
  const now = new Date();
  const periodEnd = floorToInterval(now, 60);
  const periodStart = new Date(periodEnd.getTime() - 60 * 60 * 1000);
  const startStr = periodStart.toISOString().replace('T', ' ').slice(0, 19);
  const endStr = periodEnd.toISOString().replace('T', ' ').slice(0, 19);

  const groups = await env.DB.prepare(`
    SELECT service_name, endpoint,
      SUM(request_count) as total_reqs,
      SUM(error_count) as total_errors,
      SUM(avg_latency * request_count) / SUM(request_count) as weighted_avg,
      MIN(min_latency) as min_lat,
      MAX(max_latency) as max_lat,
      SUM(throughput * request_count) / SUM(request_count) as weighted_throughput
    FROM aggregated_metrics
    WHERE period = '5min' AND period_start >= ? AND period_start < ?
    GROUP BY service_name, endpoint
  `).bind(startStr, endStr).all<Record<string, unknown>>();

  for (const g of groups.results) {
    const totalReqs = g.total_reqs as number;
    if (totalReqs === 0) continue;
    const errRate = (g.total_errors as number) / totalReqs;

    // Get p50/p95/p99 from raw metrics for the hour
    const latencies = await env.DB.prepare(
      'SELECT latency_ms FROM metrics WHERE service_name = ? AND endpoint = ? AND recorded_at >= ? AND recorded_at < ? ORDER BY latency_ms'
    ).bind(g.service_name as string, g.endpoint as string, startStr, endStr).all<{ latency_ms: number }>();
    const sorted = latencies.results.map((r) => r.latency_ms);

    await env.DB.prepare(`
      INSERT INTO aggregated_metrics (service_name, endpoint, period, avg_latency, p50_latency, p95_latency, p99_latency, min_latency, max_latency, request_count, error_count, error_rate, throughput, period_start, period_end)
      VALUES (?, ?, 'hour', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      g.service_name as string, g.endpoint as string,
      round(g.weighted_avg as number),
      sorted.length > 0 ? round(percentile(sorted, 50)) : null,
      sorted.length > 0 ? round(percentile(sorted, 95)) : null,
      sorted.length > 0 ? round(percentile(sorted, 99)) : null,
      round(g.min_lat as number), round(g.max_lat as number),
      totalReqs, g.total_errors as number, round(errRate, 4),
      round(g.weighted_throughput as number, 2), startStr, endStr
    ).run();
  }
  logger.info('Hourly aggregation complete', { groups: groups.results.length });
}

async function aggregateDaily(env: Env): Promise<void> {
  const now = new Date();
  const periodEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const periodStart = new Date(periodEnd.getTime() - 24 * 60 * 60 * 1000);
  const startStr = periodStart.toISOString().replace('T', ' ').slice(0, 19);
  const endStr = periodEnd.toISOString().replace('T', ' ').slice(0, 19);

  const groups = await env.DB.prepare(`
    SELECT service_name, endpoint,
      SUM(request_count) as total_reqs,
      SUM(error_count) as total_errors,
      SUM(avg_latency * request_count) / SUM(request_count) as weighted_avg,
      MIN(min_latency) as min_lat,
      MAX(max_latency) as max_lat,
      SUM(throughput * request_count) / SUM(request_count) as weighted_throughput
    FROM aggregated_metrics
    WHERE period = 'hour' AND period_start >= ? AND period_start < ?
    GROUP BY service_name, endpoint
  `).bind(startStr, endStr).all<Record<string, unknown>>();

  for (const g of groups.results) {
    const totalReqs = g.total_reqs as number;
    if (totalReqs === 0) continue;
    const errRate = (g.total_errors as number) / totalReqs;

    await env.DB.prepare(`
      INSERT INTO aggregated_metrics (service_name, endpoint, period, avg_latency, p50_latency, p95_latency, p99_latency, min_latency, max_latency, request_count, error_count, error_rate, throughput, period_start, period_end)
      VALUES (?, ?, 'day', ?, NULL, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      g.service_name as string, g.endpoint as string,
      round(g.weighted_avg as number),
      round(g.min_lat as number), round(g.max_lat as number),
      totalReqs, g.total_errors as number, round(errRate, 4),
      round(g.weighted_throughput as number, 2), startStr, endStr
    ).run();
  }
  logger.info('Daily aggregation complete', { groups: groups.results.length });
}

async function checkAnomalies(env: Env): Promise<void> {
  const baselines = await env.DB.prepare('SELECT * FROM baselines').all<Baseline>();
  if (baselines.results.length === 0) return;

  for (const bl of baselines.results) {
    // Get recent 5-min metrics for this service/endpoint
    const recent = await env.DB.prepare(`
      SELECT AVG(latency_ms) as avg_lat,
        CAST(SUM(CASE WHEN status_code >= 400 THEN 1 ELSE 0 END) AS REAL) / MAX(COUNT(*), 1) as err_rate,
        COUNT(*) as cnt
      FROM metrics WHERE service_name = ? AND endpoint = ? AND recorded_at > ?
    `).bind(bl.service_name, bl.endpoint, ago(5)).first<{ avg_lat: number | null; err_rate: number | null; cnt: number }>();

    if (!recent || recent.cnt < 3) continue;

    const avgLat = recent.avg_lat ?? 0;
    const errRate = recent.err_rate ?? 0;

    // Latency anomaly: > baseline + 2x baseline (simple threshold)
    const latThreshold = bl.baseline_latency * 3;
    if (avgLat > latThreshold && bl.baseline_latency > 0) {
      const severity = avgLat > bl.baseline_latency * 5 ? 'critical' : 'warning';
      // Check if similar alert already exists recently
      const existing = await env.DB.prepare(
        `SELECT id FROM performance_alerts WHERE service_name = ? AND endpoint = ? AND alert_type = 'latency' AND resolved = 0 AND created_at > ?`
      ).bind(bl.service_name, bl.endpoint, ago(30)).first();
      if (!existing) {
        await env.DB.prepare(
          `INSERT INTO performance_alerts (service_name, endpoint, alert_type, severity, threshold, actual_value, message)
           VALUES (?, ?, 'latency', ?, ?, ?, ?)`
        ).bind(
          bl.service_name, bl.endpoint, severity, round(latThreshold), round(avgLat),
          `Latency spike: ${round(avgLat)}ms vs baseline ${round(bl.baseline_latency)}ms (${round(avgLat / bl.baseline_latency, 1)}x)`
        ).run();
        logger.warn('Latency anomaly detected', { service: bl.service_name, endpoint: bl.endpoint, avg: avgLat, baseline: bl.baseline_latency });
      }
    }

    // Error rate anomaly: > baseline + 0.1 absolute or > 2x baseline
    const errThreshold = Math.max(bl.baseline_error_rate * 2, bl.baseline_error_rate + 0.1);
    if (errRate > errThreshold && errRate > 0.05) {
      const severity = errRate > 0.5 ? 'critical' : 'warning';
      const existing = await env.DB.prepare(
        `SELECT id FROM performance_alerts WHERE service_name = ? AND endpoint = ? AND alert_type = 'error_rate' AND resolved = 0 AND created_at > ?`
      ).bind(bl.service_name, bl.endpoint, ago(30)).first();
      if (!existing) {
        await env.DB.prepare(
          `INSERT INTO performance_alerts (service_name, endpoint, alert_type, severity, threshold, actual_value, message)
           VALUES (?, ?, 'error_rate', ?, ?, ?, ?)`
        ).bind(
          bl.service_name, bl.endpoint, severity, round(errThreshold, 4), round(errRate, 4),
          `Error rate spike: ${round(errRate * 100, 2)}% vs baseline ${round(bl.baseline_error_rate * 100, 2)}%`
        ).run();
        logger.warn('Error rate anomaly detected', { service: bl.service_name, endpoint: bl.endpoint, rate: errRate, baseline: bl.baseline_error_rate });
      }
    }
  }
}

async function recalculateBaselines(db: D1Database): Promise<number> {
  // Calculate baselines from the last 24 hours of data
  const cutoff = ago(1440);
  const groups = await db.prepare(`
    SELECT service_name, endpoint,
      AVG(latency_ms) as avg_lat,
      CAST(SUM(CASE WHEN status_code >= 400 THEN 1 ELSE 0 END) AS REAL) / COUNT(*) as err_rate,
      COUNT(*) / 1440.0 as throughput,
      COUNT(*) as sample_count
    FROM metrics WHERE recorded_at > ?
    GROUP BY service_name, endpoint
    HAVING sample_count >= 10
  `).bind(cutoff).all<{ service_name: string; endpoint: string; avg_lat: number; err_rate: number; throughput: number; sample_count: number }>();

  const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
  let count = 0;
  for (const g of groups.results) {
    await db.prepare(`
      INSERT INTO baselines (service_name, endpoint, baseline_latency, baseline_error_rate, baseline_throughput, sample_count, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(service_name, endpoint) DO UPDATE SET
        baseline_latency = ?, baseline_error_rate = ?, baseline_throughput = ?, sample_count = ?, updated_at = ?
    `).bind(
      g.service_name, g.endpoint, round(g.avg_lat), round(g.err_rate, 4), round(g.throughput, 4), g.sample_count, now,
      round(g.avg_lat), round(g.err_rate, 4), round(g.throughput, 4), g.sample_count, now
    ).run();
    count++;
  }
  return count;
}

async function pruneOldMetrics(env: Env): Promise<void> {
  const cutoff = ago(1440); // 24 hours
  const result = await env.DB.prepare('DELETE FROM metrics WHERE recorded_at < ?').bind(cutoff).run();
  logger.info('Pruned old metrics', { deleted: result.meta.changes ?? 0 });

  // Also prune old 5-min aggregates older than 7 days
  const weekAgo = ago(7 * 1440);
  const aggResult = await env.DB.prepare("DELETE FROM aggregated_metrics WHERE period = '5min' AND period_start < ?").bind(weekAgo).run();
  logger.info('Pruned old 5-min aggregates', { deleted: aggResult.meta.changes ?? 0 });
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

app.onError((err, c) => {
  if (err.message?.includes('JSON')) {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }
  console.error(`[echo-performance-profiler] ${err.message}`);
  return c.json({ error: 'Internal server error' }, 500);
});

app.notFound((c) => {
  return c.json({ error: 'Not found' }, 404);
});

export default {
  fetch: app.fetch,
  async scheduled(event: ScheduledEvent, env: Env, _ctx: ExecutionContext): Promise<void> {
    try {
      await handleCron(event.cron, env);
    } catch (e) {
      logger.error('Cron handler failed', { cron: event.cron, error: String(e) });
    }
  },
};
