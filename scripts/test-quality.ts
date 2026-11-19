import type ts from '@typescript/typescript6';
import { dirname, extname, relative, sep } from 'node:path';

export const SCAFFOLD_TEST_MARKER = 'INTERVIEW_RUNNER_SCAFFOLD_TEST_REPLACE_WITH_BEHAVIORAL_TESTS';

type FunctionFacts = { assertions: ts.CallExpression[]; behavioralAssertions: number; calls: Set<string>; exercisesSource: boolean };

const modulePath = (testPath: string, sourcePath: string): string => {
  let value = relative(dirname(testPath), sourcePath).split(sep).join('/');
  value = value.slice(0, -extname(value).length);
  return value.startsWith('.') ? value : `./${value}`;
};

function createBehavioralValidator(ts: typeof import('@typescript/typescript6')) {
const importedNames = (source: ts.SourceFile, expectedModule: string): Set<string> => {
  const names = new Set<string>();
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const imported = statement.moduleSpecifier.text.replace(/\.(?:tsx?|jsx?)$/, '');
    if (imported !== expectedModule) continue;
    const clause = statement.importClause;
    if (clause?.name) names.add(clause.name.text);
    if (clause?.namedBindings && ts.isNamespaceImport(clause.namedBindings)) names.add(clause.namedBindings.name.text);
    if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) for (const element of clause.namedBindings.elements) names.add(element.name.text);
  }
  return names;
};

const functionName = (node: ts.Node): string | undefined => {
  if (ts.isFunctionDeclaration(node) && node.name) return node.name.text;
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) return node.name.text;
  return undefined;
};

const functionBody = (node: ts.Node): ts.Node | undefined => {
  if (ts.isFunctionDeclaration(node)) return node.body;
  if (ts.isVariableDeclaration(node) && node.initializer && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) return node.initializer.body;
  return undefined;
};

const expectCall = (call: ts.CallExpression): ts.CallExpression | undefined => {
  let expression: ts.Expression = call.expression;
  while (ts.isPropertyAccessExpression(expression)) expression = expression.expression;
  return ts.isCallExpression(expression) && ts.isIdentifier(expression.expression) && expression.expression.text === 'expect' ? expression : undefined;
};

