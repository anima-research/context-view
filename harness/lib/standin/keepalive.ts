import type { Claim, Kind } from './standin.ts';
import type { ReadView } from './view.ts';

// A prompt-cache keepalive refresh, under the setup option `refreshes` alone (startStandin): membrane's keepalive
// replays a request it sent with `max_tokens: 0` and no stream, which "runs prefill only: content `[]`, stop_reason
// `max_tokens`, no output tokens billed, and the cache entry refreshed" (membrane 0.8.1, src/cache-keepalive.ts). It
// carries the step's canaries, since it replays a request of the step, so it's claimed ahead of every other kind and
// takes none of the step's replies. Its usage is the codec's cache model's, which a read refreshes as any request's
// does. Without the option the Messages codec refuses `max_tokens: 0`, so a refresh never reaches a kind. It claims
// only Messages requests, Anthropic's and Bedrock's: a Chat Completions or Responses request asking for no output is
// left to its codec, which refuses it.
export function keepalive(): Kind {
  function claim(view: ReadView): Claim | null {
    if (view.maxTokens !== 0) return null;
    return {
      kind: 'keepalive',
      answer(record) {
        record.answer = { shape: 'refresh' };
        return { content: [], stop: 'max_tokens' };
      },
    };
  }
  return { claim, apis: ['messages'] };
}
