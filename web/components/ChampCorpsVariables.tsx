'use client';

import { useRef, useState } from 'react';
import { VariableBodyEditor, NAMED_VAR_RE, type VariableBodyEditorHandle } from '@/components/VariableBodyEditor';
import { SelecteurVariable } from '@/components/SelecteurVariable';
import { SelecteurEmojis } from '@/components/SelecteurEmojis';
import { emailVariableFields } from '@/lib/fields';
import type { UserFieldDef } from '@/lib/api';
import { useT } from '@/lib/i18n';
import { inputCls } from '@/lib/ui';

/**
 * Un corps de message dont les variables s'affichent en CHIPS lisibles (`[Prénom]`) alors que la chaîne
 * stockée reste `Bonjour {{prenom}}` : c'est l'AFFICHAGE qui change, pas le contenu.
 *
 * S'appelait `RcsBodyField`. Renommé le 2026-08-25 : il sert le RCS ET les modèles d'email (les deux canaux
 * passent par la MÊME table de substitution serveur, `contactVars`), et un nom de canal invitait chaque
 * nouvel écran à s'en écrire un autre plutôt qu'à réutiliser celui-ci.
 *
 * 🔴 Ne PAS l'employer sur du HTML BRUT : c'est un `contenteditable` qui colle en texte brut et resérialise le
 * DOM en chaîne. Y coller un mail HTML de 200 lignes le réécrirait. Pour cette surface-là, une zone de code
 * plus `SelecteurVariable` donne le même geste sans abîmer la source.
 *
 * 🔴 Différence de fond avec les templates Meta, et c'est elle qui justifie deux composants plutôt qu'une
 * option de plus : les variables Meta sont POSITIONNELLES (`{{1}}`, avec un exemple obligatoire et une
 * renumérotation à l'envoi, parce que Meta valide un gabarit), celles-ci sont NOMMÉES (`{{prenom}}`, résolues
 * sur la fiche du contact). Deux contrats, un seul éditeur en dessous.
 */
export function ChampCorpsVariables({
  valeur, onChange, fields, label, placeholder, compact = false, testId, max,
}: {
  valeur: string;
  onChange: (v: string) => void;
  /** Champs du contact, pour le sélecteur. Seuls ceux que le serveur sait RÉSOUDRE sont proposés. */
  fields: UserFieldDef[];
  label?: string;
  placeholder?: string;
  compact?: boolean;
  /** Obligatoire : chaque appelant nomme sa propre surface. Un défaut porterait le nom d'un canal, ce qui a
   *  justement fait croire que ce composant était réservé au RCS. */
  testId: string;
  /** Plafond de caractères, affiché en compteur. Absent -> pas de compteur. */
  max?: number;
}) {
  const t = useT();
  const editorRef = useRef<VariableBodyEditorHandle>(null);
  const [emojisOuverts, setEmojisOuverts] = useState(false);

  // Sert UNIQUEMENT à retrouver le libellé d'une variable pour l'afficher en chip. MÊME liste que le
  // sélecteur, sinon un `{{phone}}` inséré s'afficherait en brut au lieu de « Téléphone ».
  const variables = emailVariableFields(fields, t);
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
          <SelecteurVariable
            fields={fields}
            testId={`${testId}-variable`}
            onInsert={(cle, libelle) => editorRef.current?.insertToken(`{{${cle}}}`, libelle)}
          />
          <button
            type="button"
            onClick={() => setEmojisOuverts((o) => !o)}
            data-testid={`${testId}-emoji`}
            className="rounded-md p-1 text-lg leading-none hover:bg-ink-100"
            aria-label={t('Insérer un emoji', 'Insert an emoji')}
          >
            😊
          </button>
        </div>

        {emojisOuverts && (
          <SelecteurEmojis
            onClose={() => setEmojisOuverts(false)}
            onPick={(e) => editorRef.current?.insertToken(e)}
          />
        )}
      </div>
    </div>
  );
}
