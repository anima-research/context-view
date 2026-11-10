export type DeepPartial<T> = T extends readonly unknown[] ? { [K in keyof T]: DeepPartial<T[K]> } : T extends object ? { [K in keyof T]?: DeepPartial<T[K]> } : T;
