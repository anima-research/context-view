export function used(n: number): string {
  if (n > 0) {
    return 'pos';
  }
  return 'neg';
}

export function dead(n: number): number {
  const doubled = n * 2;
  return doubled + 1;
}

console.log(used(1));
console.log('ready');
setInterval(() => {}, 1000);
