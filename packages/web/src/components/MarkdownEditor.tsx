import { useEffect, useRef } from 'react';
import { EditorView, keymap, drawSelection, placeholder } from '@codemirror/view';
import { EditorState, StateEffect } from '@codemirror/state';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { LanguageDescription } from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import { editorTheme } from '../utils/editorTheme';

interface MarkdownEditorProps {
  initial: string;
  onChange: (text: string) => void;
  onDone: () => void;
}

/** Plain CodeMirror with Markdown highlighting, for the PR message. Loaded lazily. */
export default function MarkdownEditor({ initial, onChange, onDone }: MarkdownEditorProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;

  useEffect(() => {
    if (!hostRef.current) return;
    const view = new EditorView({
      parent: hostRef.current,
      state: EditorState.create({
        doc: initial,
        extensions: [
          drawSelection(),
          history(),
          EditorView.lineWrapping,
          editorTheme,
          placeholder('PR title and description (Markdown)'),
          keymap.of([
            { key: 'Mod-Enter', run: () => (onDoneRef.current(), true) },
            { key: 'Escape', run: () => (onDoneRef.current(), true) },
            ...defaultKeymap,
            ...historyKeymap,
          ]),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) onChangeRef.current(update.state.doc.toString());
          }),
        ],
      }),
    });
    view.focus();
    let alive = true;

    LanguageDescription.matchLanguageName(languages, 'markdown')
      ?.load()
      .then((support) => { if (alive) view.dispatch({ effects: StateEffect.appendConfig.of(support) }); })
      .catch(() => { /* plain text */ });

    return () => {
      alive = false;
      view.destroy();
    };
    // Created once; the text then lives in the editor
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <div ref={hostRef} className="pr-message-editor" />;
}
