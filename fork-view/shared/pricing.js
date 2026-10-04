/**
 * Token pricing, so a run can show what it is costing before it finishes.
 *
 * Claude Code only reports `total_cost_usd` in the final `result` frame, and a
 * subagent's result never reports cost at all. Both gaps are filled the same
 * way: accumulate the `usage` each assistant frame carries and price it with
 * the published per-token rates for the model the run reported.
 *
 * An estimate is always labelled as one. Where the exact figure exists it wins,
 * and where the model is unknown this returns null rather than a plausible
 * number -- the viewer says "unavailable" instead of inventing a total.
 */

/** USD per million tokens, from Anthropic's published rates. */
const RATES = {
  'claude-fable-5-1': { input: 10, output: 50 },
  'claude-fable-5': { input: 10, output: 50 },
  'claude-mythos-5-1': { input: 10, output: 50 },
  'claude-opus-5': { input: 5, output: 25 },
  'claude-opus-4-8': { input: 5, output: 25 },
  'claude-opus-4-7': { input: 5, output: 25 },
  'claude-opus-4-6': { input: 5, output: 25 },
  'claude-sonnet-5': { input: 2, output: 10 },
  'claude-sonnet-4-6': { input: 3, output: 15 },
  'claude-haiku-4-5': { input: 1, output: 5 },
}

// Cache tokens are priced as multiples of the model's own input rate.
const CACHE_READ = 0.1
const CACHE_WRITE_5M = 1.25
const CACHE_WRITE_1H = 2

/**
 * Strip the context-window suffix Claude Code appends to a model id, so
 * `claude-opus-5[1m]` prices as `claude-opus-5`.
 */
export function normaliseModel(model) {
  if (typeof model !== 'string') return null
  const id = model.replace(/\[[^\]]*\]\s*$/, '').trim()
  return id || null
}

/** Published rates for a model, or null if it is not one we have rates for. */
export function ratesFor(model) {
  const id = normaliseModel(model)
  return (id && RATES[id]) || null
}

const num = (value) => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0)

/** An empty accumulator, shaped like the `usage` object on an assistant frame. */
export function emptyUsage() {
  return {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 },
  }
}

/**
 * Add one frame's usage into an accumulator, returning a new object.
 *
 * The two cache-write tiers are priced differently, so the breakdown is kept
 * where a frame carries one; a frame that reports only a total is attributed to
 * the 5-minute tier, which is the cheaper of the two and therefore never
 * overstates the estimate.
 */
export function addUsage(total, usage) {
  if (!usage) return total

  const next = {
    input_tokens: total.input_tokens + num(usage.input_tokens),
    output_tokens: total.output_tokens + num(usage.output_tokens),
    cache_read_input_tokens:
      total.cache_read_input_tokens + num(usage.cache_read_input_tokens),
    cache_creation_input_tokens:
      total.cache_creation_input_tokens + num(usage.cache_creation_input_tokens),
    cache_creation: { ...total.cache_creation },
  }

  const oneHour = num(usage.cache_creation?.ephemeral_1h_input_tokens)
  const fiveMin = usage.cache_creation
    ? num(usage.cache_creation.ephemeral_5m_input_tokens)
    : Math.max(0, num(usage.cache_creation_input_tokens) - oneHour)

  next.cache_creation.ephemeral_1h_input_tokens += oneHour
  next.cache_creation.ephemeral_5m_input_tokens += fiveMin

  return next
}

/**
 * Price a usage total. Returns null when the model is unknown, so the caller
 * can say "unavailable" rather than show a number built on a guessed rate.
 */
export function estimateCostUsd(usage, model) {
  const rates = ratesFor(model)
  if (!rates || !usage) return null

  const perMillion = (tokens, rate) => (tokens * rate) / 1e6

  const oneHour = num(usage.cache_creation?.ephemeral_1h_input_tokens)
  const fiveMin = usage.cache_creation
    ? num(usage.cache_creation.ephemeral_5m_input_tokens)
    : Math.max(0, num(usage.cache_creation_input_tokens) - oneHour)

  return (
    perMillion(num(usage.input_tokens), rates.input) +
    perMillion(num(usage.output_tokens), rates.output) +
    perMillion(num(usage.cache_read_input_tokens), rates.input * CACHE_READ) +
    perMillion(fiveMin, rates.input * CACHE_WRITE_5M) +
    perMillion(oneHour, rates.input * CACHE_WRITE_1H)
  )
}
