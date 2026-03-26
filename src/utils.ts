import type { ApiResponse } from './types';

const API_KEY = 'echo-omega-prime-forge-x-2026';

export function ok<T>(data: T): ApiResponse<T> {
  return { success: true, data, timestamp: new Date().toISOString() };
}

export function err(error: string): ApiResponse {
  return { success: false, error, timestamp: new Date().toISOString() };
}

export function authenticate(header: string | null): boolean {
  if (!header) return false;
  return header === API_KEY;
}

/**
 * Calculate percentile from sorted array using nearest-rank method.
 */
export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0]!;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(idx, sorted.length - 1))]!;
}

/**
 * Calculate standard deviation.
 */
export function stddev(values: number[], mean: number): number {
  if (values.length < 2) return 0;
  const sumSq = values.reduce((acc, v) => acc + (v - mean) ** 2, 0);
  return Math.sqrt(sumSq / values.length);
}

/**
 * Round to N decimal places.
 */
export function round(value: number, places: number = 2): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

/**
 * Get ISO datetime string for N minutes/hours/days ago.
 */
export function ago(minutes: number): string {
  return new Date(Date.now() - minutes * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);
}

/**
 * Floor datetime to nearest interval.
 */
export function floorToInterval(date: Date, intervalMinutes: number): Date {
  const ms = intervalMinutes * 60 * 1000;
  return new Date(Math.floor(date.getTime() / ms) * ms);
}

/**
 * Try to parse a KV-cached JSON value.
 */
export async function getCache<T>(kv: KVNamespace, key: string): Promise<T | null> {
  const raw = await kv.get(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/**
 * Set a KV-cached JSON value with TTL in seconds.
 */
export async function setCache(kv: KVNamespace, key: string, value: unknown, ttl: number): Promise<void> {
  await kv.put(key, JSON.stringify(value), { expirationTtl: ttl });
}
