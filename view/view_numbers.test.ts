import { describe, expect, test } from "bun:test";

import { divide, fixed, percent, round, sum, type Py } from "./view_numbers.ts";

type Case = [Py[], (number | boolean)[], string];

const I = (n: bigint): Py => ({ int: n });
const F = (x: number): Py => ({ float: x });
const rep = (x: Py, n: number): Py[] => Array.from({ length: n }, () => x);

const bits = (x: number): string => {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, x);
  return view.getBigUint64(0).toString(16).padStart(16, "0");
};
const shown = (v: Py | number): string => (typeof v === "number" ? `float ${bits(v)}` : "int" in v ? `int ${v.int}` : `float ${bits(v.float)}`);
const float = (x: Py): number => ("float" in x ? x.float : Number(x.int));
const answer = (run: () => string): string => {
  try {
    return run();
  } catch (e) {
    return `${(e as Error).name}: ${(e as Error).message}`;
  }
};

const CPYTHON: Record<"fixed" | "percent" | "round" | "sum" | "divide", Case[]> = {
  fixed: [
    [[F(0.125)], [2, false], "0.12"],
    [[F(0.375)], [2, false], "0.38"],
    [[F(2.675)], [2, false], "2.67"],
    [[F(1.005)], [2, false], "1.00"],
    [[F(9.995)], [2, false], "9.99"],
    [[F(-0.0)], [1, false], "-0.0"],
    [[F(-0.001)], [2, false], "-0.00"],
    [[F(1e+16)], [2, false], "10000000000000000.00"],
    [[F(1e+22)], [0, false], "10000000000000000000000"],
    [[F(5e-324)], [4, false], "0.0000"],
    [[F(1234567.125)], [2, true], "1,234,567.12"],
    [[F(0.5)], [0, false], "0"],
    [[F(1.5)], [0, false], "2"],
    [[I(2n**53n+1n)], [0, false], "9007199254740992"],
    [[I(10n**22n)], [0, true], "10,000,000,000,000,000,000,000"],
    [[F(NaN)], [4, false], "nan"],
    [[F(Infinity)], [4, false], "inf"],
    [[F(-Infinity)], [2, true], "-inf"],
    [[I(10n**400n)], [2, false], "OverflowError: int too large to convert to float"],
  ],
  percent: [
    [[F(0.5)], [1], "50.0%"],
    [[F(0.00125)], [1], "0.1%"],
    [[F(0.3333333333333333)], [1], "33.3%"],
    [[F(0.0005)], [1], "0.1%"],
    [[F(0.9995)], [1], "100.0%"],
    [[F(0.0)], [1], "0.0%"],
    [[F(0.0025)], [1], "0.2%"],
    [[F(0.0125)], [1], "1.2%"],
    [[F(0.0225)], [1], "2.2%"],
  ],
  round: [
    [[F(0.5)], [], "0"],
    [[F(1.5)], [], "2"],
    [[F(2.5)], [], "2"],
    [[F(-0.5)], [], "0"],
    [[F(-1.5)], [], "-2"],
    [[F(0.49999999999999994)], [], "0"],
    [[F(4503599627370495.5)], [], "4503599627370496"],
    [[F(1e+22)], [], "10000000000000000000000"],
    [[F(NaN)], [], "ValueError: cannot convert float NaN to integer"],
    [[F(Infinity)], [], "OverflowError: cannot convert float infinity to integer"],
    [[F(-Infinity)], [], "OverflowError: cannot convert float infinity to integer"],
  ],
  sum: [
    [[], [], "int 0"],
    [[I(1n), I(2n), I(3n)], [], "int 6"],
    [[F(0.1), F(0.1), F(0.1), F(0.1), F(0.1), F(0.1), F(0.1), F(0.1), F(0.1), F(0.1)], [], "float 3ff0000000000000"],
    [[F(1e+100), F(1.0), F(-1e+100)], [], "float 3ff0000000000000"],
    [[I(2n**63n-1n), I(1n), I(-1n), ...rep(F(1.0), 2048)], [], "float 43e0000000000000"],
    [[I(2n**63n), I(-1n), ...rep(F(1.0), 2048)], [], "float 43e0000000000000"],
    [[I(-(2n**63n)), I(-1n), ...rep(F(1.0), 2048)], [], "float c3e0000000000000"],
    [[F(0.5), I(2n**63n), ...rep(F(1.0), 2048)], [], "float 43e0000000000001"],
    [[F(1.0), I(2n**63n), F(1.0), I(-(2n**63n))], [], "float 4000000000000000"],
    [[I(2n**64n), F(0.5), I(2n**64n), F(0.1), F(0.2)], [], "float 4400000000000000"],
    [[I(10n**400n), F(1.5)], [], "OverflowError: int too large to convert to float"],
    [[F(1.5), I(10n**400n)], [], "OverflowError: int too large to convert to float"],
    [[I(2n**63n-1n), I(1n), I(2n**70n)], [], "int 1189814992754266079232"],
  ],
  divide: [
    [[I(1n), I(3n)], [], "float 3fd5555555555555"],
    [[I(2n**53n+1n), I(3n)], [], "float 4325555555555556"],
    [[I(2n**1023n), I(1n)], [], "float 7fe0000000000000"],
    [[I(10n**308n), I(1n)], [], "float 7fe1ccf385ebc8a0"],
    [[I(-(2n**1023n)), I(3n)], [], "float ffc5555555555555"],
    [[I(2n**1024n-2n**970n), I(1n)], [], "OverflowError: integer division result too large for a float"],
    [[I(2n**1024n-1n), I(1n)], [], "OverflowError: integer division result too large for a float"],
    [[I(10n**400n), I(10n**92n)], [], "float 7fe1ccf385ebc8a0"],
    [[I(1n), I(2n**1022n)], [], "float 0010000000000000"],
    [[I(1n), I(2n**1074n)], [], "float 0000000000000001"],
    [[I(1n), I(2n**1075n)], [], "float 0000000000000000"],
    [[I(3n), I(2n**1076n)], [], "float 0000000000000001"],
    [[I(0n), I(-5n)], [], "float 8000000000000000"],
    [[I(-5n), I(2n**1080n)], [], "float 8000000000000000"],
    [[I(1n), I(0n)], [], "ZeroDivisionError: division by zero"],
    [[F(1.0), F(0.0)], [], "ZeroDivisionError: division by zero"],
    [[I(10n**400n), F(0.0)], [], "OverflowError: int too large to convert to float"],
    [[F(1.0), I(10n**400n)], [], "OverflowError: int too large to convert to float"],
    [[I(7n), F(2.0)], [], "float 400c000000000000"],
  ],
};

