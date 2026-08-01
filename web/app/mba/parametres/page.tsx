'use client';

import { AppShell } from '@/components/AppShell';
import Link from 'next/link';
import { useT } from '@/lib/i18n';

export default function MbaSettingsPage() {
  return <AppShell active="mba-settings">{() => <MbaSettings />}</AppShell>;
}

function Ico({ d, className = 'h-5 w-5' }: { d: string; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d={d} /></svg>
  );
}

/**
 * Paramètres de l'agent MBA. TOUT le câblage prévu (activation/audience, connaissance, personnalité, allowlist,
 * passage de main, test), mais GATÉ : rien n'est modifiable tant que Meta n'a pas ouvert l'agent pour le numéro
 * (ToS Meta Business AI à accepter, déploiement par verticale). Aujourd'hui l'état est « bloqué (ToS) », donc la
 * page présente les sections en aperçu désactivé. Le jour de l'éligibilité, on branche chaque section sur l'API MBA.
 */
function MbaSettings() {
  const t = useT();
  const cardCls = 'rounded-2xl border border-ink-200 bg-white p-5 shadow-sm';
  const kicker = 'text-xs font-semibold uppercase tracking-wide text-brand-600';
  const inputCls = 'w-full rounded-lg border border-ink-300 px-3 py-2 text-sm text-ink-400';
  const badge = 'inline-flex items-center gap-1 rounded-full bg-ink-100 px-2 py-0.5 text-[11px] font-medium text-ink-500';

  // Sections de connaissance (aperçu). Chacune = un endpoint agent_config/* côté Meta.
  const knowledge: Array<{ icon: string; title: string; desc: string }> = [
    { icon: 'M4 4h16v4H4zM4 12h10v8H4zM18 12h2v8h-2z', title: t('Informations business', 'Business info'), desc: t('Horaires, politique de retour, livraison, contact.', 'Hours, return policy, delivery, contact.') },
    { icon: 'M12 22a10 10 0 100-20 10 10 0 000 20zM9.1 9a3 3 0 015.8 1c0 2-3 3-3 3M12 17h.01', title: t('FAQ', 'FAQ'), desc: t('Questions/réponses formulées comme vos clients.', 'Questions/answers phrased like your customers.') },
    { icon: 'M4 19.5A2.5 2.5 0 016.5 17H20M4 19.5A2.5 2.5 0 006.5 22H20V2H6.5A2.5 2.5 0 004 4.5v15z', title: t('Fichiers', 'Files'), desc: t('PDF, docs, images (jusqu’à 100 Mo).', 'PDF, docs, images (up to 100 MB).') },
    { icon: 'M2 12h20M12 2a15 15 0 010 20M12 2a15 15 0 000 20', title: t('Sites web', 'Websites'), desc: t('Pages crawlées automatiquement.', 'Pages crawled automatically.') },
  ];

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      {/* En-tête */}
      <header className="space-y-1">
        <span className={kicker}>{t('MBA', 'MBA')}</span>
        <h2 className="text-xl font-semibold tracking-tight text-ink-900">{t('Paramètres de l’agent', 'Agent settings')}</h2>
        <p className="text-sm text-ink-600">{t('Tout ce que vous pourrez régler sur votre agent MBA, au même endroit.', 'Everything you will be able to tune on your MBA agent, in one place.')}</p>
      </header>

      {/* Bandeau de statut / blocage (gate) */}
      <div className="flex items-start gap-3 rounded-2xl border border-gold/40 bg-gold/10 p-4">
        <Ico d="M12 9v4M12 17h.01M10.3 3.9L1.8 18a2 2 0 001.7 3h17a2 2 0 001.7-3L14.4 3.9a2 2 0 00-3.4 0z" className="mt-0.5 h-5 w-5 shrink-0 text-gold" />
        <div className="text-sm leading-relaxed text-ink-700">
          <p className="font-semibold text-ink-900">{t('Configuration bloquée pour l’instant', 'Configuration locked for now')}</p>
          <p className="mt-1">
            {t(
              'Meta n’a pas encore ouvert l’agent pour votre numéro : les conditions Meta Business AI ne sont pas encore signables (l’onglet n’apparaît dans WhatsApp Manager qu’à l’éligibilité, ouverte progressivement par secteur). Dès qu’il sera éligible, ces réglages deviendront actifs ici. En attendant, voici tout ce que vous pourrez faire.',
              'Meta hasn’t opened the agent for your number yet: the Meta Business AI terms aren’t signable yet (the tab only appears in WhatsApp Manager once eligible, rolled out gradually by sector). As soon as it’s eligible, these settings become active here. In the meantime, here’s everything you’ll be able to do.',
            )}
          </p>
          <Link href="/mba" className="mt-2 inline-block text-sm font-medium text-brand-600 hover:text-brand-700">{t('Revoir le guide MBA', 'Back to the MBA guide')} →</Link>
        </div>
      </div>

      {/* Aperçu des sections, désactivé tant que non éligible. */}
      <div className="space-y-5 opacity-60" aria-disabled>
        {/* Activation & audience */}
        <section className={cardCls}>
          <div className="mb-3 flex items-center justify-between">
            <div>
              <h3 className="text-sm font-semibold text-ink-900">{t('Activation & audience', 'Activation & audience')}</h3>
              <p className="text-xs text-ink-500">{t('Allumer/éteindre l’agent et choisir qui il gère.', 'Turn the agent on/off and choose who it handles.')}</p>
            </div>
            <span className={badge}>{t('bientôt', 'soon')}</span>
          </div>
          <div className="flex flex-wrap items-center gap-6">
            <label className="flex items-center gap-2 text-sm text-ink-500">
              <span className="relative inline-block h-5 w-9 rounded-full bg-ink-200"><span className="absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white" /></span>
              {t('Agent actif', 'Agent on')}
            </label>
            <label className="flex flex-col gap-1 text-xs text-ink-500">
              {t('Audience', 'Audience')}
              <select disabled className={`${inputCls} bg-white`}>
                <option>{t('Tout le monde', 'Everyone')}</option>
                <option>{t('Liste d’autorisation uniquement', 'Allowlisted only')}</option>
              </select>
            </label>
          </div>
        </section>

        {/* Base de connaissance */}
        <section className={cardCls}>
          <div className="mb-3">
            <h3 className="text-sm font-semibold text-ink-900">{t('Base de connaissance', 'Knowledge base')}</h3>
            <p className="text-xs text-ink-500">{t('Ce que l’agent sait, pour répondre juste.', 'What the agent knows, so it answers accurately.')}</p>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {knowledge.map((k) => (
              <div key={k.title} className="flex items-start gap-3 rounded-xl border border-ink-100 p-3">
                <div className="rounded-lg bg-brand-50 p-2 text-brand-600"><Ico d={k.icon} className="h-4 w-4" /></div>
                <div>
                  <p className="text-sm font-medium text-ink-800">{k.title}</p>
                  <p className="text-xs text-ink-500">{k.desc}</p>
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* Personnalité (skills) */}
        <section className={cardCls}>
          <div className="mb-3">
            <h3 className="text-sm font-semibold text-ink-900">{t('Personnalité & compétences', 'Personality & skills')}</h3>
            <p className="text-xs text-ink-500">{t('Le ton de l’agent et ce qu’il a le droit de faire (instructions).', 'The agent’s tone and what it’s allowed to do (instructions).')}</p>
          </div>
          <textarea disabled rows={3} className={inputCls} placeholder={t('Ex. « Réponds en français, poliment. Ne donne jamais de prix sans vérifier… »', 'E.g. “Answer in English, politely. Never quote a price without checking…”')} />
        </section>

        {/* Liste d'autorisation */}
        <section className={cardCls}>
          <div className="mb-3">
            <h3 className="text-sm font-semibold text-ink-900">{t('Liste d’autorisation', 'Allowlist')}</h3>
            <p className="text-xs text-ink-500">{t('Quand l’audience est restreinte : les numéros que l’agent gère.', 'When the audience is restricted: the numbers the agent handles.')}</p>
          </div>
          <input disabled className={inputCls} placeholder="+33 6 12 34 56 78" />
        </section>

        {/* Passage de main & relances */}
        <section className={cardCls}>
          <div className="mb-3">
            <h3 className="text-sm font-semibold text-ink-900">{t('Passage de main & relances', 'Handoff & follow-ups')}</h3>
            <p className="text-xs text-ink-500">{t('Le message quand l’agent passe la main à un humain, et les relances.', 'The message when the agent hands over to a human, and follow-ups.')}</p>
          </div>
          <input disabled className={inputCls} placeholder={t('Un conseiller va prendre le relais.', 'An advisor will take over.')} />
        </section>

        {/* Tester l'agent */}
        <section className={cardCls}>
          <div className="mb-3 flex items-center justify-between">
            <div>
              <h3 className="text-sm font-semibold text-ink-900">{t('Tester l’agent', 'Test the agent')}</h3>
              <p className="text-xs text-ink-500">{t('Discuter avec l’agent comme un client, sans envoyer de vrai message.', 'Chat with the agent like a customer, without sending a real message.')}</p>
            </div>
            <span className={badge}>{t('bientôt', 'soon')}</span>
          </div>
          <div className="flex gap-2">
            <input disabled className={inputCls} placeholder={t('Écris un message de test…', 'Type a test message…')} />
            <button disabled className="shrink-0 rounded-lg bg-ink-200 px-4 py-2 text-sm font-semibold text-white">{t('Envoyer', 'Send')}</button>
          </div>
        </section>
      </div>
    </div>
  );
}
