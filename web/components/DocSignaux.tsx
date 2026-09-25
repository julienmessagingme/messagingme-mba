'use client';

import { useT } from '@/lib/i18n';
import { EVENEMENTS_SIGNAUX, ATTRIBUTS_SIGNAUX, CHAMP_ID_DOC } from '@/lib/signaux-dictionnaire';

const inlineCls = 'rounded bg-ink-100 px-1.5 py-0.5 font-mono text-[0.8em] text-ink-800';

function C({ children }: { children: React.ReactNode }) {
  return <code className={inlineCls}>{children}</code>;
}

/**
 * « CE QUE NOUS REMONTONS » (spec 2026-09-24, § 8 et § 10) : le dictionnaire des signaux, pour l'intégrateur.
 * Dernière section de la page Documentation API (`web/app/developers/api/page.tsx`).
 *
 * 🔴 AUCUN OUTIL TIERS N'EST NOMMÉ ICI, NI DANS LE MODULE QUI LE NOURRIT (demande de Julien du 2026-09-24 : la
 * documentation sert à tous les intégrateurs). Le nom de l'outil branché n'apparaît que sur son écran de
 * réglage. `tests/web-signaux-parite.test.ts` le vérifie sur la source, et tient la liste alignée sur le
 * serveur ; `web/e2e/developers-api.spec.ts` le vérifie sur la page rendue.
 */
