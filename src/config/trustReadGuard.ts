/**
 * A static guard for the trust boundary: which reads would let a workspace
 * value reach a trust-sensitive setting.
 *
 * The runtime rules live in `trust.ts` — only `globalValue ?? defaultValue`
 * is ever read. This module reads the *source* instead, so a future edit that
 * re-introduces an effective-value read fails a test even when the helper
 * tests still pass.
 *
 * The form the earlier guard missed is the **section-relative** read:
 *
 * ```ts
 * vscode.workspace.getConfiguration('melink.codex').get('path')
 * ```
 *
 * A fully-qualified-key pattern does not match it, because the key in the
 * source is `path`, not `melink.codex.path`. This module resolves the
 * section, so the read is found whether the configuration object is used
 * inline, through a variable, or through a destructured `get`.
 *
 * The section does not have to be a string literal either: the pre-rework
 * source read `getConfiguration(DEFAULTS_SECTION).get('permissionLevel')`,
 * where the section is a module-level constant. The section is therefore
 * resolved through the file's own constant bindings, so a constant section is
 * found as readily as a literal one.
 *
 * Host-free and string-in/string-out, so it can be pointed at a synthetic
 * snippet in a test as easily as at a source file.
 */

/**
 * The trust-sensitive sections and the leaf keys each one owns.
 *
 * A section is the part VS Code's `getConfiguration(section)` scopes to; a
 * leaf key is what `get(key)` is then called with.
 */
export const TRUST_SENSITIVE_SECTIONS: Readonly<Record<string, readonly string[]>> = {
  'melink.ollama': ['baseUrl'],
  'melink.ollama.opencode': ['cliSource', 'path'],
  'melink.codex': ['path'],
  'melink.skills.zvecGrep': ['cliSource', 'path'],
  'melink.skills.astGrep': ['cliSource', 'path'],
  'melink.defaults': ['permissionLevel']
};

/** The fully-qualified trust-sensitive keys. */
export const TRUST_SENSITIVE_KEYS: readonly string[] = [
  'melink.ollama.baseUrl',
  'melink.ollama.opencode.path',
  'melink.ollama.opencode.cliSource',
  'melink.codex.path',
  'melink.skills.zvecGrep.path',
  'melink.skills.zvecGrep.cliSource',
  'melink.skills.astGrep.path',
  'melink.skills.astGrep.cliSource',
  'melink.defaults.permissionLevel'
];

/** One effective-value read the guard found. */
export interface EffectiveRead {
  /** The fully-qualified key that would be read with the merged value. */
  key: string;
  /** The source form that triggered it, for the failure message. */
  form: string;
}

/**
 * The constant bindings in one source file.
 *
 * `literals` holds `const NAME = 'text'`; `aliases` holds `const NAME =
 * OTHER`, so a section constant that is itself built from a constant still
 * resolves. The two are kept apart because a literal value and a name it
 * could be chained to look the same otherwise.
 */
interface SourceConstants {
  literals: Map<string, string>;
  aliases: Map<string, string>;
}

