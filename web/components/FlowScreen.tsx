'use client';

import type { FlowFieldType, FlowTextKind, FlowElement } from '@/lib/api';
import { useT } from '@/lib/i18n';

/**
 * Rendu FIDÈLE d'un écran WhatsApp Flow, tel que le client le voit dans WhatsApp : cadre téléphone, en-tête
 * clair avec le titre, champs « Material » à label flottant, choix en lignes, image pleine largeur, bouton
 * final vert épinglé. Partagé par le constructeur (aperçu en direct) ET la liste (popup au clic sur le nom),
 * pour un seul rendu de référence. Couleurs WhatsApp en dur (on imite son UI, pas la charte MM).
 */

/** Élément normalisé d'écran (source commune builder + liste). Image `src` = data-url prête à l'affichage.
 *  `condition` : texte du badge « visible si » (ex. « Rappel ? = Oui »), calculé par l'appelant ; absent = pas de badge. */
export type FlowScreenElement = (
  | { kind: FlowTextKind; text: string }
  | { kind: 'image'; src: string | null }
  | { kind: 'field'; label: string; type: FlowFieldType; required: boolean; options: string[] }
) & { condition?: string };

/** Texte de condition « <libellé> = <valeur> » commun builder/liste. Le préfixe localisé (« Visible si »)
 *  est posé au rendu du badge, pas ici (fonction hors composant, pas de useT). Booléen -> ✓ / ✗. */
export function conditionText(label: string, op: 'eq' | 'neq', value: string | boolean): string {
  const val = typeof value === 'boolean' ? (value ? '✓' : '✗') : (value || '…');
  return `${label} ${op === 'eq' ? '=' : '≠'} ${val}`;
}

/** Passe des `FlowElement` stockés (champ avec clé, image en base64 brut) au format d'écran.
 *  `resolveLabel` (optionnel) : clé du champ source -> libellé, pour construire le badge de condition
 *  depuis `visibleIf`. Sans lui, pas de badge (cas miniatures). */
export function fromFlowElements(elements: FlowElement[], resolveLabel?: (fieldKey: string) => string | null): FlowScreenElement[] {
  return elements.map((e): FlowScreenElement => {
    let condition: string | undefined;
    if (e.visibleIf && resolveLabel) {
      const label = resolveLabel(e.visibleIf.fieldKey);
      if (label) condition = conditionText(label, e.visibleIf.op, e.visibleIf.value);
    }
    const cond = condition ? { condition } : {};
    if (e.kind === 'image') return { kind: 'image', src: e.src ? (e.src.startsWith('data:') ? e.src : `data:image/jpeg;base64,${e.src}`) : null, ...cond };
    if (e.kind === 'field') return { kind: 'field', label: e.label, type: e.type, required: e.required, options: e.options ?? [], ...cond };
    return { kind: e.kind, text: e.text, ...cond };
  });
}

const INK = '#111b21'; // texte principal WhatsApp
const MUTED = '#667781'; // texte secondaire
const BORDER = '#d1d7db'; // bordure des champs
const GREEN = '#008069'; // vert bouton WhatsApp

/** Champ « Material » à label flottant (le label chevauche la bordure supérieure). */
function OutlinedField({ label, required, children, trailing }: { label: string; required: boolean; children: React.ReactNode; trailing?: React.ReactNode }) {
  const t = useT();
  return (
    <div className="relative rounded-lg border px-3 pb-2 pt-3" style={{ borderColor: BORDER }}>
      <span className="absolute -top-2 left-2.5 bg-white px-1 text-[11px]" style={{ color: MUTED }}>
        {label || t('Champ', 'Field')}{required ? ' *' : ''}
      </span>
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-[14px]" style={{ color: '#8696a0' }}>{children}</span>
        {trailing && <span style={{ color: MUTED }}>{trailing}</span>}
      </div>
    </div>
  );
}

