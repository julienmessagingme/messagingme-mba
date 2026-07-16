'use client';

import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { useT } from '@/lib/i18n';

/** API impérative : insérer du texte (emoji) ou une variable (chip `{{n}}`) au curseur. */
export interface VariableBodyEditorHandle {
  insertToken: (token: string, label?: string) => void;
}

interface Props {
  /** Corps avec les variables au format Meta `{{n}}` (représentation sérialisée, stockée/envoyée telle quelle). */
  value: string;
  /** Libellé lisible par position ({{1}} -> varLabels[0]) : affiché dans le chip. Absent -> chip = `{{n}}`. */
  varLabels: Array<string | undefined>;
  onChange: (next: string) => void;
  placeholder?: string;
  className?: string;
}

const VAR_RE = /\{\{\s*(\d+)\s*\}\}/g;
const CHIP_CLASS = 'mx-0.5 inline-flex items-center rounded bg-brand-100 px-1.5 py-0.5 text-[13px] font-medium text-brand-700 align-baseline';

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** value ({{n}}) -> HTML : runs de texte échappés + chips atomiques (contenteditable=false) portant data-var. */
function toHtml(value: string, labels: Array<string | undefined>): string {
  let html = '';
  let last = 0;
  let m: RegExpExecArray | null;
  VAR_RE.lastIndex = 0;
  while ((m = VAR_RE.exec(value)) !== null) {
    if (m.index > last) html += escapeHtml(value.slice(last, m.index));
    const n = Number(m[1]);
    const label = labels[n - 1];
    html += `<span contenteditable="false" data-var="${n}" class="${CHIP_CLASS}">${escapeHtml(label ?? `{{${n}}}`)}</span>`;
    last = m.index + m[0].length;
  }
  if (last < value.length) html += escapeHtml(value.slice(last));
  return html;
}

/** DOM de l'éditeur -> string {{n}} : texte des nœuds texte + `{{data-var}}` pour les chips + \n pour br/div. */
function serialize(root: HTMLElement): string {
  let out = '';
  const walk = (node: Node): void => {
    node.childNodes.forEach((child) => {
      if (child.nodeType === Node.TEXT_NODE) { out += child.textContent ?? ''; return; }
      if (!(child instanceof HTMLElement)) return;
      if (child.dataset.var) { out += `{{${child.dataset.var}}}`; return; }
      if (child.tagName === 'BR') { out += '\n'; return; }
      if (child.tagName === 'DIV' || child.tagName === 'P') {
        if (out !== '' && !out.endsWith('\n')) out += '\n';
        walk(child);
        return;
      }
      walk(child); // span de style, etc. : on descend
    });
  };
  walk(root);
  return out.replace(/ /g, ' ');
}

function placeCaretEnd(el: HTMLElement): void {
  const sel = window.getSelection();
  if (!sel) return;
  const range = document.createRange();
  range.selectNodeContents(el);
  range.collapse(false);
  sel.removeAllRanges();
  sel.addRange(range);
}

/**
 * Éditeur du corps de template affichant les variables comme des CHIPS lisibles (`[Prénom]`) au lieu du littéral
 * Meta `{{n}}`, tout en exposant au parent la MÊME string `{{n}}` (stockage/envoi inchangés). Éditeur quasi
 * non-contrôlé : on ne réécrit l'innerHTML que lorsque `value` diverge de ce que le DOM sérialise (mutations
 * externes : chargement, insertion via bouton), jamais à chaque frappe -> le caret est préservé. Les libellés des
 * chips se mettent à jour en place (sans toucher au texte) quand `varLabels` arrive (édition d'un template).
 */
export const VariableBodyEditor = forwardRef<VariableBodyEditorHandle, Props>(function VariableBodyEditor(
  { value, varLabels, onChange, placeholder, className },
  ref,
) {
  const t = useT();
  const elRef = useRef<HTMLDivElement>(null);
  // onChange/varLabels lus via refs pour garder des handlers stables (pas de ré-abonnement).
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const labelsRef = useRef(varLabels);
  labelsRef.current = varLabels;

  // Sync value -> DOM UNIQUEMENT si le DOM ne sérialise pas déjà `value` (changement externe). Jamais pendant la
  // frappe (onInput a déjà mis value = serialize(DOM)) -> caret intact.
  useEffect(() => {
    const el = elRef.current;
    if (!el) return;
    if (serialize(el) !== value) {
      el.innerHTML = toHtml(value, labelsRef.current);
      if (document.activeElement === el) placeCaretEnd(el);
    }
  }, [value]);

  // Sync des libellés dans les chips existants, en place (n'affecte pas le caret : les chips sont atomiques).
  useEffect(() => {
    const el = elRef.current;
    if (!el) return;
    el.querySelectorAll<HTMLElement>('[data-var]').forEach((chip) => {
      const n = Number(chip.dataset.var);
      const label = varLabels[n - 1];
      const text = label ?? `{{${n}}}`;
      if (chip.textContent !== text) chip.textContent = text;
    });
  }, [varLabels]);

  useImperativeHandle(ref, () => ({
    insertToken: (token: string, label?: string) => {
      const el = elRef.current;
      if (!el) return;
      el.focus();
      const sel = window.getSelection();
      let range: Range;
      if (sel && sel.rangeCount > 0 && el.contains(sel.anchorNode)) {
        range = sel.getRangeAt(0);
      } else {
        range = document.createRange();
        range.selectNodeContents(el);
        range.collapse(false);
      }
      range.deleteContents();
      const varMatch = /^\{\{\s*(\d+)\s*\}\}$/.exec(token);
      let node: Node;
      if (varMatch) {
        const span = document.createElement('span');
        span.contentEditable = 'false';
        span.dataset.var = varMatch[1]!;
        span.className = CHIP_CLASS;
        span.textContent = label ?? token;
        node = span;
      } else {
        node = document.createTextNode(token);
      }
      range.insertNode(node);
      const after = document.createRange();
      after.setStartAfter(node);
      after.collapse(true);
      sel?.removeAllRanges();
      sel?.addRange(after);
      onChangeRef.current(serialize(el));
    },
  }));

  return (
    <div className="relative">
      <div
        ref={elRef}
        contentEditable
        suppressContentEditableWarning
        role="textbox"
        aria-multiline="true"
        aria-label={t('Corps du message', 'Message body')}
        onInput={(e) => onChangeRef.current(serialize(e.currentTarget))}
        onPaste={(e) => {
          // Colle en TEXTE BRUT (pas de HTML arbitraire dans le contentEditable).
          e.preventDefault();
          const text = e.clipboardData.getData('text/plain');
          const sel = window.getSelection();
          if (!sel || sel.rangeCount === 0) return;
          const range = sel.getRangeAt(0);
          range.deleteContents();
          const tn = document.createTextNode(text);
          range.insertNode(tn);
          range.setStartAfter(tn);
          range.collapse(true);
          sel.removeAllRanges();
          sel.addRange(range);
          onChangeRef.current(serialize(e.currentTarget));
        }}
        className={`min-h-[7.5rem] whitespace-pre-wrap break-words ${className ?? ''}`}
      />
      {value === '' && placeholder && (
        <span className="pointer-events-none absolute left-3 top-2 text-sm text-ink-400">{placeholder}</span>
      )}
    </div>
  );
});
