## API Latency Comparison

| Before | After |
|--------|-------|
| before | after-final |
| 50 runs/endpoint | 50 runs/endpoint |

| Endpoint | Before P50 | After P50 | Change (ms) | Change (%) | Significance |
|----------|-----------|----------|-------------|------------|--------------|
| GET /api/dashboard/my-work | 10.7ms | 4.6ms | -6.2ms | -57.3% | improved |
| GET /api/weeks | 7.4ms | 2.6ms | -4.8ms | -64.6% | improved |
| GET /api/weeks/:id | 6.4ms | — | — | — | not measured |
| GET /api/issues | 7.0ms | 5.8ms | -1.2ms | -17.3% | improved |
| GET /api/projects | 7.4ms | 2.4ms | -4.9ms | -67.0% | improved |

> Changes < 0.5ms flagged as "within noise" for serial localhost benchmarks.

### P95 Tail Latency

| Endpoint | Before P95 | After P95 | Change |
|----------|-----------|----------|--------|
| GET /api/dashboard/my-work | 13.6ms | 8.0ms | -5.6ms |
| GET /api/weeks | 12.7ms | 6.0ms | -6.7ms |
| GET /api/issues | 9.0ms | 13.3ms | +4.4ms |
| GET /api/projects | 10.7ms | 5.3ms | -5.4ms |
