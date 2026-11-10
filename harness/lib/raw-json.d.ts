// JSON.rawJSON and JSON.isRawJSON, which Node 24 and Bun give and TypeScript's libs don't declare yet.
interface RawJSON { readonly rawJSON: string }
interface JSON {
  rawJSON(text: string): RawJSON;
  isRawJSON(value: unknown): value is RawJSON;
}
