/** The generator's mark at the end of the header of every file it writes; a file without it was not generated. */
export const MARK = ': edit the definition, not this file.';

// The header line the generator writes for a project's definition, in a Markdown, YAML or JavaScript comment.
const HEADER =
  /^(?:<!-- |# |\/\/ )Generated from \.cedarloom\/workflows\/([a-z0-9-]+)\.json by cl-workflow's generator\/generate\.mjs: edit the definition, not this file\.(?: -->)?\r?$/m;

/** The definition name in a generated file's header line; undefined for a file without that line. */
export const headerName = (bytes: Buffer): string | undefined => HEADER.exec(bytes.toString('utf8'))?.[1];