const factsFor = (body: ts.Node, learnerNames: ReadonlySet<string>, helperNames: ReadonlySet<string>): FunctionFacts => {
  const related = new Set(learnerNames);
  const containsRelatedName = (node: ts.Node): boolean => {
    let found = false;
    const visit = (child: ts.Node): void => { if (!found && ts.isIdentifier(child) && related.has(child.text)) found = true; else if (!found) ts.forEachChild(child, visit); };
    visit(node); return found;
  };
  let changed = true;
  while (changed) {
    changed = false;
    const taint = (node: ts.Node): void => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && containsRelatedName(node.initializer) && !related.has(node.name.text)) {
        related.add(node.name.text); changed = true;
      }
      if (ts.isCallExpression(node) && containsRelatedName(node)) for (const argument of node.arguments) {
        const markArgument = (child: ts.Node): void => {
          if (ts.isIdentifier(child) && !related.has(child.text)) { related.add(child.text); changed = true; }
          else ts.forEachChild(child, markArgument);
        };
        markArgument(argument);
      }
      ts.forEachChild(node, taint);
    };
    taint(body);
  }
  const facts: FunctionFacts = { assertions: [], behavioralAssertions: 0, calls: new Set(), exercisesSource: false };
  let rendersLearnerJsx = false;
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && learnerNames.has(node.text)) facts.exercisesSource = true;
    if ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) && containsRelatedName(node.tagName)) rendersLearnerJsx = true;
    if (ts.isCallExpression(node)) {
      if (expectCall(node)) { facts.assertions.push(node); if (containsRelatedName(node)) facts.behavioralAssertions += 1; }
      if (ts.isIdentifier(node.expression) && helperNames.has(node.expression.text)) facts.calls.add(node.expression.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(body);
  if (rendersLearnerJsx) facts.behavioralAssertions = facts.assertions.length;
  return facts;
};

const staticValue = (node: ts.Expression): boolean => {
  if (ts.isParenthesizedExpression(node)) return staticValue(node.expression);
  if (ts.isStringLiteralLike(node) || ts.isNumericLiteral(node) || node.kind === ts.SyntaxKind.TrueKeyword || node.kind === ts.SyntaxKind.FalseKeyword || node.kind === ts.SyntaxKind.NullKeyword) return true;
  if (ts.isPrefixUnaryExpression(node)) return staticValue(node.operand);
  if (ts.isArrayLiteralExpression(node)) return node.elements.every((element) => ts.isExpression(element) && staticValue(element));
  if (ts.isObjectLiteralExpression(node)) return node.properties.every((property) => ts.isPropertyAssignment(property) && staticValue(property.initializer));
  return false;
};

const isLiteralOnlyAssertion = (assertion: ts.CallExpression): boolean => {
  const expect = expectCall(assertion);
  if (!expect || expect.arguments.length === 0 || !staticValue(expect.arguments[0])) return false;
  return assertion.arguments.length === 0 || assertion.arguments.every(staticValue);
};

const testCall = (call: ts.CallExpression): boolean => {
  let expression: ts.Expression = call.expression;
  if (ts.isPropertyAccessExpression(expression) && ['skip', 'only', 'todo', 'concurrent'].includes(expression.name.text)) expression = expression.expression;
  return ts.isIdentifier(expression) && (expression.text === 'it' || expression.text === 'test');
};

const testTitle = (call: ts.CallExpression, source: ts.SourceFile): string => {
  const title = call.arguments[0];
  if (title && ts.isStringLiteralLike(title)) return title.text;
  const line = source.getLineAndCharacterOfPosition(call.getStart(source)).line + 1;
  return `test at line ${line}`;
};

const callbackBody = (call: ts.CallExpression): ts.Node | undefined => {
  const callback = call.arguments.find((argument): argument is ts.ArrowFunction | ts.FunctionExpression => ts.isArrowFunction(argument) || ts.isFunctionExpression(argument));
  return callback?.body;
};

return function behavioralTestIssues(testPath: string, sourcePath: string, content: string): string[] {
  const issues: string[] = [];
  if (content.includes(SCAFFOLD_TEST_MARKER)) issues.push('unchanged scaffold test marker');
  const kind = testPath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const source = ts.createSourceFile(testPath, content, ts.ScriptTarget.Latest, true, kind);
  const names = importedNames(source, modulePath(testPath, sourcePath));
  if (names.size === 0) issues.push('does not import the learner source module');

  const helpers = new Map<string, ts.Node>();
  const findHelpers = (node: ts.Node): void => {
    const name = functionName(node); const body = functionBody(node);
    if (name && body) helpers.set(name, body);
    ts.forEachChild(node, findHelpers);
  };
  findHelpers(source);
  const helperNames = new Set(helpers.keys());
  const helperFacts = new Map([...helpers].map(([name, body]) => [name, factsFor(body, names, helperNames)]));

  const aggregate = (initial: FunctionFacts): FunctionFacts => {
    const result: FunctionFacts = { assertions: [...initial.assertions], behavioralAssertions: initial.behavioralAssertions, calls: new Set(initial.calls), exercisesSource: initial.exercisesSource };
    const pending = [...initial.calls]; const seen = new Set<string>();
    while (pending.length) {
      const name = pending.pop()!;
      if (seen.has(name)) continue;
      seen.add(name);
      const facts = helperFacts.get(name);
      if (!facts) continue;
      result.assertions.push(...facts.assertions); result.behavioralAssertions += facts.behavioralAssertions; result.exercisesSource ||= facts.exercisesSource;
      for (const called of facts.calls) pending.push(called);
    }
    return result;
  };

  let tests = 0;
  const visitTests = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && testCall(node)) {
      tests += 1;
      const title = testTitle(node, source); const body = callbackBody(node);
      if (!body) issues.push(`test "${title}" has no test callback`);
      else {
        const facts = aggregate(factsFor(body, names, helperNames));
        if (!facts.exercisesSource) issues.push(`test "${title}" never exercises an export from the learner source module`);
        if (facts.assertions.length === 0) issues.push(`test "${title}" has no assertions`);
        else if (facts.assertions.some(isLiteralOnlyAssertion)) issues.push(`test "${title}" contains a literal-only assertion`);
        else if (facts.behavioralAssertions === 0) issues.push(`test "${title}" has no assertion derived from the learner source module`);
      }
    }
    ts.forEachChild(node, visitTests);
  };
  visitTests(source);
  if (tests === 0) issues.push('contains no tests');
  return [...new Set(issues)];
};
}

let validator: Promise<ReturnType<typeof createBehavioralValidator>> | undefined;
export async function behavioralTestIssues(testPath: string, sourcePath: string, content: string): Promise<string[]> {
  const run = await (validator ??= import('@typescript/typescript6').then((module) => createBehavioralValidator(module.default)).catch((error: unknown) => { validator = undefined; throw error; }));
  return run(testPath, sourcePath, content);
}
