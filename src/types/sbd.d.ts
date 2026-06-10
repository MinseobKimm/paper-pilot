declare module "sbd" {
  export type SentenceTokenizerOptions = {
    newline_boundaries?: boolean;
    html_boundaries?: boolean;
    html_boundaries_tags?: string[];
    sanitize?: boolean;
    allowed_tags?: string[] | false;
    preserve_whitespace?: boolean;
    abbreviations?: string[] | null;
  };

  export function sentences(text: string, options?: SentenceTokenizerOptions | boolean): string[];

  const tokenizer: {
    sentences: typeof sentences;
  };

  export default tokenizer;
}
