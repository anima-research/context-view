export type Py = { readonly int: bigint } | { readonly float: number };

// loads gives a bigint for an int's digits past the safe range, so a number outside it was written as a float. Within it,
// an integral number is an int: every number the view reads was written by JSON.stringify, directly or copied by
// view_read, and JSON.stringify writes an integral number below 1e21 without a fraction.
export function fromJson(n: number | bigint): Py {
  if (typeof n === "bigint") return { int: n };
  return Number.isSafeInteger(n) ? { int: BigInt(n) } : { float: n };
}

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

const [MANT_DIG, MIN_EXP, MAX_EXP] = [53, -1021, 1024];

const bitLength = (x: bigint): number => x.toString(2).length;

const ldexp = (x: number, e: number): number => (e < -1000 ? x * 2 ** -1000 * 2 ** (e + 1000) : x * 2 ** e);

// CPython 3.14's true division. Two ints go as long_true_divide takes them: a shift chosen from their bit lengths, the
// quotient rounded half to even on the integer, then scaled by an exact power of two. Any other pair goes as float_div:
// each made a float first, then the zero check.
export function divide(a: Py, b: Py): number {
  if (!isInt(a) || !isInt(b)) {
    const [x, y] = [toFloat(a), toFloat(b)];
    if (y === 0) throw raised("ZeroDivisionError", "division by zero");
    return x / y;
  }
  if (b.int === 0n) throw raised("ZeroDivisionError", "division by zero");
  const negate = a.int < 0n !== b.int < 0n;
  const signed = (r: number): number => (negate ? -r : r);
  const n = a.int < 0n ? -a.int : a.int;
  const d = b.int < 0n ? -b.int : b.int;
  if (n === 0n) return signed(0);
  if (n < 2n ** 53n && d < 2n ** 53n) return signed(Number(n) / Number(d));
  const diff = bitLength(n) - bitLength(d);
  if (diff > MAX_EXP) throw raised("OverflowError", "integer division result too large for a float");
  if (diff < MIN_EXP - MANT_DIG - 1) return signed(0);
  const shift = Math.max(diff, MIN_EXP) - MANT_DIG - 2;
  const shifted = shift <= 0 ? n << BigInt(-shift) : n >> BigInt(shift);
  const inexact = (shift > 0 && (n & ((1n << BigInt(shift)) - 1n)) !== 0n) || shifted % d !== 0n;
  let x = shifted / d;
  const xBits = bitLength(x);
  const mask = 1n << BigInt(Math.max(xBits, MIN_EXP - shift) - MANT_DIG - 1);
  const low = inexact ? x | 1n : x;
  x = ((low & mask) !== 0n && (low & (3n * mask - 1n)) !== 0n ? low + mask : low) & ~(2n * mask - 1n);
  const dx = Number(x);
  if (shift + xBits >= MAX_EXP && (shift + xBits > MAX_EXP || dx === 2 ** xBits)) throw raised("OverflowError", "integer division result too large for a float");
  return signed(ldexp(dx, shift));
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
