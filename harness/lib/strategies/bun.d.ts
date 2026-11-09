declare var Bun: { nanoseconds(): number; $: unknown } | undefined;

declare module 'bun:ffi' {
  export const FFIType: { readonly i32: number; readonly ptr: number };
  export function dlopen<S extends Record<string, { args: readonly number[]; returns: number }>>(
    path: string,
    symbols: S,
  ): { symbols: { [K in keyof S]: (...args: unknown[]) => number } };
  export function ptr(view: ArrayBufferView): number;
}
