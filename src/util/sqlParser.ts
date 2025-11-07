import * as vscode from 'vscode';

export type CompletionContextType = 'schema' | 'table' | 'column' | 'routine' | 'keyword';

export interface CompletionContextResult {
  readonly type: CompletionContextType;
  readonly prefix: string;
  readonly owner?: string;
  readonly alias?: string;
  readonly routineCategory?: 'procedure' | 'function' | 'view' | 'any';
}

export interface IdentifierMatch {
  readonly text: string;
  readonly range: vscode.Range;
}

export interface WildcardContext {
  readonly target: {
    readonly schema?: string;
    readonly object: string;
    readonly alias?: string;
  };
  readonly asteriskRange: vscode.Range;
}

export interface QualifiedIdentifierParts {
  readonly database?: string;
  readonly schema?: string;
  readonly object?: string;
}

const TABLE_KEYWORDS = ['from', 'join', 'update', 'into'];
const ROUTINE_KEYWORDS = ['exec', 'execute', 'call'];

export namespace SqlParser {
  export function getIdentifierAtPosition(document: vscode.TextDocument, position: vscode.Position): IdentifierMatch | undefined {
    const wordRange = document.getWordRangeAtPosition(position, /[\w\[\]\.]+/);
    if (!wordRange) {
      return undefined;
    }

    const text = document.getText(wordRange).replace(/[\[\]]/g, '');
    return {
      text,
      range: wordRange
    };
  }

  export function analyzeCompletionContext(document: vscode.TextDocument, position: vscode.Position): CompletionContextResult {
    const linePrefix = document.lineAt(position.line).text.substring(0, position.character);
    const routineContext = detectRoutineContext(linePrefix);
    if (routineContext) {
      return routineContext;
    }

    const trimmedPrefix = linePrefix.trimEnd();
    const lastChar = trimmedPrefix.at(-1) ?? '';

    if (lastChar === '.') {
      const owner = extractOwnerBeforeDot(trimmedPrefix);
      return {
        type: 'column',
        owner,
        prefix: '',
        alias: owner
      };
    }

    const token = getLastToken(trimmedPrefix);
    if (token.includes('.')) {
      const [ownerPart, partial] = splitToken(token);
      const owner = ownerPart?.replace(/[\[\]]/g, '') ?? '';
      return {
        type: 'column',
        owner,
        alias: owner,
        prefix: partial?.replace(/[\[\]]/g, '') ?? ''
      };
    }

    const prefixWord = getLastWord(trimmedPrefix);
    const lowerWord = prefixWord.toLowerCase();

    if (TABLE_KEYWORDS.includes(lowerWord)) {
      return { type: 'table', prefix: '' };
    }

    if (ROUTINE_KEYWORDS.includes(lowerWord)) {
      return { type: 'routine', prefix: '' };
    }

    if (lowerWord === 'select' || lowerWord === 'where' || lowerWord === 'and' || lowerWord === 'or') {
      return { type: 'keyword', prefix: '' };
    }

    // Default heuristics: if we are at start or after comma, suggest columns by default.
    if (/[,()]\s*$/.test(trimmedPrefix)) {
      return { type: 'column', prefix: '' };
    }

    return { type: 'table', prefix: prefixWord };
  }

  export function findWildcardContext(document: vscode.TextDocument, position: vscode.Position): WildcardContext | undefined {
    const text = document.getText();
    const originalOffset = document.offsetAt(position);
    let asteriskOffset = originalOffset;

    if (text.charAt(asteriskOffset) !== '*') {
      if (asteriskOffset === 0 || text.charAt(asteriskOffset - 1) !== '*') {
        return undefined;
      }
      asteriskOffset -= 1;
    }

    const asteriskRange = new vscode.Range(
      document.positionAt(asteriskOffset),
      document.positionAt(asteriskOffset + 1)
    );

    const afterText = text.slice(asteriskOffset + 1);
    const normalizedAfter = afterText.replace(/\s+/g, ' ').trim();
    if (!normalizedAfter) {
      return undefined;
    }

    const lowerAfter = normalizedAfter.toLowerCase();
    const fromIndex = lowerAfter.indexOf('from ');
    if (fromIndex === -1) {
      return undefined;
    }

    const afterFrom = normalizedAfter.slice(fromIndex + 5).trim();
    if (!afterFrom) {
      return undefined;
    }

    const [rawTableToken, ...remainingTokens] = afterFrom.split(' ');
    let tableToken = rawTableToken?.replace(/[;,]/g, '');
    if (!tableToken) {
      return undefined;
    }

    const { schema, object } = parseTableToken(tableToken);
    if (!object) {
      return undefined;
    }

    const aliasFromFromClause = extractAliasFromTokens(remainingTokens);

    const beforeText = text.slice(0, asteriskOffset);
    const ownerMatch = /([\w\[\]\.]+)\.\s*$/.exec(beforeText);
    const qualifier = ownerMatch ? ownerMatch[1].trim() : undefined;
    const alias = qualifier ?? aliasFromFromClause;

    return {
      target: { schema, object, alias },
      asteriskRange
    };
  }

  function detectRoutineContext(linePrefix: string): CompletionContextResult | undefined {
    const execMatch = /\b(exec(?:ute)?|call)\s+([\w\[\]\.\s]*)$/i.exec(linePrefix);
    if (execMatch) {
      return buildRoutineContext(execMatch[2], 'procedure');
    }

    const ddlMatch = /\b(?:create\s+or\s+alter|create|alter|drop)\s+(procedure|proc|function|view)\s+([\w\[\]\.\s]*)$/i.exec(linePrefix);
    if (ddlMatch) {
      const category = determineRoutineCategory(ddlMatch[1]);
      return buildRoutineContext(ddlMatch[2], category);
    }

    return undefined;
  }

