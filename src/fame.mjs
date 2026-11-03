export const FAME_KEYS = ['mu', 'chi', 'epsilon', 'kappa', 'nu', 'delta', 'rho', 'lambda'];
export const FAME_VERSION = 'fame-inertia-exact-v1';
export const FAME_SCHEMA = 'FAME-Theory/8D';
export const FAME_DEFINITIONS = Object.freeze({
  mu: 'satisfaction', chi: 'curiosity', epsilon: 'empathy', kappa: 'confidence',
  nu: 'anxiety', delta: 'conflict', rho: 'fatigue', lambda: 'loss',
});
export const FAME_MEANINGS = Object.freeze({
  mu: 'Degree of goal attainment',
  chi: 'Tendency to explore new information',
  epsilon: 'Alignment with the other participant state',
  kappa: 'Estimated reliability of own output',
  nu: 'Perceived uncertainty or risk',
  delta: 'Degree of internal logical contradiction',
  rho: 'Resource consumption approaching its limit',
  lambda: 'Persistent state of unachieved goals',
});

export function validateFame(value = {}) {
  return Object.fromEntries(FAME_KEYS.map(key => {
    const x = value[key];
    if (x == null) return [key, null];
    if (!Number.isFinite(x) || x < 0 || x > 1) throw new Error(`Invalid FAME dimension: ${key}`);
    return [key, x];
  }));
}

// Exact integration of dE/dt = (1-xi)(E_target-E)/tau for a constant target.
export function evolveFame(previous, target, { dt = 1, tau = 1, xi = 0.7 } = {}) {
  if (![dt, tau, xi].every(Number.isFinite) || dt < 0 || tau <= 0 || xi < 0 || xi > 1) throw new Error('Invalid inertia parameters');
  const before = validateFame(previous);
  const after = validateFame(target);
  const gain = -Math.expm1(-(1 - xi) * dt / tau);
  return Object.fromEntries(FAME_KEYS.map(key => [
    key, after[key] == null || gain === 0 ? before[key]
      : before[key] == null ? after[key] : before[key] + gain * (after[key] - before[key]),
  ]));
}

export function fameAffinity(recorded = {}, current = {}) {
  let distance = 0, observed = 0;
  for (const actor of ['user', 'agent']) {
    for (const key of FAME_KEYS) {
      const a = recorded[actor]?.vector?.[key];
      const b = current[actor]?.vector?.[key];
      if (Number.isFinite(a) && Number.isFinite(b)) { distance += (a - b) ** 2; observed++; }
    }
  }
  return observed ? 1 - Math.sqrt(distance / observed) : null;
}