/** The `const NAME = 'text'` and `const NAME = OTHER` bindings in a file. */
function sourceConstants(text: string): SourceConstants {
  const literals = new Map<string, string>();
  const aliases = new Map<string, string>();

  const literal = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(['"])([^'"\n]*)\2/g;
  let match: RegExpExecArray | null;
  while ((match = literal.exec(text)) !== null) {
    literals.set(match[1], match[3]);
  }

  // A constant bound to another constant. A call is not an alias, so
  // `= name(` is skipped; the word boundary keeps the match from
  // backtracking into a shorter, wrong name.
  const alias = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([A-Za-z_$][\w$]*)\b(?!\s*[([{])/g;
  while ((match = alias.exec(text)) !== null) {
    aliases.set(match[1], match[2]);
  }

  return { literals, aliases };
}

/**
 * Resolve a name to the string it is bound to.
 *
 * A chain of constants is followed (`const A = 'x'; const B = A;` resolves
 * `B` to `x`); a cycle resolves to nothing rather than looping.
 */
function resolveIdentifier(name: string, constants: SourceConstants): string | undefined {
  const seen = new Set<string>();
  let current = name;
  while (!seen.has(current)) {
    seen.add(current);
    const literal = constants.literals.get(current);
    if (literal !== undefined) {
      return literal;
    }
    const alias = constants.aliases.get(current);
    if (alias === undefined) {
      return undefined;
    }
    current = alias;
  }
  return undefined;
}

/**
 * Resolve a template literal's body to the text it stands for.
 *
 * Every substitution must resolve to a constant; otherwise the template
 * names something the file does not define, and the read is not resolvable.
 */
function resolveTemplate(body: string, constants: SourceConstants): string | undefined {
  let resolved = '';
  const parts = body.split(/\$\{([^}]*)\}/g);
  for (let index = 0; index < parts.length; index += 1) {
    if (index % 2 === 0) {
      resolved += parts[index];
      continue;
    }
    const value = resolveIdentifier(parts[index].trim(), constants);
    if (value === undefined) {
      return undefined;
    }
    resolved += value;
  }
  return resolved.length > 0 ? resolved : undefined;
}

/**
 * Resolve a section expression to the settings section it names.
 *
 * A literal (`'melink.codex'`), a constant bound to one (`DEFAULTS_SECTION`)
 * — including a constant bound to another constant — and a template literal
 * (`` `${CODEX_SECTION}` ``) all resolve; anything else does not.
 */
function resolveSection(expression: string, constants: SourceConstants): string | undefined {
  const trimmed = expression.trim().replace(/,+$/, '').trim();
  const literal = /^(['"])([^'"]*)\1$/.exec(trimmed);
  if (literal) {
    return literal[2];
  }
  const template = /^`([^`]*)`$/.exec(trimmed);
  if (template) {
    return resolveTemplate(template[1], constants);
  }
  return resolveIdentifier(trimmed, constants);
}

/**
 * Resolve a key expression to the fully-qualified key it names.
 *
 * A literal (`'path'`, `'melink.codex.path'`) and a template literal with
 * constant substitutions (`` `${CODEX_SECTION}.path` ``) both resolve.
 */
function resolveKey(
  expression: string,
  section: string | undefined,
  constants: SourceConstants
): { key: string; leaf: string } | undefined {
  const trimmed = expression.trim();
  const literal = /^(['"])([^'"]*)\1$/.exec(trimmed);
  if (literal) {
    const value = literal[2];
    if (value.includes('.')) {
      return { key: value, leaf: value.slice(value.lastIndexOf('.') + 1) };
    }
    return section ? { key: `${section}.${value}`, leaf: value } : undefined;
  }
  const template = /^`([^`]*)`$/.exec(trimmed);
  if (template) {
    const resolved = resolveTemplate(template[1], constants);
    if (resolved === undefined) {
      return undefined;
    }
    if (resolved.includes('.')) {
      return { key: resolved, leaf: resolved.slice(resolved.lastIndexOf('.') + 1) };
    }
    return section ? { key: `${section}.${resolved}`, leaf: resolved } : undefined;
  }
  return undefined;
}

/** The leaves that are trust-sensitive for one section. */
function sensitiveLeaves(section: string): readonly string[] {
  return TRUST_SENSITIVE_SECTIONS[section] ?? [];
}

/** One `getConfiguration(...)` call in a source file. */
interface ConfigurationCall {
  /** The raw text of the section argument. */
  arg: string;
  /** The index of the `getConfiguration` token. */
  start: number;
  /** The index just after the closing parenthesis. */
  end: number;
}

/**
 * Every `getConfiguration(...)` call in a source file.
 *
 * The argument is read with balanced parentheses, so a section expression
 * that contains a call (`getConfiguration(sectionFor('melink.codex'))`) is
 * still one argument rather than a truncated one.
 */
function configurationCalls(text: string): ConfigurationCall[] {
  const calls: ConfigurationCall[] = [];
  const pattern = /getConfiguration\s*\(/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const argStart = match.index + match[0].length;
    let depth = 1;
    let index = argStart;
    while (index < text.length && depth > 0) {
      const char = text[index];
      if (char === '(') {
        depth += 1;
      } else if (char === ')') {
        depth -= 1;
      }
      index += 1;
    }
    if (depth !== 0) {
      continue;
    }
    calls.push({ arg: text.slice(argStart, index - 1), start: match.index, end: index });
  }
  return calls;
}

/**
 * The identifiers bound to a configuration object for one section.
 *
 * Handles the three shapes a read can take:
 *
 * - inline: `getConfiguration('melink.codex').get('path')`
 * - through a variable: `const config = getConfiguration('melink.codex')`
 * - through a destructured `get`: `const { get } = getConfiguration('melink.codex')`
 */
function bindingsFor(
  calls: readonly ConfigurationCall[],
  text: string,
  section: string,
  constants: SourceConstants
): string[] {
  const names: string[] = [];
  for (const call of calls) {
    const resolved = resolveSection(call.arg, constants);
    if (resolved !== section) {
      continue;
    }
    // The statement that holds the call: from the previous `;` to the call.
    const before = text.slice(0, call.start);
    const statementStart = before.lastIndexOf(';');
    const statement = before.slice(statementStart + 1);
    const identifier = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/.exec(statement);
    if (identifier) {
      names.push(identifier[1]);
    }
    const destructured = /\b(?:const|let|var)\s*\{([^}]*)\}\s*=/.exec(statement);
    if (destructured) {
      for (const entry of destructured[1].split(',')) {
        const alias = /^\s*get\s*(?::\s*([A-Za-z_$][\w$]*))?\s*$/.exec(entry);
        if (alias) {
          names.push(alias[1] ?? 'get');
        }
      }
    }
  }
  return names;
}

/**
 * Every effective-value read of a trust-sensitive key in one source file.
 *
 * An empty result means the file reads no trust-sensitive key with the
 * merged (workspace-aware) value.
 */
export function findEffectiveReads(text: string): EffectiveRead[] {
  const constants = sourceConstants(text);
  const calls = configurationCalls(text);
  const reads: EffectiveRead[] = [];
  const seen = new Set<string>();

  const record = (key: string, form: string): void => {
    if (!TRUST_SENSITIVE_KEYS.includes(key)) {
      return;
    }
    const marker = `${key}::${form}`;
    if (seen.has(marker)) {
      return;
    }
    seen.add(marker);
    reads.push({ key, form });
  };

  // 1. Inline reads: `getConfiguration('melink.codex').get('path')` and
  //    `getConfiguration(CODEX_SECTION).get('path')`.
  for (const call of calls) {
    const section = resolveSection(call.arg, constants);
    if (section === undefined) {
      continue;
    }
    const leaves = sensitiveLeaves(section);
    if (leaves.length === 0) {
      continue;
    }
    const after = text.slice(call.end);
    const inline = /^\s*\.\s*get(?:<[^>]*>)?\s*\(\s*(['"][^'"]*['"]|`[^`]*`)/.exec(after);
    if (!inline) {
      continue;
    }
    const argument = call.arg.trim();
    const literal = /^(['"])([^'"]*)\1$/.exec(inline[1]);
    if (literal) {
      const leaf = literal[2];
      if (leaves.includes(leaf)) {
        record(`${section}.${leaf}`, `getConfiguration(${argument}).get('${leaf}')`);
      }
      continue;
    }
    const resolved = resolveKey(inline[1], section, constants);
    if (resolved && leaves.includes(resolved.leaf)) {
      record(resolved.key, `getConfiguration(${argument}).get('${resolved.leaf}')`);
    }
  }

  // 2. Reads through a bound configuration object.
  for (const [section, leaves] of Object.entries(TRUST_SENSITIVE_SECTIONS)) {
    for (const binding of bindingsFor(calls, text, section, constants)) {
      const escaped = binding.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      // `config.get('path')` and `config['path']`.
      const member = new RegExp(
        `\\b${escaped}\\s*(?:\\.\\s*get(?:<[^>]*>)?\\s*\\(\\s*|\\[\\s*)(['"])([^'"]*)\\1`,
        'g'
      );
      let found: RegExpExecArray | null;
      while ((found = member.exec(text)) !== null) {
        if (!leaves.includes(found[2])) {
          continue;
        }
        record(`${section}.${found[2]}`, `${binding}.get('${found[2]}')`);
      }
      // A destructured `get`: `get('path')`.
      const direct = new RegExp(`\\b${escaped}\\s*\\(\\s*(['"])([^'"]*)\\1`, 'g');
      let directFound: RegExpExecArray | null;
      while ((directFound = direct.exec(text)) !== null) {
        if (!leaves.includes(directFound[2])) {
          continue;
        }
        record(`${section}.${directFound[2]}`, `${binding}('${directFound[2]}')`);
      }
    }
  }

  // 3. Fully-qualified reads: `.get('melink.codex.path')` and the
  //    template-literal form (`` `${CODEX_SECTION}.path` ``).
  const qualified = /\.\s*get(?:<[^>]*>)?\(\s*(['"][^'"]*['"]|`[^`]*`)\s*[),]/g;
  let qualifiedFound: RegExpExecArray | null;
  while ((qualifiedFound = qualified.exec(text)) !== null) {
    const resolved = resolveKey(qualifiedFound[1], undefined, constants);
    if (!resolved) {
      continue;
    }
    record(resolved.key, `.get(${qualifiedFound[1]})`);
  }

  return reads;
}
