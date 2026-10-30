export function runWithRetry(fn) {
  return fn();
}

export function nightlyTotal(cart) {
  return runWithRetry(() => cart.total());
}
