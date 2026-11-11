import { createHash } from 'node:crypto';

export const safe = (text: string): string => [...text].map((ch) => (/^[A-Za-z0-9._-]$/.test(ch) ? ch : [...Buffer.from(ch, 'utf-8')].map((b) => `~${b.toString(16).padStart(2, '0')}`).join(''))).join('');

const canonical = (v: unknown): string => JSON.stringify(v, (_, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : 1))) : x));

export const fieldsName = (kind: string, fields: unknown): string => `${kind}.${createHash('sha256').update(canonical(fields)).digest('hex').slice(0, 12)}`;

export const stepName = (step: string | null, who: string, count: number): string => `${step === null ? '~' : safe(step)}.${safe(who)}.${count}`;
