import { EditorView } from '@codemirror/view';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';

/**
 * Editor colors come from the same CSS variables as the diff view, so the editor
 * matches the diff and follows the light/dark theme without reconfiguration.
 */
const highlightStyle = HighlightStyle.define([
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment, t.meta], color: 'var(--syntax-comment)' },
  { tag: [t.keyword, t.controlKeyword, t.operatorKeyword, t.definitionKeyword, t.moduleKeyword, t.modifier, t.self], color: 'var(--syntax-keyword)' },
  { tag: [t.string, t.special(t.string), t.character, t.attributeValue], color: 'var(--syntax-string)' },
  { tag: [t.regexp, t.escape], color: 'var(--syntax-regex)' },
  { tag: [t.number, t.bool, t.null, t.atom, t.constant(t.name), t.propertyName, t.tagName, t.attributeName], color: 'var(--syntax-property)' },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.definition(t.function(t.variableName)), t.typeName, t.className, t.standard(t.typeName)], color: 'var(--syntax-function)' },
  { tag: [t.operator, t.derefOperator, t.url, t.processingInstruction], color: 'var(--syntax-operator)' },
  { tag: [t.punctuation, t.bracket, t.separator], color: 'var(--syntax-punctuation)' },
  { tag: t.deleted, color: 'var(--syntax-deleted)' },
  { tag: t.inserted, color: 'var(--syntax-inserted)' },
  { tag: t.strong, fontWeight: 'bold' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.heading, fontWeight: 'bold', color: 'var(--syntax-keyword)' },
  { tag: t.link, textDecoration: 'underline' },
  { tag: t.invalid, color: 'var(--color-danger)' },
]);

const editorChrome = EditorView.theme({
  '&': {
    color: 'var(--color-text-primary)',
    backgroundColor: 'var(--color-deep-bg)',
  },
  '.cm-content': { caretColor: 'var(--color-text-primary)' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--color-text-primary)' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
    backgroundColor: 'var(--diff-code-selected-background-color)',
  },
  '.cm-activeLine': { backgroundColor: 'var(--color-surface-bg)' },
  '.cm-gutters': {
    backgroundColor: 'var(--color-surface-bg)',
    color: 'var(--color-text-muted)',
    borderRight: '1px solid var(--color-border-default)',
  },
  '.cm-activeLineGutter': { backgroundColor: 'var(--color-elevated-bg)', color: 'var(--color-text-primary)' },
  '&.cm-focused .cm-matchingBracket': { backgroundColor: 'var(--color-elevated-bg)', outline: '1px solid var(--color-border-default)' },
});

export const editorTheme = [editorChrome, syntaxHighlighting(highlightStyle)];
