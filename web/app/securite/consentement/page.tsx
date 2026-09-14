'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { AppShell } from '@/components/AppShell';
import { useT } from '@/lib/i18n';
import { listeDesabonnes, refusPossibles, pousseeOptOut, setPousseeOptOut, type ContactDesabonne, type RefusPossible } from '@/lib/api';
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
  return <AppShell active="securite-consentement">{(session) => <Consentement tenantId={session.tenantId} estAdmin={session.role === 'admin'} />}</AppShell>;
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

function Consentement({ tenantId, estAdmin }: { tenantId: string; estAdmin: boolean }) {
  const t = useT();
  const [contacts, setContacts] = useState<ContactDesabonne[] | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);
  const [aRelire, setARelire] = useState<{ scannes: number; refus: RefusPossible[] } | null>(null);

  useEffect(() => {
    let vivant = true;
    listeDesabonnes(tenantId)
      .then((r) => { if (vivant) setContacts(r.contacts); })
      // ⚠️ Une liste en échec n'est PAS une liste vide : « personne ne s'est désabonné » et « on n'a pas pu
      // lire » appellent des réactions opposées, et confondre les deux ferait croire à une conformité qu'on
      // n'a pas vérifiée.
      .catch(() => { if (vivant) setErreur(t('La liste n’a pas pu être lue.', 'The list could not be read.')); });
    // ⚠️ Best-effort et SÉPARÉE : la relecture des refus possibles est une commodité, la liste des
    // désabonnés est la donnée de conformité. Un échec de la première ne doit pas masquer la seconde.
    refusPossibles(tenantId).then((r) => { if (vivant) setARelire(r); }).catch(() => {});
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

      {/*
        🔴 CE QUI REND UN REFUS OPPOSABLE AILLEURS QUE CHEZ NOUS. Un opt-out qui ne vit que dans notre base
        laisse le client continuer à écrire à cette personne depuis son CRM, et c'est lui qui en répond.

        ⚠️ ADMIN SEULEMENT, et le bloc n'est pas seulement DÉSACTIVÉ pour les autres, il est ABSENT : la
        route est montée avec la garde d'administration, donc un manager n'obtiendrait qu'un 403 et un
        sélecteur vide, c'est-à-dire un écran qui a l'air cassé.
      */}
      {estAdmin && <PousseeVersLeSysteme tenantId={tenantId} />}

      {/*
        🔴 CETTE SECTION N'A DÉSABONNÉ PERSONNE, ET C'EST TOUT SON INTÉRÊT. Une règle plus large que celle
        qui agit relit les messages entrants récents et remonte ce qu'elle AURAIT pris pour un refus. Sur
        135 messages réels mesurés le 2026-09-13, ni la règle actuelle ni une règle élargie n'ont rien
        trouvé : il n'y a rien sur quoi calibrer, donc on instrumente d'abord et on décide ensuite.
      */}
      <section className={cardCls} data-testid="refus-possibles">
        <div className="border-b border-ink-100 px-4 py-3">
          <span className="text-sm font-semibold text-ink-900">{t('Refus possibles à confirmer', 'Possible refusals to confirm')}</span>
          <p className="mt-1 text-xs text-ink-500">
            {t(
              'Des messages qui ressemblent à une demande d’arrêt sans en avoir la forme reconnue. Personne n’a été désabonné : à vous de juger, depuis la conversation.',
              'Messages that look like a stop request without matching the recognised form. Nobody was unsubscribed: judge for yourself, from the conversation.',
            )}
          </p>
        </div>

        {aRelire === null && <p className="px-4 py-3 text-sm text-ink-500">{t('Relecture…', 'Re-reading…')}</p>}
        {aRelire !== null && aRelire.refus.length === 0 && (
          <p className="px-4 py-3 text-sm text-ink-500" data-testid="refus-possibles-vide">
            {/* ⚠️ ON DIT SUR QUOI ON A REGARDÉ. « rien trouvé » et « rien lu » ne veulent pas dire la même
                chose, et sur un écran de conformité la différence compte. */}
            {/* ⚠️ « PORTEURS DE TEXTE », et pas « reçus » : la relecture écarte les messages sans corps
                (images, vocaux, accusés) avant de compter. Dire « les N derniers messages reçus » gonflerait
                l'assurance donnée, sur un écran où elle se lit comme une garantie de conformité. */}
            {t('Rien à signaler sur les ', 'Nothing to report across the last ')}
            {aRelire.scannes}
            {t(' derniers messages reçus porteurs de texte.', ' inbound messages carrying text.')}
          </p>
        )}
        {aRelire !== null && aRelire.refus.length > 0 && (
          <ul className="divide-y divide-ink-100">
            {aRelire.refus.map((r) => (
              <li key={r.messageId} className="flex items-start justify-between gap-3 px-4 py-2" data-testid="refus-possible-ligne">
                <div className="min-w-0">
                  <p className="truncate text-sm text-ink-800">{r.body}</p>
                  <p className="text-xs text-ink-400">
                    {r.profileName ?? r.waId} · {new Date(r.recuLe).toLocaleDateString()}
                  </p>
                </div>
                <Link href={`/inbox?c=${r.conversationId}`} className="shrink-0 text-xs font-medium text-brand-600 hover:underline">
                  {t('Ouvrir la conversation', 'Open the conversation')}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

/**
 * « Prévenir mon système à chaque désabonnement ».
 *
 * ⚠️ IL NE PROPOSE AUCUNE CRÉATION D'APPEL. La liste vient de Tools > Connecteurs API, où un appel se met au
 * point une fois et s'éprouve avec le bouton « Essayer ». Permettre de le décrire ici ferait exister une
 * seconde façon de déclarer un appel, avec ses propres gardes à écrire, à tester et à oublier.
 */
function PousseeVersLeSysteme({ tenantId }: { tenantId: string }) {
  const t = useT();
  const [etat, setEtat] = useState<{ requestId: string | null; requetes: Array<{ id: string; label: string }> } | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);
  const [enregistre, setEnregistre] = useState(false);

  useEffect(() => {
    let vivant = true;
    pousseeOptOut(tenantId)
      .then((r) => { if (vivant) setEtat(r); })
      .catch(() => { if (vivant) setErreur(t('Le branchement n’a pas pu être lu.', 'The wiring could not be read.')); });
    return () => { vivant = false; };
  }, [tenantId, t]);

  async function choisir(valeur: string): Promise<void> {
    const requestId = valeur === '' ? null : valeur;
    setErreur(null);
    setEnregistre(false);
    try {
      await setPousseeOptOut(tenantId, requestId);
      setEtat((e) => (e ? { ...e, requestId } : e));
      setEnregistre(true);
    } catch (e) {
      setErreur(e instanceof Error ? e.message : t('Le branchement n’a pas pu être enregistré.', 'The wiring could not be saved.'));
    }
  }

  return (
    <section className={cardCls} data-testid="poussee-optout">
      <div className="border-b border-ink-100 px-4 py-3">
        <span className="text-sm font-semibold text-ink-900">{t('Prévenir mon système', 'Notify my system')}</span>
        <p className="mt-1 text-xs text-ink-500">
          {t(
            'À chaque refus, Engage Me peut appeler un connecteur de Tools pour que votre CRM ou votre back-office le sache aussi. Le refus est enregistré ici d’abord : si votre système ne répond pas, la personne cesse quand même de recevoir.',
            'On each refusal, Engage Me can call a connector from Tools so your CRM or back-office knows too. The refusal is recorded here first: if your system does not answer, the person still stops receiving messages.',
          )}
        </p>
      </div>
      <div className="space-y-2 px-4 py-3">
        {etat === null && erreur === null && <p className="text-sm text-ink-500">{t('Lecture…', 'Loading…')}</p>}
        {etat !== null && etat.requetes.length === 0 && (
          <p className="text-sm text-ink-500" data-testid="poussee-optout-vide">
            {t('Aucun appel déclaré dans ', 'No request declared in ')}
            <Link href="/connecteurs" className="font-medium text-brand-600 hover:underline">{t('Tools > Connecteurs API', 'Tools > API connectors')}</Link>
            {t('. Déclarez-en un, puis revenez le brancher ici.', '. Declare one, then come back and wire it here.')}
          </p>
        )}
        {etat !== null && etat.requetes.length > 0 && (
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-xs font-medium text-ink-600">{t('Appel joué à chaque désabonnement', 'Request played on each unsubscribe')}</span>
            <select
              className="w-full max-w-md rounded border border-ink-200 px-2 py-1.5 text-sm"
              data-testid="poussee-optout-choix"
              value={etat.requestId ?? ''}
              onChange={(e) => { void choisir(e.target.value); }}
            >
              <option value="">{t('Aucun : ne prévenir personne', 'None: notify nobody')}</option>
              {etat.requetes.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
            </select>
          </label>
        )}
        {erreur !== null && <p className="text-sm text-red-700" data-testid="poussee-optout-erreur">{erreur}</p>}
        {enregistre && erreur === null && <p className="text-xs text-emerald-700" data-testid="poussee-optout-ok">{t('Enregistré.', 'Saved.')}</p>}
      </div>
    </section>
  );
}
