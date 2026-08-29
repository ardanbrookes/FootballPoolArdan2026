/**
 * Matchup win probability.
 *
 * Each team's final score is modelled as a normal distribution: the mean is what
 * its starters are projected to score, and the spread comes from how erratic
 * those positions are week to week. The chance of winning is then just the
 * chance that one draw beats the other.
 *
 * With A ~ N(muA, varA) and B ~ N(muB, varB), their difference is
 * N(muA - muB, varA + varB), so
 *
 *     P(A wins) = Φ( (muA - muB) / sqrt(varA + varB) )
 *
 * This is a rough model and the UI says so. It ignores correlation entirely —
 * a QB and his own receiver rise and fall together, and two players in the same
 * game are not independent — which makes it slightly overconfident in close
 * matchups. Good enough to answer "am I still alive here?" on a Sunday, not
 * something to bet on.
 */

import { positionVariance, defaultPositionSd } from '../config.js'

/**
 * Weekly standard deviation for a starter, in points.
 *
 * Keyed on the player's real position rather than the slot, so a WR in the FLEX
 * carries WR volatility rather than something averaged.
 */
function sdFor(player) {
  if (!player) return 0
  return positionVariance[player.position] ?? defaultPositionSd
}

/**
 * Expected points and variance still to come for one starter.
 *
 * Three cases, and the distinction matters most on a Sunday afternoon:
 *
 *   final        what they scored is now a fact — no mean to guess, no variance
 *   in progress  part banked, part still live: expect half of whatever is left,
 *                with the uncertainty damped since some of the game is gone
 *   scheduled    the projection, at full positional variance
 *
 * A player already past their projection keeps the points they have; the model
 * never claws back a score that has already happened.
 */
function contribution(slot) {
  const player = slot?.player
  if (!player) return { mean: 0, variance: 0 }

  const actual = player.points ?? 0
  const projected = player.projectedPoints ?? 0
  const sd = sdFor(player)
  const status = player.game?.status ?? (player.onBye ? 'bye' : 'scheduled')

  if (status === 'final' || status === 'bye') {
    return { mean: actual, variance: 0 }
  }

  if (status === 'in_progress') {
    const remaining = Math.max(0, projected - actual)
    return { mean: actual + remaining * 0.5, variance: (sd * 0.6) ** 2 }
  }

  return { mean: projected, variance: sd ** 2 }
}

/** Abramowitz & Stegun 7.1.26 — plenty accurate for a percentage. */
function erf(x) {
  const sign = x < 0 ? -1 : 1
  const ax = Math.abs(x)
  const t = 1 / (1 + 0.3275911 * ax)
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-ax * ax)
  return sign * y
}

const normalCdf = (z) => 0.5 * (1 + erf(z / Math.SQRT2))

/**
 * Win probability for the home side of a matchup.
 *
 * `homeStarters` / `awayStarters` are the slot lists the matchup endpoint
 * already builds, so this needs no extra queries.
 */
export function winProbability(homeStarters = [], awayStarters = []) {
  const tally = (slots) =>
    slots.reduce(
      (acc, slot) => {
        const { mean, variance } = contribution(slot)
        return { mean: acc.mean + mean, variance: acc.variance + variance }
      },
      { mean: 0, variance: 0 },
    )

  const home = tally(homeStarters)
  const away = tally(awayStarters)

  const spread = home.mean - away.mean
  const sd = Math.sqrt(home.variance + away.variance)

  // Every game finished: the result is settled, not a probability. A dead-level
  // tie is reported as an even split rather than a spurious 100%.
  if (sd === 0) {
    const pHome = spread > 0 ? 1 : spread < 0 ? 0 : 0.5
    return {
      home: pHome * 100,
      away: (1 - pHome) * 100,
      projected: { home: round(home.mean), away: round(away.mean) },
      spread: round(spread),
      settled: true,
    }
  }

  const pHome = normalCdf(spread / sd)
  return {
    home: round(pHome * 100),
    away: round((1 - pHome) * 100),
    projected: { home: round(home.mean), away: round(away.mean) },
    spread: round(spread),
    settled: false,
  }
}

const round = (n) => Math.round(n * 10) / 10
