import { cutError as cutErrorImpl, cutMessage as cutMessageImpl, cutText as cutTextImpl, cutThrow as cutThrowImpl, errorText as errorTextImpl } from './cut.ts';

export type Cut = (value: unknown, n: number, sep?: string) => string;
export type CutText = (write: (cut: Cut, whole: boolean) => string) => { shown: string; full?: string };
export const cutText: CutText = cutTextImpl;
export type ErrorText = (error: unknown) => string;
export const errorText: ErrorText = errorTextImpl;
export type CutError = (error: unknown, n: number) => { shown: string; full?: string };
export const cutError: CutError = cutErrorImpl;
export type CutThrow = (write: (cut: Cut, whole: boolean) => string) => Error & { full?: string };
export const cutThrow: CutThrow = cutThrowImpl;
export type CutMessage = (write: (cut: Cut, whole: boolean) => string) => { message: string; full?: string };
export const cutMessage: CutMessage = cutMessageImpl;
