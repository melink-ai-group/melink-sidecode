import { ZVEC_GREP_MCP_SERVER } from '../../skills/opencodeMcp.ts';
import { parseOpencodeConfig } from './jsonc.ts';

/**
 * Comments-preserving edits of one OpenCode config entry.
 *
 * The file belongs to the user: a skill toggle must not reformat it. These
 * helpers find the target property in the raw text, replace or remove only its
 * value bytes, and leave every other byte (comments, trailing commas,
 * indentation, unrelated keys) untouched. The edited text is reparsed and
 * compared with the expected data before it is accepted; ambiguous duplicate
 * properties are refused rather than guessed at.
 */

export type LegacyZvecRewrite =
  | { status: 'rewritten'; text: string }
  | { status: 'unchanged' }
  | { status: 'no-match' }
  | { status: 'ambiguous'; message: string }
  | { status: 'invalid'; message: string };

export type McpTextEdit =
  | { status: 'edited'; text: string }
  | { status: 'not-found' }
  | { status: 'ambiguous'; message: string }
  | { status: 'invalid'; message: string };

interface ListedProperty {
  key: string;
  keyStart: number;
  valueStart: number;
  valueEnd: number;
}

interface StringToken {
  value: string;
  start: number;
  end: number;
}

type FindProperty =
  | { status: 'found'; property: ListedProperty }
  | { status: 'missing' }
  | { status: 'ambiguous' };

interface ParsedString {
  value: string;
  end: number;
}

const BOM = '\uFEFF';

/** Skip whitespace, BOM, `//` comments and block comments. */
function skipTrivia(text: string, start: number): number {
  let i = start;
  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];
    if (ch === undefined) {
      break;
    }
    if (ch === BOM || /\s/.test(ch)) {
      i += 1;
      continue;
    }
    if (ch === '/' && next === '/') {
      i += 2;
      while (i < text.length && text[i] !== '\n') {
        i += 1;
      }
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i + 1 < text.length && !(text[i] === '*' && text[i + 1] === '/')) {
        i += 1;
      }
      i = Math.min(text.length, i + 2);
      continue;
    }
    break;
  }
  return i;
}

function readString(text: string, start: number): ParsedString | undefined {
  if (text[start] !== '"') {
    return undefined;
  }
  let i = start + 1;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (ch === '"') {
      try {
        const value = JSON.parse(text.slice(start, i + 1)) as unknown;
        return typeof value === 'string' ? { value, end: i + 1 } : undefined;
      } catch {
        return undefined;
      }
    }
    i += 1;
  }
  return undefined;
}

/** End offset of one JSON value, skipping strings and comments. */
function skipValue(text: string, start: number): number | undefined {
  const ch = text[start];
  if (ch === '"') {
    return readString(text, start)?.end;
  }
  if (ch === '{' || ch === '[') {
    return skipComposite(text, start);
  }
  let i = start;
  while (i < text.length && !/[\s,}\]]/.test(text[i] ?? '')) {
    i += 1;
  }
  return i > start ? i : undefined;
}

/** End offset just after the closing bracket that matches `start`. */
function skipComposite(text: string, start: number): number | undefined {
  let depth = 0;
  let i = start;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"') {
      const token = readString(text, i);
      if (!token) {
        return undefined;
      }
      i = token.end;
      continue;
    }
    const next = text[i + 1];
    if (ch === '/' && next === '/') {
      i += 2;
      while (i < text.length && text[i] !== '\n') {
        i += 1;
      }
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i + 1 < text.length && !(text[i] === '*' && text[i + 1] === '/')) {
        i += 1;
      }
      i = Math.min(text.length, i + 2);
      continue;
    }
    if (ch === '{' || ch === '[') {
      depth += 1;
    } else if (ch === '}' || ch === ']') {
      depth -= 1;
      if (depth === 0) {
        return i + 1;
      }
    }
    i += 1;
  }
  return undefined;
}

