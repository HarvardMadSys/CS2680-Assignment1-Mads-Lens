import { describe, expect, it } from 'vitest'
import { buildTimeline } from './reducer'
describe('restored failure explanations', () => {
  it('retains result errors when an older run_end omitted its error field', () => {
    const state = buildTimeline([
      { kind: 'run_start', runId: 'failed', ts: 't0', prompt: 'Try a run' },
      {
        kind: 'claude',
        runId: 'failed',
        ts: 't1',
        event: {
          type: 'result',
          is_error: true,
          errors: ['Session expired'],
          total_cost_usd: 0.02,
          duration_ms: 300,
          num_turns: 1,
        },
      },
      { kind: 'run_end', runId: 'failed', ts: 't2', status: 'error' },
    ])
    expect(state.runs[0]).toMatchObject({
      status: 'error',
      error: 'Session expired',
      metrics: { costUsd: 0.02, durationMs: 300, numTurns: 1 },
    })
  })
})