  function buildRoutineContext(token: string | undefined, category: 'procedure' | 'function' | 'view' | 'any'): CompletionContextResult {
    const { schema, prefix } = parseRoutineToken(token ?? '');
    return {
      type: 'routine',
      prefix,
      owner: schema,
      routineCategory: category
    };
  }

  function parseRoutineToken(token: string): { schema?: string; prefix: string } {
    const trimmed = token.trim();
    if (!trimmed) {
      return { prefix: '' };
    }

  const withoutBrackets = trimmed.replace(/[\[\]]/g, '');
  const normalized = withoutBrackets.replace(/\s*\.\s*/g, '.');
    const parts = normalized.split('.');
    const prefixPart = parts.pop() ?? '';
    let schemaPart: string | undefined;

    while (parts.length > 0 && !schemaPart) {
      const candidate = parts.pop();
      if (candidate) {
        schemaPart = candidate;
      }
    }

    return {
      schema: schemaPart,
      prefix: prefixPart
    };
  }

  function determineRoutineCategory(keyword: string): 'procedure' | 'function' | 'view' | 'any' {
    const lower = keyword.toLowerCase();
    if (lower === 'view') {
      return 'view';
    }
    if (lower === 'function') {
      return 'function';
    }
    return 'procedure';
  }

  function extractOwnerBeforeDot(text: string): string {
    const withoutTrailingDot = text.slice(0, -1);
    const match = /([\w\]\[]+)$/.exec(withoutTrailingDot);
    return match ? match[1].replace(/[\[\]]/g, '') : '';
  }

  function getLastWord(prefix: string): string {
    const match = /([A-Za-z_][\w\$]*)$/i.exec(prefix);
    return match ? match[1] : '';
  }

  function getLastToken(prefix: string): string {
    const match = /([\w\[\]\.]+)$/.exec(prefix);
    return match ? match[1] : '';
  }

  function splitToken(token: string): [string | undefined, string | undefined] {
    const index = token.lastIndexOf('.');
    if (index === -1) {
      return [undefined, token];
    }
    const owner = token.slice(0, index);
    const partial = token.slice(index + 1);
    return [owner, partial];
  }

  function parseTableToken(token: string): { schema?: string; object?: string } {
    const parts = token.split('.').filter(Boolean);
    if (!parts.length) {
      return {};
    }

    const objectPart = parts.pop();
    if (!objectPart) {
      return {};
    }

    const schemaPart = parts.pop();

    return {
      schema: schemaPart ? stripBrackets(schemaPart) : undefined,
      object: stripBrackets(objectPart)
    };
  }

  function extractAliasFromTokens(tokens: string[]): string | undefined {
    if (!tokens.length) {
      return undefined;
    }

    const aliasTokens = [...tokens];
    let candidate = aliasTokens.shift()?.replace(/[;,]/g, '') ?? '';
    if (!candidate) {
      return undefined;
    }

    if (candidate.toLowerCase() === 'as') {
      candidate = aliasTokens.shift()?.replace(/[;,]/g, '') ?? '';
    }

    if (!candidate || isAliasBoundary(candidate)) {
      return undefined;
    }

    return stripBrackets(candidate);
  }

  export function parseQualifiedIdentifier(identifier: string): QualifiedIdentifierParts {
    const parts = tokenizeQualifiedIdentifier(identifier);
    if (!parts.length) {
      return {};
    }

    const object = stripBrackets(parts.pop() ?? '');
    let schema: string | undefined;
    let database: string | undefined;

    if (parts.length) {
      schema = stripBrackets(parts.pop() ?? '');
    }

    if (parts.length) {
      database = stripBrackets(parts.pop() ?? '');
    }

    return {
      database: normalizeIdentifierPart(database),
      schema: normalizeIdentifierPart(schema),
      object: normalizeIdentifierPart(object)
    };
  }

  function tokenizeQualifiedIdentifier(identifier: string): string[] {
    const parts: string[] = [];
    let current = '';
    let bracketDepth = 0;

    for (const char of identifier) {
      if (char === '[') {
        bracketDepth += 1;
        current += char;
        continue;
      }

      if (char === ']') {
        bracketDepth = Math.max(0, bracketDepth - 1);
        current += char;
        continue;
      }

      if (char === '.' && bracketDepth === 0) {
        if (current.trim().length > 0) {
          parts.push(current.trim());
        }
        current = '';
        continue;
      }

      current += char;
    }

    if (current.trim().length > 0) {
      parts.push(current.trim());
    }

    return parts;
  }

  function normalizeIdentifierPart(value: string | undefined): string | undefined {
    if (!value) {
      return undefined;
    }
    const trimmed = value.trim();
    return trimmed.length ? trimmed : undefined;
  }

  function stripBrackets(value: string): string {
    return value.replace(/[\[\]]/g, '');
  }

  function isAliasBoundary(value: string): boolean {
    const reserved = new Set([
      'apply',
      'cross',
      'inner',
      'join',
      'left',
      'outer',
      'right',
      'full',
      'where',
      'group',
      'order',
      'having',
      'union',
      'intersect',
      'except',
      'limit',
      'offset',
      'fetch',
      'with',
      'on',
      'using'
    ]);

    return reserved.has(value.toLowerCase());
  }
}
