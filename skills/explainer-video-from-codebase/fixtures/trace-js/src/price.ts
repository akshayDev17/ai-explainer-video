export interface Line { sku: string; qty: number }

export function lineTotal(line: Line, unit: number): number {
  return line.qty * unit;
}

export function unused(): void {}
