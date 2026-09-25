'use client';

import { useT } from '@/lib/i18n';
import { EVENEMENTS_SIGNAUX, ATTRIBUTS_SIGNAUX, CHAMP_ID_DOC } from '@/lib/signaux-dictionnaire';
import { C, Encadre, Liste, Section } from '@/components/doc-api/elements';

const theadCls = 'border-b border-ink-200 bg-ink-50 text-ink-500';

/**
 * « CE QUE LA CONSOLE REMONTE » (spec 2026-09-24, § 8 et § 10) : le dictionnaire des signaux, pour l'intégrateur.
 * Contenu de la page Événements de la documentation (`web/app/developers/api/events/page.tsx`).
 *
 * 🔴 AUCUN OUTIL TIERS N'EST NOMMÉ ICI, NI DANS LE MODULE QUI LE NOURRIT (demande de Julien du 2026-09-24 : la
 * documentation sert à tous les intégrateurs). Le nom de l'outil branché n'apparaît que sur son écran de
 * réglage. `tests/web-signaux-parite.test.ts` le vérifie sur la source, et tient la liste alignée sur le
 * serveur ; `web/e2e/developers-api.spec.ts` le vérifie sur la page rendue.
 */
export function DocSignaux() {
  const t = useT();
  return (
    <div className="space-y-10" data-testid="doc-signaux">
      <Section id="signaux" titre={t('Ce que la console remonte', 'What the console sends back')}>
        <p>
          {t(
            'Quand il se passe quelque chose sur une fiche, la console pousse un événement, avec l’état courant de la fiche, vers l’outil que votre administrateur a branché dans Paramètres > Intégrations.',
            'When something happens on a contact, the console pushes an event, with the contact’s current state, to the tool your administrator connected in Settings > Integrations.',
          )}
        </p>
        <Liste>
          <li>
            {t(
              'Seuls les outils proposés dans Paramètres > Intégrations les reçoivent : ce n’est pas un webhook vers une adresse de votre choix.',
              'Only the tools offered in Settings > Integrations receive them: this is not a webhook to an address of your choice.',
            )}
          </li>
          <li>
            {t('Les noms commencent par ', 'Names start with ')}<C>em_</C>
            {t(
              ', et ne changent pas d’un outil à l’autre, ceux des champs non plus. Un texte fait 300 caractères au plus ; une valeur absente ou vide n’est pas envoyée.',
              ', and do not change from one tool to another, nor do the field names. A text is at most 300 characters long; a missing or empty value is not sent.',
            )}
          </li>
          <li>
            {t('Le profil est désigné par votre identifiant, ', 'The profile is designated by your own id, ')}<C>externalId</C>
            {t(
              ' : une fiche qui n’en porte pas n’est pas remontée (l’écran du réglage compte ces signaux). Passez-le à chaque appel : fiche, envoi, message.',
              ': a contact without one is not sent back (the settings screen counts those signals). Pass it on every call: contact, send, message.',
            )}
          </li>
          <li>
            {t('Un même événement peut arriver deux fois : dédupliquez sur ', 'The same event can arrive twice: deduplicate on ')}
            <C>{CHAMP_ID_DOC}</C>{t(', stable.', ', which is stable.')}
          </li>
        </Liste>
        <Encadre sorte="attention">
          <p>
            {t(
              'Le texte d’un message n’est jamais remonté. Le résumé d’une conversation ne l’est que si l’option est activée dans le réglage : il contient des propos du client.',
              'A message’s text is never sent back. A conversation summary is sent only when the option is on in the settings: it contains the customer’s words.',
            )}
          </p>
        </Encadre>
      </Section>

      <Section titre={t('Délais', 'Timing')}>
        <Liste>
          <li>
            {t(
              'Moins d’une minute en temps normal. Chaque événement porte l’heure où il s’est produit, pas celle où il arrive.',
              'Less than a minute in normal conditions. Every event carries the time it happened, not the time it arrives.',
            )}
          </li>
          <li>
            {t(
              'Derrière une campagne de plusieurs milliers de destinataires, les accusés de livraison et de lecture peuvent arriver avec plusieurs dizaines de minutes de retard. Les réponses, clics, désabonnements et conversations analysées ne sont pas retardés.',
              'Behind a campaign of several thousand recipients, delivery and read receipts can arrive tens of minutes late. Replies, clicks, unsubscribes and analysed conversations are not delayed.',
            )}
          </li>
          <li>
            {t(
              '« À la fin d’une conversation » : après 25 minutes sans message, puis le passage de l’analyse, toutes les 5 minutes. Comptez environ une demi-heure après le dernier message : assez pour une relance, pas pour une alerte immédiate.',
              '“At the end of a conversation”: after 25 minutes without a message, then the analysis pass, every 5 minutes. Expect about half an hour after the last message: enough for a follow-up, not for an immediate alert.',
            )}
          </li>
          <li>
            {t(
              'Après une panne de plus de 24 heures, selon l’outil, un événement en attente peut ne pas partir. Seuls partent alors l’identifiant de la fiche et ses désabonnements, relus au moment de l’envoi ; jamais ce que l’événement seul apprenait (dernière réponse, joignabilité RCS, dernière analyse), qui écraserait un état plus récent.',
              'After an outage of more than 24 hours, depending on the tool, a pending event may not go out. Only the contact’s id and unsubscribes then go out, read at sending time; never what the event alone told (last reply, RCS reachability, last analysis), which would overwrite a more recent state.',
            )}
          </li>
        </Liste>
      </Section>

      <Section titre={t('Les événements', 'The events')}>
        <p>
          {t('Valeurs de ', 'Values of ')}<C>origine</C>{' : '}
          <C>humain</C>, <C>scenario</C>, <C>ia</C>, <C>mba</C>, <C>campagne</C>, <C>mcp</C>, <C>api</C>
          {t(' ; de ', '; of ')}<C>canal</C>{' : '}<C>whatsapp</C>, <C>rcs</C>
          {t(
            '. Une note absente (satisfaction, urgence) veut dire « pas de mesure » : elle n’écrase jamais la précédente.',
            '. A missing score (satisfaction, urgency) means “no measure”: it never overwrites the previous one.',
          )}
        </p>
        <div className="overflow-x-auto rounded-lg border border-ink-200">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className={theadCls}>
                <th className="px-3 py-2 text-xs font-semibold">{t('Événement', 'Event')}</th>
                <th className="px-3 py-2 text-xs font-semibold">{t('Quand', 'When')}</th>
                <th className="px-3 py-2 text-xs font-semibold">{t('Champs', 'Fields')}</th>
              </tr>
            </thead>
            <tbody>
              {EVENEMENTS_SIGNAUX.map((e) => (
                <tr key={e.nom} className="border-b border-ink-100 align-top last:border-0" data-testid={`signal-${e.nom}`}>
                  <td className="px-3 py-2"><C>{e.nom}</C></td>
                  <td className="px-3 py-2 text-ink-500">{t(...e.quand)}</td>
                  <td className="px-3 py-2 text-ink-500">
                    <span className="flex flex-wrap gap-1">
                      {e.champs.map((c) => <C key={c}>{c}</C>)}
                    </span>
                    <span className="mt-1 block">{t(...e.note)}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      <Section titre={t('Les attributs de la fiche', 'Contact attributes')}>
        <div className="overflow-x-auto rounded-lg border border-ink-200">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className={theadCls}>
                <th className="px-3 py-2 text-xs font-semibold">{t('Attribut de la fiche', 'Contact attribute')}</th>
                <th className="px-3 py-2 text-xs font-semibold">{t('Sens', 'Meaning')}</th>
              </tr>
            </thead>
            <tbody>
              {ATTRIBUTS_SIGNAUX.map((a) => (
                <tr key={a.nom} className="border-b border-ink-100 align-top last:border-0">
                  <td className="px-3 py-2"><C>{a.nom}</C></td>
                  <td className="px-3 py-2 text-ink-500">{t(...a.sens)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>
    </div>
  );
}
