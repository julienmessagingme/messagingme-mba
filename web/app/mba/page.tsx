'use client';

import { AppShell } from '@/components/AppShell';
import Link from 'next/link';
import { useT } from '@/lib/i18n';
import { TitrePage } from '@/components/TitrePage';

export default function MbaPage() {
  return <AppShell active="mba-guide">{() => <MbaGuide />}</AppShell>;
}

/** Icône décorative (SVG inline, aucune dépendance). */
function Ico({ d, className = 'h-5 w-5' }: { d: string; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d={d} /></svg>
  );
}

function MbaGuide() {
  const t = useT();

  // Étapes de paramétrage (vue client, orientée « comment faire »).
  const steps: Array<{ title: string; body: string; icon: string }> = [
    {
      icon: 'M9 12l2 2 4-4M12 3a9 9 0 100 18 9 9 0 000-18z',
      title: t('1. Activer l’agent', '1. Turn the agent on'),
      body: t(
        'Acceptez les conditions Meta Business AI et vérifiez que votre numéro WhatsApp est éligible. C’est le feu vert qui débloque tout le reste.',
        'Accept the Meta Business AI terms and check that your WhatsApp number is eligible. That green light unlocks everything else.',
      ),
    },
    {
      icon: 'M4 19.5A2.5 2.5 0 016.5 17H20M4 19.5A2.5 2.5 0 006.5 22H20V2H6.5A2.5 2.5 0 004 4.5v15z',
      title: t('2. Donner sa connaissance', '2. Feed its knowledge'),
      body: t(
        'L’agent apprend à partir de votre site web, de vos FAQ et de vos fichiers. Plus la matière est claire et à jour, plus ses réponses sont justes.',
        'The agent learns from your website, your FAQs and your files. The clearer and more up to date the material, the better its answers.',
      ),
    },
    {
      icon: 'M12 2a5 5 0 015 5v2a5 5 0 01-10 0V7a5 5 0 015-5zM4 21a8 8 0 0116 0',
      title: t('3. Régler sa personnalité', '3. Set its personality'),
      body: t(
        'Choisissez son ton, sa langue, et ce qu’il a le droit de faire ou pas. Un cadre net évite les réponses hors sujet.',
        'Choose its tone, its language, and what it may or may not do. A clear frame prevents off-topic answers.',
      ),
    },
    {
      icon: 'M14.7 6.3a4 4 0 00-5.7 0l-3 3a4 4 0 005.7 5.7l1-1M9.3 17.7a4 4 0 005.7 0l3-3a4 4 0 00-5.7-5.7l-1 1',
      title: t('4. Tester avant d’activer', '4. Test before going live'),
      body: t(
        'Discutez avec l’agent comme le ferait un client, sur vos vraies questions. Vous ajustez la connaissance et le ton jusqu’à ce que ça sonne juste.',
        'Chat with the agent the way a customer would, on your real questions. You tune the knowledge and the tone until it feels right.',
      ),
    },
    {
      icon: 'M22 11.08V12a10 10 0 11-5.93-9.14M22 4L12 14.01l-3-3',
      title: t('5. Activer et garder la main', '5. Go live and stay in control'),
      body: t(
        'L’agent répond à vos clients tout seul. Dès qu’une conversation le dépasse, elle arrive dans votre Inbox : un humain répond, puis rend la main à l’agent.',
        'The agent answers your customers on its own. As soon as a conversation is beyond it, it lands in your Inbox: a human replies, then hands control back to the agent.',
      ),
    },
  ];

  const cardCls = 'rounded-2xl border border-ink-200 bg-white p-5';
  const kicker = 'text-xs font-medium text-ink-500';

  return (
    <div className="mx-auto max-w-4xl space-y-8">
      {/* En-tête */}
      <header className="space-y-2">
        <span className={kicker}>{t('Guide', 'Guide')}</span>
        <TitrePage>{t('L’agent MBA, votre répondeur intelligent WhatsApp', 'The MBA agent, your smart WhatsApp responder')}</TitrePage>
        <p className="max-w-prose text-sm leading-relaxed text-ink-500">
          {t(
            'Le Meta Business Agent (MBA) est un agent conversationnel qui répond automatiquement aux messages WhatsApp de vos clients, à partir de la connaissance que vous lui donnez. Il est hébergé par Meta : vous n’avez rien à installer. Quand une demande le dépasse, il passe la main à un humain, puis reprend le relais.',
            'The Meta Business Agent (MBA) is a conversational agent that automatically answers your customers’ WhatsApp messages, from the knowledge you give it. It is hosted by Meta: you have nothing to install. When a request is beyond it, it hands over to a human, then takes over again.',
          )}
        </p>
      </header>

      {/* Ce qu'il fait, en 3 points */}
      <section className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        {[
          { icon: 'M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z', title: t('Il répond seul', 'It answers on its own'), body: t('24 h/24, sur vos horaires comme en dehors.', 'Around the clock, during your hours and beyond.') },
          { icon: 'M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2M9 11a4 4 0 100-8 4 4 0 000 8M23 21v-2a4 4 0 00-3-3.87', title: t('Il passe la main', 'It hands over'), body: t('Une conversation trop délicate arrive dans votre Inbox.', 'A tricky conversation lands in your Inbox.') },
          { icon: 'M12 2v4M12 18v4M4.9 4.9l2.8 2.8M16.3 16.3l2.8 2.8M2 12h4M18 12h4M4.9 19.1l2.8-2.8M16.3 7.7l2.8-2.8', title: t('Vous gardez le contrôle', 'You stay in control'), body: t('Vous décidez de sa connaissance, de son ton et de ses limites.', 'You decide its knowledge, its tone and its limits.') },
        ].map((c) => (
          <div key={c.title} className={cardCls}>
            <div className="mb-2 inline-flex rounded-lg bg-brand-50 p-2 text-brand-600"><Ico d={c.icon} /></div>
            <h3 className="text-sm font-semibold text-ink-900">{c.title}</h3>
            <p className="mt-1 text-sm text-ink-500">{c.body}</p>
          </div>
        ))}
      </section>

      {/* Paramétrer l'agent : les étapes */}
      <section className="space-y-4">
        <div>
          <span className={kicker}>{t('Paramétrer', 'Set up')}</span>
          <h3 className="mt-1 text-lg font-semibold text-ink-900">{t('Mettre votre agent en route', 'Getting your agent running')}</h3>
        </div>
        <ol className="space-y-3">
          {steps.map((s) => (
            <li key={s.title} className={`${cardCls} flex gap-4`}>
              <div className="shrink-0 self-start rounded-lg bg-brand-50 p-2 text-brand-600"><Ico d={s.icon} /></div>
              <div>
                <h4 className="text-sm font-semibold text-ink-900">{s.title}</h4>
                <p className="mt-1 text-sm leading-relaxed text-ink-500">{s.body}</p>
              </div>
            </li>
          ))}
        </ol>
      </section>

      {/* Gestion des connecteurs */}
      <section className="space-y-4">
        <div>
          <span className={kicker}>{t('Connecteurs', 'Connectors')}</span>
          <h3 className="mt-1 text-lg font-semibold text-ink-900">{t('Brancher l’agent à vos outils', 'Connecting the agent to your tools')}</h3>
          <p className="mt-1 text-sm text-ink-500">{t('Il existe deux façons de relier l’agent à vos systèmes. Elles ne servent pas au même besoin.', 'There are two ways to link the agent to your systems. They serve different needs.')}</p>
        </div>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className={cardCls}>
            <div className="mb-2 inline-flex rounded-lg bg-brand-50 p-2 text-brand-600"><Ico d="M4 13h4l2 3h4l2-3h4M4 13V6a2 2 0 012-2h12a2 2 0 012 2v7" /></div>
            <h4 className="text-sm font-semibold text-ink-900">{t('Pendant la conversation', 'During the conversation')}</h4>
            {/*
              🔴 « ON LES MET EN PLACE AVEC VOUS » EST DEVENU FAUX, et c'est une capacité qu'on se cachait à
              soi-même (corrigé le 2026-09-24). Cette phrase datait d'avant Tools > Connecteurs API et
              d'avant le relais du 2026-09-21 : le client DÉCLARE son système lui-même, et l'onglet Outils de
              l'agent décide ce que l'agent a le droit d'appeler. Dire le contraire range une fonction en
              libre-service dans la case « prestation », donc personne ne la trouve et personne ne s'en sert.
              ⚠️ L'accompagnement reste vrai, il n'est simplement plus un PRÉALABLE.
            */}
            <p className="mt-1 text-sm leading-relaxed text-ink-500">
              {t(
                'L’agent consulte un de vos systèmes en direct pour aider le client : vérifier une commande, proposer un créneau, mettre à jour une fiche. Vous déclarez l’appel vous-même dans Tools > Connecteurs API, puis vous dites dans l’onglet Outils de l’agent ce qu’il a le droit d’appeler. Nous vous accompagnons si vous le souhaitez, mais vous n’attendez personne.',
                'The agent checks one of your systems live to help the customer: look up an order, offer a slot, update a record. You declare the call yourself in Tools > API connectors, then the agent’s Tools tab says what it may call. We help if you want, but you are not waiting on anyone.',
              )}
            </p>
          </div>
          <div className={cardCls}>
            <div className="mb-2 inline-flex rounded-lg bg-brand-50 p-2 text-brand-600"><Ico d="M20 6L9 17l-5-5" /></div>
            <h4 className="text-sm font-semibold text-ink-900">{t('Vers votre CRM', 'Into your CRM')}</h4>
            <p className="mt-1 text-sm leading-relaxed text-ink-500">
              {t(
                'Les conversations et leur analyse remontent dans votre CRM pour garder vos fiches clients à jour, sans double saisie. Le connecteur HubSpot est déjà disponible ; d’autres suivront.',
                'Conversations and their analysis flow into your CRM to keep your customer records up to date, with no double entry. The HubSpot connector is already available; others will follow.',
              )}
            </p>
            <Link href="/tuto-hubspot" className="mt-3 inline-block text-sm font-medium text-brand-600 hover:text-brand-700">{t('Voir le guide HubSpot', 'See the HubSpot guide')} →</Link>
          </div>
        </div>
      </section>

      {/* Prérequis & disponibilité */}
      <section className="space-y-3">
        <div>
          <span className={kicker}>{t('Prérequis', 'Requirements')}</span>
          <h3 className="mt-1 text-lg font-semibold text-ink-900">{t('Ce qu’il faut pour démarrer', 'What you need to start')}</h3>
        </div>
        <ul className="space-y-2">
          {[
            t('Un numéro WhatsApp connecté à votre espace.', 'A WhatsApp number connected to your workspace.'),
            t('Les conditions Meta Business AI acceptées sur ce numéro.', 'The Meta Business AI terms accepted on that number.'),
            /*
              🔴 CETTE LIGNE DISAIT L'INVERSE DE LA DOCUMENTATION DE META, ET DANS LES DEUX SENS (corrigée le
              2026-09-24, page de référence relue ce jour-là). Elle annonçait « un secteur ouvert par Meta, le
              déploiement est progressif, secteur par secteur », donc « attendez votre tour ». Meta écrit
              l'opposé : « all verticals are supported except Finance, Government, Health, Alcohol, Gambling,
              over-the-counter drugs, and matrimony services ». Ce n'est pas une file d'attente, c'est une
              liste d'exclusion. Un prospect de la santé lisait « plus tard » quand la réponse est « non », et
              tous les autres lisaient « plus tard » quand la réponse est « oui ».
              ⚠️ La page ne mentionne NI déploiement progressif, NI acceptation de conditions parmi les
              critères d'éligibilité, NI tarif. Les conditions restent listées ci-dessous parce que NOTRE
              mesure les a rencontrées (un 403 de conditions non signées), pas parce que Meta les documente.
            */
            t('Un secteur d’activité accepté : Meta prend tous les secteurs SAUF la finance, le secteur public, la santé, l’alcool, les jeux d’argent, les médicaments sans ordonnance et les services matrimoniaux.', 'An accepted business sector: Meta supports all verticals EXCEPT finance, government, health, alcohol, gambling, over-the-counter drugs and matrimony services.'),
            t('Un pays autorisé, et un compte WhatsApp Business Platform d’entreprise en règle, ni restreint ni banni.', 'An authorized country, and an enterprise WhatsApp Business Platform account in good standing, neither restricted nor banned.'),
            t('Aucun autre agent conversationnel déjà en service sur ce numéro.', 'No other AI agent already running on that number.'),
          ].map((li) => (
            <li key={li} className="flex items-start gap-2 text-sm text-ink-900">
              <Ico d="M20 6L9 17l-5-5" className="mt-0.5 h-4 w-4 shrink-0 text-succes-600" />
              <span>{li}</span>
            </li>
          ))}
        </ul>
        <div className="rounded-xl border border-ink-200 bg-ink-50/60 p-4 text-sm leading-relaxed text-ink-500">
          <p className="font-medium text-ink-900">{t('Coûts', 'Costs')}</p>
          <p className="mt-1">
            {t(
              'L’agent est facturé par Meta à l’usage (selon les échanges), et payé directement à Meta. Nous affichons ces coûts en toute transparence pour éviter les mauvaises surprises.',
              'The agent is billed by Meta based on usage (per exchange), and paid directly to Meta. We show these costs transparently to avoid surprises.',
            )}
          </p>
        </div>
        {/*
          🔴 CE BLOC PROMETTAIT UN FUTUR DÉJÀ ARRIVÉ, ET C'ÉTAIT LA DERNIÈRE CHOSE QUE LE LECTEUR VOYAIT. Il
          annonçait que la configuration en direct « s'ouvrira sur cette page » : elle existe depuis
          mi-août, dans Paramètres, avec onze onglets. Un guide qui finit sur « bientôt » alors que c'est
          fait envoie le client attendre devant une porte ouverte, et fait douter du reste de la page.
        */}
        <div className="rounded-xl border border-brand-200 bg-brand-50/50 p-4 text-sm leading-relaxed text-ink-900">
          <p className="font-medium text-brand-700">{t('C’est configurable ici', 'Configure it here')}</p>
          <p className="mt-1">
            {t(
              'La configuration en direct de l’agent se fait dans Paramètres : sa connaissance, son ton, ce qu’il a le droit de faire, et sa mise en service. Ce guide reste là pour comprendre à quoi il sert et ce qu’il faut préparer.',
              'Live configuration happens in Settings: its knowledge, its tone, what it may do, and putting it into service. This guide stays here to explain what it is for and what to prepare.',
            )}
          </p>
          {/* ⚠️ UN LIEN, PAS UNE INVITATION À CHERCHER : les deux écrans sont voisins dans le menu, mais
              quelqu'un qui lit ce guide ne connaît pas encore ce menu. */}
          <Link href="/mba/parametres" className="mt-2 inline-block font-medium text-brand-700 underline">
            {t('Ouvrir les paramètres de l’agent', 'Open the agent settings')}
          </Link>
          <p className="mt-2 text-xs text-ink-500">
            {t(
              'Si Meta n’a pas encore ouvert l’agent sur votre numéro, cet écran vous le dira et vous renverra ici : rien ne se perd.',
              'If Meta has not opened the agent on your number yet, that screen will say so and send you back here: nothing is lost.',
            )}
          </p>
        </div>
      </section>
    </div>
  );
}
