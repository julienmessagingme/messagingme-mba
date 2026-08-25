'use client';

import { useState } from 'react';
import { Flottant } from '@/components/Flottant';
import { emailVariableFields } from '@/lib/fields';
import type { UserFieldDef } from '@/lib/api';
import { useT } from '@/lib/i18n';

/**
 * LE sélecteur de variables. Un bouton « + Variable », un panneau qui liste les champs du contact par leur
 * LIBELLÉ, et l'insertion du jeton `{{clé}}` chez l'appelant.
 *
 * 🔴 Il existe pour qu'aucun écran ne re-propose à l'utilisateur de TAPER `{{prenom}}` à la main. Julien a dû
 * le redemander trois fois (templates WhatsApp, puis RCS, puis modèles d'email) : « même remarque je te fais à
 * chaque fois ». Taper la syntaxe produit des variables qui ne pointent sur rien, et personne ne connaît par
 * cœur les clés des champs perso d'un tenant. Toute nouvelle surface de saisie qui accepte des variables
 * DOIT passer par ici, jamais par une liste d'exemples.
 *
 * Le composant ne connaît pas la surface de saisie : il rend un jeton, l'appelant décide où l'écrire (au
 * curseur d'un input/textarea, ou via `insertToken` d'un éditeur à chips). C'est ce qui lui permet de servir
 * un champ d'une ligne, une zone de code HTML et un éditeur enrichi sans se dédoubler.
 */
export function SelecteurVariable({
  fields, onInsert, testId, ancrage = 'bas', className,
}: {
  /** Champs bruts du tenant. Le filtrage `emailResolvableFields` est fait ICI : c'est la même règle partout
   *  (exclut les clés que le serveur ne sait pas résoudre, « Nom » et « WhatsApp ID »), et la centraliser
   *  évite qu'un écran propose une variable qui rendrait du vide à l'envoi. */
  fields: UserFieldDef[];
  onInsert: (cle: string, libelle: string) => void;
  testId: string;
  ancrage?: 'bas' | 'haut';
  className?: string;
}) {
  const t = useT();
  const [ouvert, setOuvert] = useState(false);
  const variables = emailVariableFields(fields, t);

  return (
    <span className={`relative inline-block ${className ?? ''}`}>
      <button
        type="button"
        onClick={() => setOuvert((o) => !o)}
        data-testid={testId}
        className="rounded-md border border-ink-200 bg-white px-2 py-1 text-xs font-medium text-brand-600 hover:bg-brand-50"
        title={t('Insérer une variable (champ du contact)', 'Insert a variable (contact field)')}
      >
        + Variable
      </button>
      {ouvert && (
        <Flottant onClose={() => setOuvert(false)} ancrage={ancrage}>
          {variables.length === 0 ? (
            <p className="px-2 py-1.5 text-xs text-ink-500">{t('Aucun champ disponible.', 'No field available.')}</p>
          ) : (
            variables.map((f) => (
              <button
                type="button"
                key={f.key}
                data-testid={`${testId}-${f.key}`}
                onClick={() => { onInsert(f.key, f.label); setOuvert(false); }}
                className="block w-full truncate rounded-md px-2 py-1.5 text-left text-sm text-ink-700 hover:bg-brand-50"
              >
                {/* Le LIBELLÉ, jamais `{{clé}}` : c'est tout l'objet du composant. */}
                {f.label}
              </button>
            ))
          )}
        </Flottant>
      )}
    </span>
  );
}
