'use client';

import { AppShell } from '@/components/AppShell';
import Link from 'next/link';
import { useT } from '@/lib/i18n';
import { TitrePage } from '@/components/TitrePage';
import { Icone, type NomIcone } from '@/components/Icone';

export default function MbaPage() {
  return <AppShell active="mba-guide">{() => <MbaGuide />}</AppShell>;
}

function MbaGuide() {
  const t = useT();

  // Étapes de paramétrage (vue client, orientée « comment faire »).
  const steps: Array<{ title: string; body: string }> = [
    {
      title: t('1. Activer l’agent', '1. Turn the agent on'),
      body: t(
        'Acceptez les conditions Meta Business AI et vérifiez que votre numéro WhatsApp est éligible. C’est le feu vert qui débloque tout le reste.',
        'Accept the Meta Business AI terms and check that your WhatsApp number is eligible. That green light unlocks everything else.',
      ),
    },
    {
      title: t('2. Donner sa connaissance', '2. Feed its knowledge'),
      body: t(
        'L’agent apprend à partir de votre site web, de vos FAQ et de vos fichiers. Plus la matière est claire et à jour, plus ses réponses sont justes.',
        'The agent learns from your website, your FAQs and your files. The clearer and more up to date the material, the better its answers.',
      ),
    },
    {
      title: t('3. Régler sa personnalité', '3. Set its personality'),
      body: t(
        'Choisissez son ton, sa langue, et ce qu’il a le droit de faire ou pas. Un cadre net évite les réponses hors sujet.',
        'Choose its tone, its language, and what it may or may not do. A clear frame prevents off-topic answers.',
      ),
    },
    {
      title: t('4. Tester avant d’activer', '4. Test before going live'),
      body: t(
        'Discutez avec l’agent comme le ferait un client, sur vos vraies questions. Vous ajustez la connaissance et le ton jusqu’à ce que ça sonne juste.',
        'Chat with the agent the way a customer would, on your real questions. You tune the knowledge and the tone until it feels right.',
      ),
    },
    {
      title: t('5. Activer et garder la main', '5. Go live and stay in control'),
      body: t(
        'L’agent répond à vos clients tout seul. Dès qu’une conversation le dépasse, elle arrive dans votre Inbox : un humain répond, puis rend la main à l’agent.',
        'The agent answers your customers on its own. As soon as a conversation is beyond it, it lands in your Inbox: a human replies, then hands control back to the agent.',
      ),
    },
  ];

  const kicker = 'text-xs font-medium text-ink-500';

  return (
    <div className="mx-auto max-w-formulaire space-y-8">
      {/* En-tête */}
      <header className="space-y-2">
        <span className={kicker}>{t('Guide', 'Guide')}</span>
        <TitrePage>{t('L’agent MBA, votre répondeur intelligent WhatsApp', 'The MBA agent, your smart WhatsApp responder')}</TitrePage>
        <p className="max-w-prose text-sm leading-relaxed text-ink-500">
          {t(
            'Hébergé par Meta, il répond à partir de la connaissance que vous lui donnez : rien à installer.',
            'Hosted by Meta, it answers from the knowledge you give it: nothing to install.',
          )}
        </p>
      </header>

      {/* Ce qu'il fait, en 3 points. Trois colonnes séparées par un filet, et non trois cartes à pastille
          colorée : la pastille ne disait rien que le titre ne dise déjà. */}
      <section className="grid grid-cols-1 gap-6 border-y border-ink-200 py-5 sm:grid-cols-3">
        {([
          { icone: 'message', title: t('Il répond seul', 'It answers on its own'), body: t('24 h/24, sur vos horaires comme en dehors.', 'Around the clock, during your hours and beyond.') },
          { icone: 'humain', title: t('Il passe la main', 'It hands over'), body: t('Une conversation trop délicate arrive dans votre Inbox.', 'A tricky conversation lands in your Inbox.') },
          { icone: 'reglages', title: t('Vous gardez le contrôle', 'You stay in control'), body: t('Vous décidez de sa connaissance, de son ton et de ses limites.', 'You decide its knowledge, its tone and its limits.') },
        ] satisfies Array<{ icone: NomIcone; title: string; body: string }>).map((c) => (
          <div key={c.title}>
            <h3 className="flex items-center gap-2 text-sm font-semibold text-ink-900"><Icone nom={c.icone} className="text-brand-600" />{c.title}</h3>
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
        {/* Une seule carte, des étapes séparées par un filet : le numéro est déjà dans le titre, une icône par
            étape n'ajoutait rien. */}
        <ol className="divide-y divide-ink-100 rounded-carte border border-ink-200 bg-white">
          {steps.map((s) => (
            <li key={s.title} className="px-5 py-4">
              <h4 className="text-sm font-semibold text-ink-900">{s.title}</h4>
              <p className="mt-1 text-sm leading-relaxed text-ink-500">{s.body}</p>
            </li>
          ))}
        </ol>
      </section>

      {/* Gestion des connecteurs */}
      <section className="space-y-4">
        <div>
          <span className={kicker}>{t('Connecteurs', 'Connectors')}</span>
          <h3 className="mt-1 text-lg font-semibold text-ink-900">{t('Brancher l’agent à vos outils', 'Connecting the agent to your tools')}</h3>
        </div>
        <div className="grid grid-cols-1 divide-y divide-ink-100 rounded-carte border border-ink-200 bg-white sm:grid-cols-2 sm:divide-x sm:divide-y-0">
          <div className="p-5">
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
                'L’agent interroge un de vos systèmes en direct (une commande, un créneau, une fiche). Vous déclarez l’appel dans Tools > Connecteurs API, puis l’autorisez dans l’onglet Outils de l’agent.',
                'The agent queries one of your systems live (an order, a slot, a record). You declare the call in Tools > API connectors, then allow it in the agent’s Tools tab.',
              )}
            </p>
          </div>
          <div className="p-5">
            <h4 className="text-sm font-semibold text-ink-900">{t('Vers votre CRM', 'Into your CRM')}</h4>
            <p className="mt-1 text-sm leading-relaxed text-ink-500">
              {t(
                'Les conversations et leur analyse remontent dans votre CRM, sans double saisie. HubSpot est disponible ; d’autres suivront.',
                'Conversations and their analysis flow into your CRM, with no double entry. HubSpot is available; others will follow.',
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
            t('Un secteur d’activité accepté : Meta prend tous les secteurs sauf la finance, le secteur public, la santé, l’alcool, les jeux d’argent, les médicaments sans ordonnance et les services matrimoniaux.', 'An accepted business sector: Meta supports all verticals except finance, government, health, alcohol, gambling, over-the-counter drugs and matrimony services.'),
            t('Un pays autorisé, et un compte WhatsApp Business Platform d’entreprise en règle, ni restreint ni banni.', 'An authorized country, and an enterprise WhatsApp Business Platform account in good standing, neither restricted nor banned.'),
            t('Aucun autre agent conversationnel déjà en service sur ce numéro.', 'No other AI agent already running on that number.'),
          ].map((li) => (
            <li key={li} className="flex items-start gap-2 text-sm text-ink-900">
              <Icone nom="valide" className="mt-0.5 text-ink-400" />
              <span>{li}</span>
            </li>
          ))}
        </ul>
        <div className="rounded-carte border border-ink-200 bg-ink-50/60 p-4 text-sm leading-relaxed text-ink-500">
          <p className="font-medium text-ink-900">{t('Coûts', 'Costs')}</p>
          <p className="mt-1">
            {t(
              'L’agent est facturé par Meta à l’usage (selon les échanges), et payé directement à Meta.',
              'The agent is billed by Meta based on usage (per exchange), and paid directly to Meta.',
            )}
          </p>
        </div>
        {/*
          🔴 CE BLOC PROMETTAIT UN FUTUR DÉJÀ ARRIVÉ, ET C'ÉTAIT LA DERNIÈRE CHOSE QUE LE LECTEUR VOYAIT. Il
          annonçait que la configuration en direct « s'ouvrira sur cette page » : elle existe depuis
          mi-août, dans Paramètres, avec onze onglets. Un guide qui finit sur « bientôt » alors que c'est
          fait envoie le client attendre devant une porte ouverte, et fait douter du reste de la page.
        */}
        <div className="rounded-carte border border-brand-200 bg-brand-50/50 p-4 text-sm leading-relaxed text-ink-900">
          <p className="font-medium text-brand-700">{t('C’est configurable ici', 'Configure it here')}</p>
          <p className="mt-1">
            {t(
              'Sa connaissance, son ton, ses droits et sa mise en service se règlent dans Paramètres.',
              'Its knowledge, tone, permissions and go-live are set in Settings.',
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
