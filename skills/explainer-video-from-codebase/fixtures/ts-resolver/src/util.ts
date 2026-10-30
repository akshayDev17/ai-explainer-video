export function format(s: string) {
  return s.trim();
}

export function retry(fn: () => void) {
  fn();
}
