export type Cut = (value: unknown, n: number, sep?: string) => string;

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
  return String(told) !== '' ? told : `${(error as { constructor?: { name?: unknown } } | null | undefined)?.constructor?.name ?? 'an error'} with no message`;
};

/** An error's text, uncut: its message, or where that's empty, its constructor's name and "with no message". */
export const errorText = (error: unknown) => String(said(error));

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
