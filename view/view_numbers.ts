// The view's figures as CPython 3.14 computes them, which its comments and their digests were made from: an int exact at
// any size, a float a double.
export type Py = { readonly int: bigint } | { readonly float: number };

// loads gives a bigint for an int's digits past the safe range, so a number outside it was written as a float. Within it,
// an integral number is an int: every writer of these files is JavaScript, which writes 5 where json.dumps writes 5.0.
export function fromJson(n: number | bigint): Py {
  if (typeof n === "bigint") return { int: n };
  return Number.isSafeInteger(n) ? { int: BigInt(n) } : { float: n };
}

// type(n) is int, of a number read from JSON, by the same rule.
export const isWhole = (n: unknown): n is number | bigint => (typeof n === "number" && Number.isSafeInteger(n)) || typeof n === "bigint";

const isInt = (x: Py): x is { readonly int: bigint } => "int" in x;

const raised = (name: string, message: string): Error => Object.assign(new Error(message), { name });

// float(x): an int to the nearest double, ties to even, as PyLong_AsDouble.
export function toFloat(x: Py): number {
  if (!isInt(x)) return x.float;
  const f = Number(x.int);
  if (!Number.isFinite(f)) throw raised("OverflowError", "int too large to convert to float");
  return f;
}

// Python's true division: two ints' exact quotient correctly rounded, which dividing two doubles isn't past 2 ** 53.
export function divide(a: Py, b: Py): number {
  if (isInt(b) ? b.int === 0n : b.float === 0) throw raised("ZeroDivisionError", "division by zero");
  if (!isInt(a) || !isInt(b)) return toFloat(a) / toFloat(b);
  const negative = a.int < 0n !== b.int < 0n;
  const n = a.int < 0n ? -a.int : a.int;
  const d = b.int < 0n ? -b.int : b.int;
  if (n === 0n) return negative ? -0 : 0;
  if (n < 2n ** 53n && d < 2n ** 53n) return (negative ? -1 : 1) * (Number(n) / Number(d));
  const shift = Math.max(0, 55 + d.toString(2).length - n.toString(2).length);
  const scaled = n << BigInt(shift);
  const value = Number(((scaled / d) << 1n) | (scaled % d === 0n ? 0n : 1n)) * 2 ** -(shift + 1);
  if (!Number.isFinite(value)) throw raised("OverflowError", "integer division result too large for a float");
  return negative ? -value : value;
}

const add = (a: Py, b: Py): Py => (isInt(a) && isInt(b) ? { int: a.int + b.int } : { float: toFloat(a) + toFloat(b) });

const LONG = [-(2n ** 63n), 2n ** 63n - 1n] as const;

// CPython 3.14's sum(): ints added as a C long until an item or the running total wouldn't fit one. From there, if the item
// that left was a float, the rest is Neumaier-compensated, each later int made the nearest double; otherwise each later item
// is added as + adds it. A plain reduce can differ in the last bit, which a figure to four places can show.
export function sum(values: Iterable<Py>): Py {
  const items = values[Symbol.iterator]();
  let next = items.next();
  let long = 0n;
  for (; !next.done; next = items.next()) {
    const x: Py = next.value;
    if (!isInt(x) || x.int < LONG[0] || x.int > LONG[1] || long + x.int < LONG[0] || long + x.int > LONG[1]) break;
    long += x.int;
  }
  if (next.done) return { int: long };
  let total = add({ int: long }, next.value);
  next = items.next();
  if (isInt(total)) {
    for (; !next.done; next = items.next()) total = add(total, next.value);
    return total;
  }
  let hi = total.float;
  let lo = 0;
  for (; !next.done; next = items.next()) {
    const x = toFloat(next.value);
    const t = hi + x;
    lo += Math.abs(hi) >= Math.abs(x) ? hi - t + x : x - t + hi;
    hi = t;
  }
  return { float: lo !== 0 && Number.isFinite(lo) ? hi + lo : hi };
}

// Python's round() of a float: ties to even.
export function round(x: number): bigint {
  if (Number.isNaN(x)) throw raised("ValueError", "cannot convert float NaN to integer");
  if (!Number.isFinite(x)) throw raised("OverflowError", "cannot convert float infinity to integer");
  const floor = Math.floor(x);
  const rest = x - floor;
  return BigInt(floor) + (rest > 0.5 || (rest === 0.5 && floor % 2 !== 0) ? 1n : 0n);
}

// format(x, '.Nf'), as CPython's dtoa gives it: the double's exact binary value rounded half to even, where toFixed rounds
// ties up.
export function fixed(x: Py | number, places: number, grouping = false): string {
  const f = typeof x === "number" ? x : toFloat(x);
  if (Number.isNaN(f)) return "nan";
  const negative = f < 0 || Object.is(f, -0);
  if (!Number.isFinite(f)) return negative ? "-inf" : "inf";
  const [mantissa, exponent] = exact(Math.abs(f));
  const scale = 10n ** BigInt(places);
  let digits: bigint;
  if (exponent >= 0) digits = mantissa * 2n ** BigInt(exponent) * scale;
  else {
    const denominator = 2n ** BigInt(-exponent);
    const numerator = mantissa * scale;
    const q = numerator / denominator;
    const twice = (numerator % denominator) * 2n;
    digits = twice > denominator || (twice === denominator && q % 2n === 1n) ? q + 1n : q;
  }
  const text = digits.toString().padStart(places + 1, "0");
  const whole = text.slice(0, text.length - places);
  return `${negative ? "-" : ""}${grouping ? whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",") : whole}${places ? `.${text.slice(text.length - places)}` : ""}`;
}

// format(x, '.N%'), as CPython gives it: x * 100 as a double, then '.Nf'.
export const percent = (x: number, places: number): string => `${fixed(x * 100, places)}%`;

function exact(f: number): [bigint, number] {
  if (f === 0) return [0n, 0];
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, f);
  const bits = view.getBigUint64(0);
  const biased = Number((bits >> 52n) & 0x7ffn);
  const fraction = bits & ((1n << 52n) - 1n);
  return biased === 0 ? [fraction, -1074] : [fraction | (1n << 52n), biased - 1075];
}