/** Every top-level property of the object that starts at `objectStart`. */
function listProperties(text: string, objectStart: number): ListedProperty[] | undefined {
  if (text[objectStart] !== '{') {
    return undefined;
  }
  const properties: ListedProperty[] = [];
  let i = objectStart + 1;
  while (i < text.length) {
    i = skipTrivia(text, i);
    const ch = text[i];
    if (ch === undefined) {
      return undefined;
    }
    if (ch === '}') {
      return properties;
    }
    if (ch === ',') {
      i += 1;
      continue;
    }
    if (ch !== '"') {
      return undefined;
    }
    const keyStart = i;
    const token = readString(text, i);
    if (!token) {
      return undefined;
    }
    const afterKey = skipTrivia(text, token.end);
    if (text[afterKey] !== ':') {
      return undefined;
    }
    const valueStart = skipTrivia(text, afterKey + 1);
    const valueEnd = skipValue(text, valueStart);
    if (valueEnd === undefined) {
      return undefined;
    }
    properties.push({ key: token.value, keyStart, valueStart, valueEnd });
    i = valueEnd;
  }
  return undefined;
}

function findProperty(text: string, objectStart: number, key: string): FindProperty {
  const properties = listProperties(text, objectStart);
  if (!properties) {
    return { status: 'missing' };
  }
  const matches = properties.filter((property) => property.key === key);
  if (matches.length > 1) {
    return { status: 'ambiguous' };
  }
  return matches[0] ? { status: 'found', property: matches[0] } : { status: 'missing' };
}

