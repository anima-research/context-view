import type { Cut } from './interfaces.ts';

export function cutText(write: (cut: Cut, whole: boolean) => string): { shown: string; full?: string } {
  let cut = false;
  const part = (whole: boolean): Cut => (value, n, sep = ', ') => {
    const items = Array.isArray(value) ? value : null;
    if (whole) return items ? items.join(sep) : String(value);
    if ((items ?? String(value)).length > Math.abs(n)) cut = true;
    const kept = (items ?? String(value)).slice(n < 0 ? n : 0, n < 0 ? undefined : n);
    return items ? (kept as unknown[]).join(sep) : (kept as string);
  };
  const shown = write(part(false), false);
  return cut ? { shown, full: write(part(true), true) } : { shown };
}

const said = (error: unknown) => {
  const told = (error as { message?: unknown } | null | undefined)?.message ?? error;
  const text = told === undefined || told === null ? '' : String(told);
  if (text !== '' && !/^\[object [^\]]*\]$/.test(text)) return text;
  return `${(error as { constructor?: { name?: unknown } } | null | undefined)?.constructor?.name ?? String(error)} with no message`;
};

/** An error's text, uncut: its message, or where that says nothing (empty, or an object's bare `[object …]`), its
 *  constructor's name, or the value itself for undefined and null, and "with no message". */
export const errorText = (error: unknown) => said(error);

export function cutError(error: unknown, n: number) {
  const c = cutText((cut) => cut(said(error), n));
  const whole = typeof (error as { full?: unknown } | null | undefined)?.full === 'string' ? (error as { full: string }).full : null;
  return whole && whole !== c.shown ? { shown: c.shown, full: whole } : c;
}

export function cutThrow(write: (cut: Cut, whole: boolean) => string): Error & { full?: string } {
  const { shown, full } = cutText(write);
  const e = new Error(shown);
  if (full) (e as Error & { full?: string }).full = full;
  return e;
}

export const cutMessage = (write: (cut: Cut, whole: boolean) => string) => {
  const { shown, full } = cutText(write);
  return { message: shown, ...(full ? { full } : {}) };
};
