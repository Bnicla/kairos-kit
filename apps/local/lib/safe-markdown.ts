import { Marked, type Tokens } from "marked";

/**
 * Markdown to HTML for the dashboard, with raw HTML turned into visible text.
 *
 * Everything the dashboard renders (the record, prep notes, insights, cover
 * letters, the voice profile) is written by a model from documents and job
 * postings the user did not write. A `<script>`, an `<img onerror=...>` or a
 * `javascript:` link in that text must not run in the dashboard. Markdown
 * itself is kept; HTML tags are shown escaped, and links and images keep only
 * http(s), mailto, relative and in-page addresses.
 */

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

export function isSafeHref(href: string): boolean {
  // Browsers ignore control characters and whitespace inside the scheme.
  const h = href.replace(/[\u0000- \u007f]+/g, "").toLowerCase();
  if (/^(https?:|mailto:)/.test(h)) return true;
  // No scheme at all: relative path, query or fragment.
  return !/^[a-z][a-z0-9+.-]*:/.test(h);
}

const md = new Marked({
  renderer: {
    html(token: Tokens.HTML | Tokens.Tag) {
      return escapeHtml(token.text);
    },
  },
  walkTokens(token) {
    if ((token.type === "link" || token.type === "image") && !isSafeHref((token as Tokens.Link).href)) {
      (token as Tokens.Link).href = "#";
    }
  },
});

export function renderSafeMarkdown(src: string, opts: { gfm?: boolean; breaks?: boolean } = {}): string {
  return md.parse(src, { async: false, gfm: opts.gfm ?? true, breaks: opts.breaks ?? false }) as string;
}