function ScreenField({ el }: { el: Extract<FlowScreenElement, { kind: 'field' }> }) {
  const t = useT();
  const opts = el.options.map((o) => o.trim()).filter((o) => o !== '');
  if (el.type === 'optin') {
    return (
      <label className="flex items-start gap-2.5 text-[13px]" style={{ color: '#3b4a54' }}>
        <span className="mt-0.5 h-[18px] w-[18px] shrink-0 rounded border" style={{ borderColor: '#8696a0' }} />
        <span>{el.label || t('Je consens…', 'I consent…')}{el.required ? ' *' : ''}</span>
      </label>
    );
  }
  if (el.type === 'radio' || el.type === 'checkbox') {
    const shown = opts.length ? opts : ['Option 1', 'Option 2'];
    const round = el.type === 'radio';
    return (
      <div>
        <div className="mb-1.5 text-[13px] font-medium" style={{ color: INK }}>{el.label || t('Choix', 'Choice')}{el.required ? ' *' : ''}</div>
        <div className="overflow-hidden rounded-lg border" style={{ borderColor: BORDER }}>
          {shown.map((o, i) => (
            <div key={i} className={`flex items-center justify-between px-3 py-2.5 text-[14px] ${i > 0 ? 'border-t' : ''}`} style={{ color: INK, borderColor: '#eef0f1' }}>
              <span className="truncate">{o}</span>
              <span className={`h-[18px] w-[18px] shrink-0 border ${round ? 'rounded-full' : 'rounded'}`} style={{ borderColor: '#8696a0' }} />
            </div>
          ))}
        </div>
      </div>
    );
  }
  if (el.type === 'dropdown') {
    return <OutlinedField label={el.label} required={el.required} trailing="▾">{opts[0] ?? t('Sélectionner', 'Select')}</OutlinedField>;
  }
  if (el.type === 'date') {
    return <OutlinedField label={el.label} required={el.required} trailing="📅">{t('jj / mm / aaaa', 'dd / mm / yyyy')}</OutlinedField>;
  }
  const placeholder =
    el.type === 'passcode' ? '••••••'
    : el.type === 'textarea' ? t('Votre réponse…', 'Your answer…')
    : el.type === 'email' ? t('nom@exemple.com', 'name@example.com')
    : el.type === 'phone' ? '+33 6 12 34 56 78'
    : el.type === 'number' ? '0'
    : `${t('Saisir', 'Enter')} ${(el.label || '').toLowerCase() || t('votre réponse', 'your answer')}…`;
  return (
    <div className={el.type === 'textarea' ? 'pb-6' : ''}>
      <OutlinedField label={el.label} required={el.required}>{placeholder}</OutlinedField>
    </div>
  );
}

/** Corps d'un élément (sans clé ni badge : posés par l'appelant dans FlowScreen). */
function ElementBody({ el }: { el: FlowScreenElement }) {
  const t = useT();
  if (el.kind === 'heading') return <div className="text-[22px] font-semibold leading-tight" style={{ color: INK }}>{el.text || t('Titre', 'Title')}</div>;
  if (el.kind === 'subheading') return <div className="text-[16px] font-semibold" style={{ color: INK }}>{el.text || t('Sous-titre', 'Subtitle')}</div>;
  if (el.kind === 'body') return <div className="whitespace-pre-wrap text-[14px] leading-snug" style={{ color: '#3b4a54' }}>{el.text || t('Paragraphe', 'Paragraph')}</div>;
  if (el.kind === 'caption') return <div className="text-[12px]" style={{ color: MUTED }}>{el.text || t('Légende', 'Caption')}</div>;
  if (el.kind === 'image') {
    return el.src
      // eslint-disable-next-line @next/next/no-img-element
      ? <img src={el.src} alt="" className="h-40 w-full rounded-xl object-cover" />
      : <div className="flex h-32 items-center justify-center rounded-xl text-2xl" style={{ background: '#f0f2f5', color: '#8696a0' }}>🖼️</div>;
  }
  if (el.kind === 'field') return <ScreenField el={el} />;
  return null;
}

export function FlowScreen({ elements, cta, title }: { elements: FlowScreenElement[]; cta?: string | null; title?: string }) {
  const t = useT();
  return (
    <div className="mx-auto w-full max-w-[300px] overflow-hidden rounded-[28px] border-[5px] bg-white shadow-lg" style={{ borderColor: '#0b141a' }}>
      {/* En-tête façon écran WhatsApp Flow */}
      <div className="flex items-center gap-2 border-b px-3 py-2.5" style={{ borderColor: '#eef0f1' }}>
        <span className="text-[18px] leading-none" style={{ color: INK }}>✕</span>
        <span className="truncate text-[14px] font-semibold" style={{ color: INK }}>{title?.trim() || t('Formulaire', 'Form')}</span>
      </div>
      {/* Contenu défilant */}
      <div className="max-h-[440px] space-y-3.5 overflow-y-auto bg-white px-4 py-4">
        {elements.length === 0 && <p className="text-[13px]" style={{ color: MUTED }}>{t('Ajoute des éléments à gauche…', 'Add elements on the left…')}</p>}
        {elements.map((e, i) => (
          <div key={i}>
            {e.condition && (
              <div className="mb-1">
                <span className="inline-flex items-center gap-1 rounded bg-amber-50 px-1.5 py-0.5 text-[9px] font-medium text-amber-700">
                  👁 {t('Visible si', 'Visible if')} {e.condition}
                </span>
              </div>
            )}
            <ElementBody el={e} />
          </div>
        ))}
      </div>
      {/* Bouton final épinglé */}
      <div className="border-t px-4 py-3" style={{ borderColor: '#eef0f1' }}>
        <div className="rounded-full py-2.5 text-center text-[14px] font-semibold text-white" style={{ background: GREEN }}>{cta?.trim() || t('Envoyer', 'Send')}</div>
      </div>
    </div>
  );
}
