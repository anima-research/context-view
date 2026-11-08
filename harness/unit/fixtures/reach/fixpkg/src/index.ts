export function sign(n: number): string {
  if (n > 0) {
    return 'pos';
  }
  return 'neg';
}

// A comment line: it holds no code.
export function planted(n: number): number {
  const doubled = n * 2;
  return doubled + 1;
}

export function inChild(n: number): number {
  const less = n - 1;
  return less;
}
