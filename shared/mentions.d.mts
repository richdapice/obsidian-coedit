import type * as Y from "yjs";

export declare const REPLY_HEADER: string;
export declare const STALE_CLAIM_MS: number;
export declare const DAILY_CAP: number;
export declare const MAX_REPLY_CHARS: number;
export interface Mention {
  line: number;
  endOffset: number;
  prompt: string;
  staleClaim: boolean;
}
export declare function findUnansweredMentions(text: string, now?: number): Mention[];
export declare function formatReply(answer: string): string;
export declare function systemPrompt(notePath: string | null): string;
export interface ReplyHandle {
  ownsClaim(): boolean;
  update(answer: string): boolean;
  retract(): void;
}
export declare function claimReply(
  doc: Y.Doc,
  ytext: Y.Text,
  prompt: string,
  brainId: string,
): ReplyHandle | null;
export declare function contentHash(str: string): string;
