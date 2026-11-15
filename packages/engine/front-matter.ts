/**
 * Front matter: the block between `---` lines at the top of a Markdown file.
 *
 * Every read of front matter goes through this file. The library that parses
 * it, gray-matter, runs the block as JavaScript when the first line names that
 * language (`---js`, `---javascript`, in any case, with or without a space).
 * A knowledge base file can be written by whoever can write the knowledge base's folder, and
 * the hosted connector reads each user's files in one shared process, so such
 * a file would run its author's code there. Here that language is refused:
 * the block is YAML (the default) or JSON, which are only parsed.
 *
 * tests/front-matter.test.ts fails when another file imports gray-matter.
 *
 * Passing options also keeps gray-matter from caching every file it has ever
 * parsed in a table that is never emptied.
 */
import grayMatter from "gray-matter";

/** The file's front matter names a language that is not read. */
export class FrontMatterLanguageError extends Error {
  constructor() {
    super("This file's front matter is marked as JavaScript, which Kairos does not read. Write it as YAML between the --- lines.");
    this.name = "FrontMatterLanguageError";
  }
}

const refused = {
  parse(): never {
    throw new FrontMatterLanguageError();
  },
  stringify(): never {
    throw new FrontMatterLanguageError();
  },
};
// gray-matter looks a language up by its name as written, then by its alias: js and javascript, in any case, lead to `javascript`.
const OPTIONS = { engines: { javascript: refused, js: refused, coffee: refused } };

/** Parse a file's front matter and body. Throws FrontMatterLanguageError for a block marked as code. */
function matter(input: string): grayMatter.GrayMatterFile<string> {
  return grayMatter(input, OPTIONS);
}

/** A body and its front matter as one file's text (YAML). */
matter.stringify = (body: string, data: object): string => grayMatter.stringify(body, data);

export default matter;
