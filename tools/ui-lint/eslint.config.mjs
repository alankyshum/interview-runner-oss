import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import { unexpectedColors } from '../../scripts/check-ui-css.mjs';

// Existing screens are a migration ratchet; remove entries as they migrate.
const legacyImports = [];

const localRules = {
  'no-inline-color': {
    meta: { type: 'problem', schema: [], messages: { token: 'Use an --ir-* color token instead of a raw color in style/sx.' } },
    create(context) {
      return {
        JSXAttribute(node) {
          if (!['style', 'styles', 'sx'].includes(node.name.name) || !node.value) return;
          if (unexpectedColors(context.filename, context.sourceCode.getText(node.value)).length) context.report({ node, messageId: 'token' });
        },
        JSXElement(node) {
          if (node.openingElement.name.type !== 'JSXIdentifier' || node.openingElement.name.name !== 'style') return;
          const content = [...node.openingElement.attributes, ...node.children].map((child) => context.sourceCode.getText(child)).join('');
          if (unexpectedColors(context.filename, content).length) context.report({ node, messageId: 'token' });
        },
        TemplateLiteral(node) {
          if (node.parent?.type === 'JSXExpressionContainer') return;
          const source = context.sourceCode.getText(node);
          if (!/(?:`|\{|;)\s*(?:--[\w-]+|color|background[\w-]*|border[\w-]*|outline[\w-]*|text[-\w]*decoration[\w-]*|(?:-webkit-)?filter|fill|stroke[\w-]*)\s*:/i.test(source)) return;
          if (unexpectedColors(context.filename, source).length) context.report({ node, messageId: 'token' });
        },
      };
    },
  },
};

export default [
  { ignores: ['**/node_modules/**'] },
  {
    files: ['src/**/*.{ts,tsx}'],
    languageOptions: { parser: tseslint.parser, parserOptions: { ecmaFeatures: { jsx: true } } },
    plugins: { 'react-hooks': reactHooks },
    rules: { 'react-hooks/rules-of-hooks': 'error' },
  },
  {
    files: ['src/**/*.{ts,tsx}'],
    ignores: ['src/ui/**', 'src/theme.ts', ...legacyImports],
    rules: { 'no-restricted-imports': ['error', { paths: [{ name: '@mantine/core', importNames: ['Button', 'ActionIcon', 'Badge', 'Paper', '*'], message: 'Use the shared src/ui component.' }] }] },
  },
  {
    files: ['src/**/*.{ts,tsx}'],
    ignores: ['src/theme.ts'],
    plugins: { ir: { rules: localRules } },
    rules: { 'ir/no-inline-color': 'error' },
  },
];