/** Every string element of an array that contains only strings and commas. */
function arrayStrings(text: string, arrayStart: number): StringToken[] | undefined {
  if (text[arrayStart] !== '[') {
    return undefined;
  }
  const elements: StringToken[] = [];
  let i = arrayStart + 1;
  while (i < text.length) {
    i = skipTrivia(text, i);
    const ch = text[i];
    if (ch === undefined) {
      return undefined;
    }
    if (ch === ']') {
      return elements;
    }
    if (ch === ',') {
      i += 1;
      continue;
    }
    if (ch !== '"') {
      return undefined;
    }
    const token = readString(text, i);
    if (!token) {
      return undefined;
    }
    elements.push({ value: token.value, start: i, end: token.end });
    i = skipTrivia(text, token.end);
    if (text[i] === ',') {
      i += 1;
      continue;
    }
    if (text[i] === ']') {
      return elements;
    }
    return undefined;
  }
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function eol(text: string): string {
  return text.includes('\r\n') ? '\r\n' : '\n';
}

function lineIndent(text: string, position: number): string {
  const lineStart = text.lastIndexOf('\n', Math.max(0, position - 1)) + 1;
  const match = /^[ \t]*/.exec(text.slice(lineStart, position));
  return match?.[0] ?? '';
}

/** Pretty-print a value so its closing bracket aligns with `indent`. */
function formatValue(value: unknown, indent: string): string {
  return JSON.stringify(value, null, 2).split('\n').join(`\n${indent}`);
}

/** Insert one property after the last existing property (or inside an empty object). */
function insertProperty(
  text: string,
  objectStart: number,
  key: string,
  value: unknown
): string | undefined {
  const properties = listProperties(text, objectStart);
  if (!properties) {
    return undefined;
  }
  const newline = eol(text);
  if (properties.length === 0) {
    const indent = `${lineIndent(text, objectStart)}  `;
    const snippet = `${newline}${indent}${JSON.stringify(key)}: ${formatValue(value, indent)}${newline}${lineIndent(text, objectStart)}`;
    return `${text.slice(0, objectStart + 1)}${snippet}${text.slice(objectStart + 1)}`;
  }
  const last = properties[properties.length - 1];
  if (!last) {
    return undefined;
  }
  const indent = lineIndent(text, last.keyStart);
  const snippet = `,${newline}${indent}${JSON.stringify(key)}: ${formatValue(value, indent)}`;
  return `${text.slice(0, last.valueEnd)}${snippet}${text.slice(last.valueEnd)}`;
}

/** Remove one property, including its separator, from an object. */
function removeProperty(text: string, objectStart: number, key: string): string | undefined {
  const properties = listProperties(text, objectStart);
  if (!properties) {
    return undefined;
  }
  const index = properties.findIndex((property) => property.key === key);
  if (index < 0) {
    return undefined;
  }
  const target = properties[index];
  if (!target) {
    return undefined;
  }
  const after = skipTrivia(text, target.valueEnd);
  const hasTrailingComma = text[after] === ',';
  let start = target.keyStart;
  let end = hasTrailingComma ? after + 1 : target.valueEnd;
  // When the target is the last property, its preceding separator is part of
  // the removal. A middle property keeps that separator (it now joins the
  // previous and next properties).
  if (index > 0 && index === properties.length - 1) {
    const previous = properties[index - 1];
    if (previous) {
      start = previous.valueEnd;
    }
  }
  return `${text.slice(0, start)}${text.slice(end)}`;
}

function validate(
  beforeText: string,
  afterText: string,
  mutate: (data: Record<string, unknown>) => void
): McpTextEdit {
  const before = parseOpencodeConfig(beforeText);
  const after = parseOpencodeConfig(afterText);
  if (before.error || after.error) {
    return {
      status: 'invalid',
      message: 'The edited OpenCode config would not parse, so it was left unchanged.'
    };
  }
  const expected = structuredClone(before.data);
  mutate(expected);
  if (!sameJson(after.data, expected)) {
    return {
      status: 'invalid',
      message: 'The OpenCode config edit changed more than the requested entry, so it was left unchanged.'
    };
  }
  return { status: 'edited', text: afterText };
}

/** Add or update one MCP server entry, preserving unrelated bytes and comments. */
export function upsertMcpServerText(
  text: string,
  serverName: string,
  server: Record<string, unknown>
): McpTextEdit {
  const root = skipTrivia(text, 0);
  if (text[root] !== '{') {
    if (text.trim().length === 0) {
      return {
        status: 'edited',
        text: `${JSON.stringify({ mcp: { [serverName]: server } }, null, 2)}${eol(text)}`
      };
    }
    return {
      status: 'invalid',
      message: 'The OpenCode config root is not a JSON object, so it was left unchanged.'
    };
  }
  const mcp = findProperty(text, root, 'mcp');
  if (mcp.status === 'ambiguous') {
    return {
      status: 'ambiguous',
      message: 'The OpenCode config has more than one "mcp" property, so it was left unchanged.'
    };
  }
  if (mcp.status === 'missing') {
    const inserted = insertProperty(text, root, 'mcp', { [serverName]: server });
    if (inserted === undefined) {
      return { status: 'invalid', message: 'The OpenCode config could not be edited safely.' };
    }
    return validate(text, inserted, (data) => {
      data.mcp = { [serverName]: server };
    });
  }
  const mcpStart = skipTrivia(text, mcp.property.valueStart);
  if (text[mcpStart] !== '{') {
    return {
      status: 'invalid',
      message: 'The OpenCode "mcp" value is not an object, so it was left unchanged.'
    };
  }
  const entry = findProperty(text, mcpStart, serverName);
  if (entry.status === 'ambiguous') {
    return {
      status: 'ambiguous',
      message: `The OpenCode config has more than one "${serverName}" property, so it was left unchanged.`
    };
  }
  if (entry.status === 'missing') {
    const inserted = insertProperty(text, mcpStart, serverName, server);
    if (inserted === undefined) {
      return { status: 'invalid', message: 'The OpenCode config could not be edited safely.' };
    }
    return validate(text, inserted, (data) => {
      const map = asRecord(data.mcp);
      if (map) {
        map[serverName] = server;
      }
    });
  }
  const indent = lineIndent(text, entry.property.valueStart);
  const replacement = formatValue(server, indent);
  const edited = `${text.slice(0, entry.property.valueStart)}${replacement}${text.slice(entry.property.valueEnd)}`;
  return validate(text, edited, (data) => {
    const map = asRecord(data.mcp);
    if (map) {
      map[serverName] = server;
    }
  });
}

/**
 * Remove one MCP server entry, preserving unrelated bytes and comments. When it
 * was the only entry, the empty `mcp` property is removed too (the same shape
 * the parsed fallback used to write).
 */
export function removeMcpServerText(text: string, serverName: string): McpTextEdit {
  const root = skipTrivia(text, 0);
  if (text[root] !== '{') {
    return { status: 'not-found' };
  }
  const mcp = findProperty(text, root, 'mcp');
  if (mcp.status === 'ambiguous') {
    return {
      status: 'ambiguous',
      message: 'The OpenCode config has more than one "mcp" property, so it was left unchanged.'
    };
  }
  if (mcp.status === 'missing') {
    return { status: 'not-found' };
  }
  const mcpStart = skipTrivia(text, mcp.property.valueStart);
  const properties = listProperties(text, mcpStart);
  if (!properties) {
    return {
      status: 'invalid',
      message: 'The OpenCode "mcp" value is not a readable object, so it was left unchanged.'
    };
  }
  const matches = properties.filter((property) => property.key === serverName);
  if (matches.length === 0) {
    return { status: 'not-found' };
  }
  if (matches.length > 1) {
    return {
      status: 'ambiguous',
      message: `The OpenCode config has more than one "${serverName}" property, so it was left unchanged.`
    };
  }
  const edited =
    properties.length === 1 ? removeProperty(text, root, 'mcp') : removeProperty(text, mcpStart, serverName);
  if (edited === undefined) {
    return { status: 'invalid', message: 'The OpenCode config could not be edited safely.' };
  }
  return validate(text, edited, (data) => {
    if (properties.length === 1) {
      delete data.mcp;
      return;
    }
    const map = asRecord(data.mcp);
    if (map) {
      delete map[serverName];
    }
  });
}

/** The parsed command array at `mcp.zvec_grep.command`, when it is an array. */
function parsedCommand(data: Record<string, unknown>): unknown[] | undefined {
  const mcp = asRecord(data.mcp);
  const entry = asRecord(mcp?.[ZVEC_GREP_MCP_SERVER]);
  return Array.isArray(entry?.command) ? (entry.command as unknown[]) : undefined;
}

export function rewriteLegacyZvecCommand(text: string): LegacyZvecRewrite {
  const root = skipTrivia(text, 0);
  const mcp = findProperty(text, root, 'mcp');
  if (mcp.status === 'ambiguous') {
    return {
      status: 'ambiguous',
      message: 'The OpenCode config has more than one "mcp" property, so the zvec-grep entry was not migrated.'
    };
  }
  if (mcp.status !== 'found') {
    return { status: 'no-match' };
  }
  const mcpStart = skipTrivia(text, mcp.property.valueStart);
  const entry = findProperty(text, mcpStart, ZVEC_GREP_MCP_SERVER);
  if (entry.status === 'ambiguous') {
    return {
      status: 'ambiguous',
      message: `The OpenCode config has more than one "${ZVEC_GREP_MCP_SERVER}" property, so it was not migrated.`
    };
  }
  if (entry.status !== 'found') {
    return { status: 'no-match' };
  }
  const entryStart = skipTrivia(text, entry.property.valueStart);
  const command = findProperty(text, entryStart, 'command');
  if (command.status === 'ambiguous') {
    return {
      status: 'ambiguous',
      message: `The "${ZVEC_GREP_MCP_SERVER}" entry has more than one "command" property, so it was not migrated.`
    };
  }
  if (command.status !== 'found') {
    return { status: 'no-match' };
  }
  const arrayStart = skipTrivia(text, command.property.valueStart);
  const args = arrayStrings(text, arrayStart);
  if (!args || args.length < 3) {
    return { status: 'no-match' };
  }
  const executable = args[0];
  const first = args[1];
  const second = args[2];
  if (!executable || !first || !second) {
    return { status: 'no-match' };
  }
  if (first.value === 'server') {
    return { status: 'unchanged' };
  }
  // Only the known argv shape (`[exe, '--server', '--stdio', ...]`) is
  // rewritten textually. Anything else falls back to the parsed migration,
  // which may reorder flags but never guesses.
  if (first.value !== '--server' || second.value !== '--stdio') {
    return { status: 'no-match' };
  }

  const rewritten = `${text.slice(0, first.start)}"server"${text.slice(first.end)}`;
  const before = parseOpencodeConfig(text);
  const after = parseOpencodeConfig(rewritten);
  if (before.error || after.error) {
    return {
      status: 'invalid',
      message: 'The rewritten OpenCode config would not parse, so the zvec-grep entry was left unchanged.'
    };
  }
  const beforeCommand = parsedCommand(before.data);
  const afterCommand = parsedCommand(after.data);
  const expectedCommand = [executable.value, 'server', ...args.slice(2).map((arg) => arg.value)];
  if (!beforeCommand || !afterCommand || !sameJson(afterCommand, expectedCommand)) {
    return {
      status: 'invalid',
      message: 'The zvec-grep command could not be rewritten safely, so the entry was left unchanged.'
    };
  }
  const expectedData = structuredClone(before.data);
  const expectedEntry = asRecord(asRecord(expectedData.mcp)?.[ZVEC_GREP_MCP_SERVER]);
  if (!expectedEntry) {
    return {
      status: 'invalid',
      message: 'The zvec-grep command could not be rewritten safely, so the entry was left unchanged.'
    };
  }
  expectedEntry.command = expectedCommand;
  if (!sameJson(after.data, expectedData)) {
    return {
      status: 'invalid',
      message: 'The rewritten OpenCode config changed more than the zvec-grep command, so it was left unchanged.'
    };
  }
  return { status: 'rewritten', text: rewritten };
}