export function DocSignaux() {
  const t = useT();
  return (
    <section id="signaux" className="scroll-mt-4 rounded-2xl border border-ink-200 bg-white p-5 shadow-sm" data-testid="doc-signaux">
      <h3 className="text-sm font-semibold tracking-tight text-ink-900">{t('Ce que nous remontons', 'What we send back')}</h3>
      <div className="mt-3 space-y-3 text-sm text-ink-700">
        <p>
          {t(
            'Quand il se passe quelque chose sur une fiche, la console pousse un événement, avec l’état courant de la fiche, vers l’outil que votre administrateur a branché dans Paramètres > Intégrations. Les noms commencent par ',
            'When something happens on a contact, the console pushes an event, with the contact’s current state, to the tool your administrator connected in Settings > Integrations. Names start with ',
          )}
          <C>em_</C>
          {t(
            ' ; ces noms, et ceux des champs de chaque événement, restent les mêmes quel que soit l’outil. Un texte fait 300 caractères au plus, et une valeur absente ou vide n’est pas envoyée.',
            '; these names, and those of each event’s fields, stay the same whatever the tool. A text is at most 300 characters long, and a missing or empty value is not sent.',
          )}
        </p>
        <p>
          {t(
            'Seuls les outils proposés dans Paramètres > Intégrations reçoivent ces signaux : ce n’est pas un webhook vers une adresse de votre choix, et un outil absent de cette liste ne reçoit rien.',
            'Only the tools offered in Settings > Integrations receive these signals: this is not a webhook to an address of your choice, and a tool missing from that list receives nothing.',
          )}
        </p>
        <p>
          {t('Le profil est désigné par votre identifiant, ', 'The profile is designated by your own id, ')}
          <C>externalId</C>
          {t(
            ' : une fiche qui n’en porte pas n’est pas remontée, et l’écran du réglage compte ces signaux. Passez-le à chaque appel (fiche, envoi, message).',
            ': a contact without one is not sent back, and the settings screen counts those signals. Pass it on every call (contact, send, message).',
          )}
        </p>
        <p>
          {t('Chaque événement porte un ', 'Every event carries a stable ')}
          <C>{CHAMP_ID_DOC}</C>
          {t(' stable : un même événement peut arriver deux fois, dédupliquez sur cet identifiant.', ': the same event can arrive twice, deduplicate on it.')}
        </p>
        <p>
          {t(
            'Les signaux partent par une file : comptez moins d’une minute en temps normal. Les réponses, les clics, les désabonnements et les conversations analysées passent DEVANT les accusés de livraison et de lecture ; derrière une campagne de plusieurs milliers de destinataires, ces accusés peuvent arriver avec plusieurs dizaines de minutes de retard. Chaque événement porte l’heure où il s’est produit, pas celle où il arrive. Selon l’outil, un événement resté plus de 24 heures dans la file (une panne prolongée) peut ne pas être envoyé ; partent alors seulement l’identifiant de la fiche et ses désabonnements, relus au moment de l’envoi, jamais ce que l’événement seul apprenait (dernière réponse, joignabilité RCS, dernière analyse), qui écraserait un état plus récent.',
            'Signals go through a queue: expect less than a minute in normal conditions. Replies, clicks, unsubscribes and analysed conversations go AHEAD of delivery and read receipts; behind a campaign of several thousand recipients, those receipts can arrive tens of minutes late. Every event carries the time it happened, not the time it arrives. Depending on the tool, an event that stayed more than 24 hours in the queue (a prolonged outage) may not be sent; only the contact’s id and unsubscribes then go out, read at sending time, never what the event alone told (last reply, RCS reachability, last analysis), which would overwrite a more recent state.',
          )}
        </p>
        <p>
          {t(
            'Le texte d’un message n’est JAMAIS remonté. Le résumé d’une conversation ne l’est que si l’option est activée dans le réglage : il contient des propos du client.',
            'A message’s text is NEVER sent back. A conversation summary is sent only when the option is on in the settings: it contains the customer’s words.',
          )}
        </p>
        <p>
          {t(
            '« À la fin d’une conversation » veut dire : 25 minutes sans message, puis le passage de l’analyse, toutes les 5 minutes. Comptez environ une demi-heure après le dernier message : assez pour une relance, pas pour une alerte immédiate.',
            '“At the end of a conversation” means: 25 minutes without a message, then the analysis pass, every 5 minutes. Expect about half an hour after the last message: enough for a follow-up, not for an immediate alert.',
          )}
        </p>
        <p>
          {t('Valeurs de ', 'Values of ')}<C>origine</C>{' : '}
          <C>humain</C>, <C>scenario</C>, <C>ia</C>, <C>mba</C>, <C>campagne</C>, <C>mcp</C>, <C>api</C>
          {t(' ; de ', '; of ')}<C>canal</C>{' : '}<C>whatsapp</C>, <C>rcs</C>
          {t(
            '. Une note absente (satisfaction, urgence) veut dire « pas de mesure » : elle n’écrase jamais la précédente.',
            '. A missing score (satisfaction, urgency) means “no measure”: it never overwrites the previous one.',
          )}
        </p>

        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="border-b border-ink-100 text-ink-500">
                <th className="py-1.5 pr-3 font-medium">{t('Événement', 'Event')}</th>
                <th className="py-1.5 pr-3 font-medium">{t('Quand', 'When')}</th>
                <th className="py-1.5 font-medium">{t('Champs', 'Fields')}</th>
              </tr>
            </thead>
            <tbody>
              {EVENEMENTS_SIGNAUX.map((e) => (
                <tr key={e.nom} className="border-b border-ink-50 align-top" data-testid={`signal-${e.nom}`}>
                  <td className="py-1.5 pr-3"><C>{e.nom}</C></td>
                  <td className="py-1.5 pr-3 text-ink-600">{t(...e.quand)}</td>
                  <td className="py-1.5 text-ink-600">
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

        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="border-b border-ink-100 text-ink-500">
                <th className="py-1.5 pr-3 font-medium">{t('Attribut de la fiche', 'Contact attribute')}</th>
                <th className="py-1.5 font-medium">{t('Sens', 'Meaning')}</th>
              </tr>
            </thead>
            <tbody>
              {ATTRIBUTS_SIGNAUX.map((a) => (
                <tr key={a.nom} className="border-b border-ink-50 align-top">
                  <td className="py-1.5 pr-3"><C>{a.nom}</C></td>
                  <td className="py-1.5 text-ink-600">{t(...a.sens)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}
