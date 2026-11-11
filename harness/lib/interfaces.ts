import { main as mainImpl } from './main.ts';

export type HarnessMain = (argv: string[]) => Promise<void>;
export const harnessMain: HarnessMain = mainImpl;
