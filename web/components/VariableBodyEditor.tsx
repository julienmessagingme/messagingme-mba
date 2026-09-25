'use client';

import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { useT } from '@/lib/i18n';

/** API impérative : insérer du texte (emoji) ou une variable (chip `{{n}}`) au curseur. */
export interface VariableBodyEditorHandle {
  insertToken: (token: string, label?: string) => void;
}

interface Props {
  /** Corps avec ses variables (représentation sérialisée, stockée/envoyée telle quelle). */
  value: string;
  /**
   * Libellé lisible d'une variable, affiché dans le chip. Reçoit le NOM brut de la variable : `"1"` pour un
   * template Meta (variables positionnelles), `"prenom"` pour un message RCS (variables nommées). `undefined`
   * -> le chip affiche le littéral `{{nom}}`.
   */
  labelOf: (nom: string) => string | undefined;
  /**
   * Ce qui compte comme variable. Défaut : les positions Meta `{{1}}`. Un message RCS passe le motif NOMMÉ.
   *
   * ⚠️ Doit être global (`g`) et capturer le nom en groupe 1. Le motif décide de ce qui devient un chip
   * ATOMIQUE : trop large, il transformerait du texte ordinaire en jeton non modifiable.
   */
  varPattern?: RegExp;
  onChange: (next: string) => void;
  placeholder?: string;
  className?: string;
  /** Posé sur la zone éditable elle-même, pour que les tests la remplissent comme un champ ordinaire. */
  testId?: string;
}

/** Positions Meta `{{1}}`, `{{2}}`… Défaut historique. */
const VAR_RE = /\{\{\s*(\d+)\s*\}\}/g;
/** Variables NOMMÉES `{{prenom}}` : celles d'un message RCS et d'un modèle d'email. */
export const NAMED_VAR_RE = /\{\{\s*([\w.-]+)\s*\}\}/g;
const CHIP_CLASS = 'mx-0.5 inline-flex items-center rounded bg-brand-100 px-1.5 py-0.5 text-sm font-medium text-brand-700 align-baseline';

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** value -> HTML : runs de texte échappés + chips atomiques (contenteditable=false) portant data-var. */
function toHtml(value: string, labelOf: (nom: string) => string | undefined, motif: RegExp): string {
  let html = '';
  let last = 0;
  let m: RegExpExecArray | null;
  motif.lastIndex = 0;
  while ((m = motif.exec(value)) !== null) {
    if (m.index > last) html += escapeHtml(value.slice(last, m.index));
    const nom = m[1]!;
    html += `<span contenteditable="false" data-var="${escapeHtml(nom)}" class="${CHIP_CLASS}">${escapeHtml(labelOf(nom) ?? `{{${nom}}}`)}</span>`;
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
  { value, labelOf, varPattern, onChange, placeholder, className, testId },
  ref,
) {
  const t = useT();
  const motif = varPattern ?? VAR_RE;
  const elRef = useRef<HTMLDivElement>(null);
  // onChange/labelOf lus via refs pour garder des handlers stables (pas de ré-abonnement).
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const labelsRef = useRef(labelOf);
  labelsRef.current = labelOf;

  // Sync value -> DOM UNIQUEMENT si le DOM ne sérialise pas déjà `value` (changement externe). Jamais pendant la
  // frappe (onInput a déjà mis value = serialize(DOM)) -> caret intact.
  useEffect(() => {
    const el = elRef.current;
    if (!el) return;
    if (serialize(el) !== value) {
      el.innerHTML = toHtml(value, labelsRef.current, motif);
      if (document.activeElement === el) placeCaretEnd(el);
    }
  }, [value]);

  // Sync des libellés dans les chips existants, en place (n'affecte pas le caret : les chips sont atomiques).
  useEffect(() => {
    const el = elRef.current;
    if (!el) return;
    el.querySelectorAll<HTMLElement>('[data-var]').forEach((chip) => {
      const nom = chip.dataset.var ?? '';
      const text = labelOf(nom) ?? `{{${nom}}}`;
      if (chip.textContent !== text) chip.textContent = text;
    });
  }, [labelOf]);

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
      // Un jeton `{{…}}` devient un chip ATOMIQUE ; tout le reste (un emoji) est du texte ordinaire.
      const varMatch = /^\{\{\s*([\w.-]+)\s*\}\}$/.exec(token);
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
        {...(testId ? { 'data-testid': testId } : {})}
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