describe("Numbers", () => {
  test("format's .Nf gives CPython 3.14's text, a double's exact value rounded half to even, and an int too large for a float raises as CPython's does", () => {
    for (const [nums, [places, grouping], python] of CPYTHON.fixed) expect([nums, answer(() => fixed(nums[0]!, places as number, grouping as boolean))]).toEqual([nums, python]);
  });

  test("format's .N% gives CPython 3.14's text, the float times 100 then .Nf", () => {
    for (const [nums, [places], python] of CPYTHON.percent) expect([nums, answer(() => percent(float(nums[0]!), places as number))]).toEqual([nums, python]);
  });

  test("round gives CPython 3.14's int, ties to even, and raises for NaN and the infinities as CPython's does", () => {
    for (const [nums, , python] of CPYTHON.round) expect([nums, answer(() => String(round(float(nums[0]!))))]).toEqual([nums, python]);
  });

  test("sum gives CPython 3.14's int or float, from a C long's edges through its compensated floats, and raises as CPython's does", () => {
    for (const [nums, , python] of CPYTHON.sum) expect([nums.length, answer(() => shown(sum(nums)))]).toEqual([nums.length, python]);
  });

  test("true division gives CPython 3.14's double at the edges of a double's range, and raises as CPython's does", () => {
    for (const [nums, , python] of CPYTHON.divide) expect([nums, answer(() => shown(divide(nums[0]!, nums[1]!)))]).toEqual([nums, python]);
  });
});
