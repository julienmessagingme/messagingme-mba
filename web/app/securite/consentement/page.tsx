'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { AppShell } from '@/components/AppShell';
import { useT } from '@/lib/i18n';
import { listeDesabonnes, type ContactDesabonne } from '@/lib/api';
import { cardCls } from '@/lib/ui';

/**
 * LE CONSENTEMENT : qui a demandé à ne plus être contacté, depuis quand, et par quel chemin.
 *
 * 🔴 CE QUE CET ÉCRAN NE FAIT PAS, ET C'EST DÉLIBÉRÉ : il ne permet PAS de réabonner quelqu'un d'un clic.
 * Un opt-out se lève depuis la fiche du contact, là où l'on voit à qui l'on a affaire, et le geste y est
 * déjà tracé. Un bouton « réabonner » sur une liste rendrait trop facile d'annuler en série des refus que
 * des personnes ont exprimés.
 *
 * ⚠️ LA DATE PEUT MANQUER, ET L'ÉCRAN LE DIT. Elle n'est enregistrée que depuis la migration 0138 : les
 * désabonnements antérieurs n'en ont pas. Afficher la dernière modification de la fiche à la place aurait
 * été plus joli et faux, ce qui est le pire résultat possible sur un écran de conformité.
 */
export default function SecuriteConsentementPage() {
  return <AppShell active="securite-consentement">{(session) => <Consentement tenantId={session.tenantId} />}</AppShell>;
}

/** Le chemin par lequel le refus est arrivé, dit en français plutôt qu'en clé technique. */
function sourceDite(source: string | null, t: (fr: string, en: string) => string): string {
  if (source === null || source.trim() === '') return t('origine inconnue', 'unknown origin');
  if (source === 'crm') return t('saisi par l’équipe', 'set by the team');
  if (source === 'scenario') return t('posé par un scénario', 'set by a scenario');
  if (source === 'flow') return t('coché par la personne', 'ticked by the person');
  if (source.startsWith('webhook:')) return `${t('reçu de', 'received from')} ${source.slice('webhook:'.length)}`;
  return source;
}

function Consentement({ tenantId }: { tenantId: string }) {
  const t = useT();
  const [contacts, setContacts] = useState<ContactDesabonne[] | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);

  useEffect(() => {
    let vivant = true;
    listeDesabonnes(tenantId)
      .then((r) => { if (vivant) setContacts(r.contacts); })
      // ⚠️ Une liste en échec n'est PAS une liste vide : « personne ne s'est désabonné » et « on n'a pas pu
      // lire » appellent des réactions opposées, et confondre les deux ferait croire à une conformité qu'on
      // n'a pas vérifiée.
      .catch(() => { if (vivant) setErreur(t('La liste n’a pas pu être lue.', 'The list could not be read.')); });
    return () => { vivant = false; };
  }, [tenantId, t]);

  return (
    <div className="mx-auto w-full max-w-5xl space-y-4 p-6" data-testid="securite-consentement">
      <div className="space-y-1">
        <h1 className="text-xl font-semibold text-ink-900">{t('Consentement', 'Consent')}</h1>
        <p className="text-sm text-ink-500">
          {t(
            'Les personnes qui ont demandé à ne plus être contactées. Aucun envoi automatique ne leur est adressé : ni campagne, ni scénario, ni automation, ni agent IA. Un opérateur peut encore leur répondre à la main.',
            'People who asked not to be contacted again. No automatic message is sent to them: no campaign, scenario, automation or AI agent. An operator can still reply to them by hand.',
          )}
        </p>
      </div>

      <section className={cardCls} data-testid="desabonnes">
        <div className="flex items-center justify-between gap-2 border-b border-ink-100 px-4 py-3">
          <span className="text-sm font-semibold text-ink-900">{t('Désabonnés', 'Unsubscribed')}</span>
          {contacts !== null && (
            <span className="text-xs text-ink-500" data-testid="desabonnes-compte">
              {contacts.length} {contacts.length > 1 ? t('personnes', 'people') : t('personne', 'person')}
            </span>
          )}
        </div>

        {erreur !== null && <p className="px-4 py-3 text-sm text-red-700" data-testid="desabonnes-erreur">{erreur}</p>}
        {erreur === null && contacts === null && <p className="px-4 py-3 text-sm text-ink-500">{t('Lecture…', 'Loading…')}</p>}
        {erreur === null && contacts !== null && contacts.length === 0 && (
          <p className="px-4 py-3 text-sm text-ink-500" data-testid="desabonnes-vide">
            {t('Personne ne s’est désabonné sur cet espace.', 'Nobody has unsubscribed in this workspace.')}
          </p>
        )}

        {contacts !== null && contacts.length > 0 && (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-ink-500">
                <th className="px-4 py-2 font-medium">{t('Personne', 'Person')}</th>
                <th className="px-4 py-2 font-medium">{t('Désabonné le', 'Unsubscribed on')}</th>
                <th className="px-4 py-2 font-medium">{t('Par quel chemin', 'How')}</th>
                <th className="px-4 py-2 font-medium" />
              </tr>
            </thead>
            <tbody>
              {contacts.map((c) => (
                <tr key={c.id} className="border-t border-ink-100" data-testid="desabonne-ligne">
                  <td className="px-4 py-2 text-ink-800">
                    {c.profileName ?? c.phoneE164 ?? t('sans nom', 'no name')}
                    {c.profileName && c.phoneE164 && <span className="ml-2 text-xs text-ink-400">{c.phoneE164}</span>}
                  </td>
                  <td className="px-4 py-2 text-ink-600" data-testid="desabonne-date">
                    {c.desabonneLe
                      ? new Date(c.desabonneLe).toLocaleDateString()
                      : <span className="text-ink-400">{t('date inconnue', 'date unknown')}</span>}
                  </td>
                  <td className="px-4 py-2 text-ink-600">{sourceDite(c.source, t)}</td>
                  <td className="px-4 py-2 text-right">
                    {/* La fiche du contact : c'est là qu'on voit son historique complet, et le seul endroit
                        d'où l'on peut lever un opt-out en sachant à qui l'on a affaire. */}
                    <Link href={`/contacts?c=${c.id}`} className="text-xs font-medium text-brand-600 hover:underline">
                      {t('Ouvrir la fiche', 'Open the record')}
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
