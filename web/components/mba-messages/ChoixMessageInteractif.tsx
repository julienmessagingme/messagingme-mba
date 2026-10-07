'use client';

import Link from 'next/link';
import { Icone } from '@/components/Icone';
import { useT } from '@/lib/i18n';
import { TYPES, TYPES_MESSAGE_INTERACTIF, type TypeMessageInteractif } from '@/lib/messages-interactifs';

/**
 * « QUEL MESSAGE AJOUTER ? » : la grille des neuf composants, sur le modèle exact de « Quel outil ajouter ? »
 * (`web/components/mba-outils/ChoixTypeOutil.tsx`, demande de Julien du 2026-10-07 : « comme l'ajout d'outil »).
 *
 * L'icône est dans la même ligne que le nom, et c'est la même paire qu'on retrouve dans la liste des messages en
 * place. « Formulaire » est GRISÉ, pas caché, quand l'espace n'a aucun formulaire publié : un client qui débute doit
 * apprendre que ça existe, et où le créer. ⚠️ Une lecture ratée n'est pas « aucun » : elle le dit, et propose de relire.
 */
export function ChoixMessageInteractif({ formulairesPublies, onRelireFormulaires, onChoisir, onAnnuler }: {
  /** Combien de formulaires publiés a l'espace ; `null` = pas encore lu ; `'erreur'` = la lecture a échoué. */
  formulairesPublies: number | null | 'erreur';
  onRelireFormulaires: () => void;
  onChoisir: (type: TypeMessageInteractif) => void;
  onAnnuler: () => void;
}) {
  const t = useT();
  return (
    <section className="rounded-carte border border-ink-200 bg-white p-4" data-testid="mba-messages-types">
      <div className="mb-3 flex items-center justify-between">
        <p className="text-sm font-semibold text-ink-900">{t('Quel message ajouter ?', 'Which message to add?')}</p>
        <button type="button" data-testid="mba-messages-types-annuler" onClick={onAnnuler} className="text-xs text-ink-500 hover:underline">
          {t('Annuler', 'Cancel')}
        </button>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        {TYPES_MESSAGE_INTERACTIF.map((type) => {
          const x = TYPES[type];
          const formulaire = type === 'flow';
          const indisponible = formulaire && formulairesPublies === 0;
          const enAttente = formulaire && formulairesPublies === null;
          const illisible = formulaire && formulairesPublies === 'erreur';
          return (
            <div key={type}
              className={`rounded-carte border p-4 ${indisponible ? 'border-ink-100 opacity-60' : 'border-ink-200 hover:border-brand-300 hover:bg-brand-50'}`}>
              <button type="button" disabled={indisponible || enAttente || illisible} data-testid={`mba-message-type-${type}`}
                onClick={() => onChoisir(type)} className="block w-full text-left disabled:cursor-not-allowed">
                <span className="flex items-center gap-2 text-sm font-semibold text-ink-900">
                  <Icone nom={x.icone} className="text-ink-400" />
                  <span className="min-w-0 truncate">{t(x.nom[0], x.nom[1])}</span>
                </span>
                <span className="mt-1 block text-xs text-ink-500">{t(x.aide[0], x.aide[1])}</span>
              </button>
              {indisponible && (
                <Link href="/flows" data-testid="mba-message-type-flow-lien" className="mt-2 block text-xs text-brand-600 underline">
                  {t('Aucun formulaire publié : Contenu > Formulaires', 'No published form: Content > Forms')}
                </Link>
              )}
              {illisible && (
                <button type="button" data-testid="mba-message-type-flow-relire" onClick={onRelireFormulaires}
                  className="mt-2 block text-xs text-danger underline hover:text-danger-700">
                  {t('Lecture impossible : réessayer', 'Could not read: retry')}
                </button>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
