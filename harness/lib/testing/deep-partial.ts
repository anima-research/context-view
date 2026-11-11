import type { JsonLike } from '../strategies/compare.ts';

export type DeepPartial<T> = [JsonLike] extends [T] ? T : Partly<T>;
type Partly<T> = T extends (...args: never[]) => unknown ? T
  : T extends readonly unknown[] ? number extends T['length'] ? readonly DeepPartial<T[number]>[] : { [K in keyof T]: DeepPartial<T[K]> }
  : T extends object ? { [K in keyof T]?: DeepPartial<T[K]> }
  : T;
