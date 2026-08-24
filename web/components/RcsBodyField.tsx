'use client';

import { useRef, useState } from 'react';
import { VariableBodyEditor, NAMED_VAR_RE, type VariableBodyEditorHandle } from '@/components/VariableBodyEditor';
import { EMOJIS_MESSAGE } from '@/lib/emojis';
import { emailResolvableFields } from '@/lib/fields';
import type { UserFieldDef } from '@/lib/api';
import { useT } from '@/lib/i18n';
import { inputCls } from '@/lib/ui';

/**
 * Le corps d'un message RCS, avec ses variables affichées comme des CHIPS lisibles.
 *
 * Même geste que le corps d'un template Meta (`TemplateBodyField`) : on écrit, on clique « + Variable », on
 * choisit un champ du contact, et un chip `[Prénom]` s'insère au curseur. La chaîne stockée reste
 * `Bonjour {{prenom}}` : c'est l'AFFICHAGE qui change, pas le contenu.
 *
 * 🔴 Une différence de fond avec Meta, et c'est elle qui justifie un composant à part plutôt qu'une option de
 * plus sur l'autre : les variables d'un template Meta sont POSITIONNELLES (`{{1}}`, avec un exemple obligatoire
 * et une renumérotation à l'envoi, parce que Meta valide un gabarit), celles d'un message RCS sont NOMMÉES
 * (`{{prenom}}`, résolues sur la fiche du contact) parce qu'un message RCS n'est soumis à personne. Deux
 * contrats, un seul éditeur en dessous.
 */
export function RcsBodyField({
  valeur, onChange, fields, label, placeholder, compact = false, testId = 'rcs-message-text', max,
}: {
  valeur: string;
  onChange: (v: string) => void;
  /** Champs du contact, pour le sélecteur. Seuls ceux que le serveur sait RÉSOUDRE sont proposés. */
  fields: UserFieldDef[];
  label?: string;
  placeholder?: string;
  compact?: boolean;
  testId?: string;
  /** Plafond de caractères, affiché en compteur. Absent -> pas de compteur. */
  max?: number;
}) {
  const t = useT();
  const editorRef = useRef<VariableBodyEditorHandle>(null);
  const [ouvert, setOuvert] = useState<'variable' | 'emoji' | null>(null);

  // Mêmes variables que les modèles d'email : les deux canaux passent par la MÊME table de substitution
  // serveur (`contactVars`). Proposer une clé qu'elle ne connaît pas afficherait du vide sur le téléphone.
  const variables = emailResolvableFields(fields);
  const trop = max !== undefined && valeur.length > max;

  return (
    <div>
      <div className="mb-1 flex items-center justify-between gap-2">
        {label ? <label className="block text-xs font-medium text-ink-600">{label}</label> : <span />}
        {max !== undefined && (
          <span className={`text-[11px] ${trop ? 'font-medium text-coral' : 'text-ink-400'}`}>{valeur.length} / {max}</span>
        )}
      </div>

      <div className="relative">
        <VariableBodyEditor
          ref={editorRef}
          value={valeur}
          varPattern={NAMED_VAR_RE}
          labelOf={(nom) => variables.find((f) => f.key === nom)?.label}
          onChange={onChange}
          placeholder={placeholder ?? t('Votre message…', 'Your message…')}
          testId={testId}
          className={`${inputCls} ${compact ? 'min-h-[5rem] pr-24' : 'pr-28'}`}
        />
        <div className="absolute bottom-2 right-2 flex items-center gap-1">
          <button
            type="button"
            onClick={() => setOuvert((o) => (o === 'variable' ? null : 'variable'))}
            data-testid={`${testId}-variable`}
            className="rounded-md border border-ink-200 bg-white px-2 py-1 text-xs font-medium text-brand-600 hover:bg-brand-50"
            title={t('Insérer une variable (champ du contact)', 'Insert a variable (contact field)')}
          >
            + Variable
          </button>
          <button
            type="button"
            onClick={() => setOuvert((o) => (o === 'emoji' ? null : 'emoji'))}
            data-testid={`${testId}-emoji`}
            className="rounded-md p-1 text-lg leading-none hover:bg-ink-100"
            aria-label={t('Insérer un emoji', 'Insert an emoji')}
          >
            😊
          </button>
        </div>

        {ouvert === 'variable' && (
          <Flottant onClose={() => setOuvert(null)}>
            {variables.length === 0 ? (
              <p className="px-2 py-1.5 text-xs text-ink-500">{t('Aucun champ disponible.', 'No field available.')}</p>
            ) : (
              variables.map((f) => (
                <button
                  type="button"
                  key={f.key}
                  data-testid={`${testId}-variable-${f.key}`}
                  onClick={() => { editorRef.current?.insertToken(`{{${f.key}}}`, f.label); setOuvert(null); }}
                  className="block w-full truncate rounded-md px-2 py-1.5 text-left text-sm text-ink-700 hover:bg-brand-50"
                >
                  {f.label}
                </button>
              ))
            )}
          </Flottant>
        )}

        {ouvert === 'emoji' && (
          <Flottant onClose={() => setOuvert(null)} large>
            <div className="grid grid-cols-8 gap-0.5">
              {EMOJIS_MESSAGE.map((e) => (
                <button
                  type="button"
                  key={e}
                  // Le panneau se FERME après un choix. Le laisser ouvert (ce que fait le composeur de
                  // template) coûte un clic mort : le voile qui capte le clic extérieur avale le suivant, et
                  // l'utilisateur croit que le bouton d'à côté ne répond pas.
                  onClick={() => { editorRef.current?.insertToken(e); setOuvert(null); }}
                  className="rounded p-1 text-lg leading-none hover:bg-ink-100"
                  aria-label={e}
                >
                  {e}
                </button>
              ))}
            </div>
          </Flottant>
        )}
      </div>
    </div>
  );
}

/** Panneau flottant qui se ferme au clic extérieur. Même comportement que celui du corps de template. */
function Flottant({ children, onClose, large }: { children: React.ReactNode; onClose: () => void; large?: boolean }) {
  const t = useT();
  return (
    <>
      <button type="button" aria-label={t('Fermer', 'Close')} className="fixed inset-0 z-40 cursor-default" onClick={onClose} />
      <div className={`absolute bottom-11 right-0 z-50 max-h-56 overflow-y-auto rounded-xl border border-ink-200 bg-white p-1 shadow-lg ${large ? 'w-64 p-2' : 'w-56'}`}>
        {children}
      </div>
    </>
  );
}
