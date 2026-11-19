import { main as mainImpl } from './main.ts';

type HarnessMain = (argv: string[]) => Promise<void>;
export const harnessMain: HarnessMain = mainImpl;
