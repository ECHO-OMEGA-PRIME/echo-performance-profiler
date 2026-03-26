export interface Env {
  DB: D1Database;
  CACHE: KVNamespace;
  SHARED_BRAIN: Fetcher;
  ALERT_ROUTER: Fetcher;
}

export interface MetricRecord {
  id: number;
  service_name: string;
  endpoint: string;
  method: string;
  status_code: number;
  latency_ms: number;
  cpu_time_ms: number | null;
  memory_mb: number | null;
  request_size: number | null;
  response_size: number | null;
  region: string | null;
  recorded_at: string;
}

export interface MetricInput {
  service_name: string;
  endpoint: string;
  method?: string;
  status_code?: number;
  latency_ms: number;
  cpu_time_ms?: number;
  memory_mb?: number;
  request_size?: number;
  response_size?: number;
  region?: string;
}

export interface AggregatedMetric {
  id: number;
  service_name: string;
  endpoint: string;
  period: '5min' | 'hour' | 'day';
  avg_latency: number;
  p50_latency: number | null;
  p95_latency: number | null;
  p99_latency: number | null;
  min_latency: number | null;
  max_latency: number | null;
  request_count: number;
  error_count: number;
  error_rate: number;
  throughput: number;
  period_start: string;
  period_end: string;
}

export interface PerformanceAlert {
  id: number;
  service_name: string;
  endpoint: string | null;
  alert_type: 'latency' | 'error_rate' | 'throughput';
  severity: 'info' | 'warning' | 'critical';
  threshold: number;
  actual_value: number;
  message: string;
  resolved: number;
  created_at: string;
  resolved_at: string | null;
}

export interface Baseline {
  id: number;
  service_name: string;
  endpoint: string;
  baseline_latency: number;
  baseline_error_rate: number;
  baseline_throughput: number;
  sample_count: number;
  updated_at: string;
}

export interface ProfilingSession {
  id: number;
  service_name: string;
  session_type: string;
  started_at: string;
  completed_at: string | null;
  results: string | null;
  status: 'running' | 'completed' | 'failed';
}

export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  timestamp: string;
}

export interface ServiceSummary {
  service_name: string;
  total_requests: number;
  avg_latency: number;
  p95_latency: number | null;
  error_rate: number;
  last_seen: string;
}

export interface LatencyDistribution {
  service_name: string;
  avg: number;
  p50: number;
  p95: number;
  p99: number;
  min: number;
  max: number;
  sample_count: number;
}

export interface DashboardData {
  overview: {
    total_services: number;
    total_metrics_24h: number;
    avg_system_latency: number;
    active_alerts: number;
    total_requests_24h: number;
    overall_error_rate: number;
  };
  top_slowest_services: ServiceSummary[];
  top_error_services: ServiceSummary[];
  recent_alerts: PerformanceAlert[];
  latency_trend: AggregatedMetric[];
}
