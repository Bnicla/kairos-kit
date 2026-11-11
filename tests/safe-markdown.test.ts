import { describe, expect, it } from "vitest";
import { renderSafeMarkdown, isSafeHref } from "@/lib/safe-markdown";

describe("renderSafeMarkdown", () => {
  it("keeps Markdown and shows raw HTML as text", () => {
    const html = renderSafeMarkdown("# Title\n\n- **bold** item\n\n<script>alert(1)</script>\n\nText <img src=x onerror=alert(1)> here");
    expect(html).toContain("<h1>Title</h1>");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/<img[^>]*onerror/i);
    expect(html).toContain("&lt;script&gt;");
  });

  it("neutralises javascript: and data: links and images", () => {
    const html = renderSafeMarkdown("[a](javascript:alert(1)) [b](JaVa\tScript:alert(1)) ![c](data:text/html,x) [ok](https://example.com) [rel](/kb)");
    expect(html).not.toMatch(/javascript:/i);
    expect(html).not.toMatch(/data:text/i);
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain('href="/kb"');
  });

  it("isSafeHref", () => {
    expect(isSafeHref("mailto:a@example.com")).toBe(true);
    expect(isSafeHref("#part")).toBe(true);
    expect(isSafeHref("vbscript:x")).toBe(false);
  });
});
