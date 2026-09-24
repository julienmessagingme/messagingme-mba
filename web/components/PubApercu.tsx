'use client';

import { useT } from '@/lib/i18n';
import { PhoneFrame } from '@/components/PhoneFrame';
import type { ReponsePrevue } from '@/lib/apercu-reponse';

/**
 * L'état du TROISIÈME écran : ce que le prospect recevra en réponse.
 *
 * 🔴 « AGENT DE META » N'EST PAS UN CAS DÉGRADÉ DE « SCÉNARIO », C'EST UN AUTRE RÉGIME DE VÉRITÉ. Un
 * scénario se LIT, donc on montre ses vrais mots ; l'agent de Meta COMPOSE, donc on montre une illustration
 * et l'écran dit que c'en est une. Les réunir sous un seul affichage ferait passer l'une pour l'autre.
 */
export type EtatReponse =
  /** L'agent de Meta répondra : on illustre l'allure de l'échange, jamais les mots. */
  | { etat: 'agent_meta' }
  /** Destination scénario, aucun scénario choisi pour l'instant. */
  | { etat: 'sans_scenario' }
  | { etat: 'chargement' }
  /** La lecture du scénario a échoué : on le DIT, on n'invente pas une réponse à sa place. */
  | { etat: 'illisible' }
  /** Le scénario n'a jamais été publié : un lead arriverait et rien ne partirait. */
  | { etat: 'hors_ligne' }
  | { etat: 'connue'; reponse: ReponsePrevue };

/**
 * L'APERÇU D'UNE PUBLICITÉ CLICK-TO-WHATSAPP : les DEUX écrans que le prospect voit, côte à côte.
 *
 * 🔴 DEUX PANNEAUX, ET LE SECOND EST CELUI QU'ON ALLAIT OUBLIER. Une publicité CTWA n'est pas une image,
 * c'est un enchaînement : l'annonce dans le fil, puis la conversation qui s'ouvre quand on appuie sur le
 * bouton. Les six champs du formulaire nourrissent l'un OU l'autre, et deux d'entre eux se confondent
 * facilement (la phrase d'accueil s'affiche dans la conversation, le message pré-rempli s'écrit dans la
 * zone de saisie du prospect). Le formulaire porte déjà une note pour prévenir de l'inversion ; un aperçu
 * qui ne montrerait que le fil laisserait justement la paire inversable invisible.
 *
 * ⚠️ RIEN NE PART CHEZ META ICI. Tout se dessine depuis l'état du formulaire, et le visuel est le base64
 * DÉJÀ lu pour le téléversement : pas de seconde lecture du fichier, pas d'appel réseau, pas de création.
 * L'aperçu d'une publicité ne doit pas pouvoir dépenser.
 *
 * ⚠️ LE RECADRAGE DÉPEND DU PLACEMENT, et on le dit plutôt que de le taire. On montre le format du fil
 * (1,91:1), qui est celui de cette créa ; Instagram, les stories et la colonne de droite recadrent
 * autrement. Promettre un rendu exact serait faux, ne rien dire laisserait croire qu'il l'est.
 */

export interface VisuelPub {
  type: 'image/jpeg' | 'image/png';
  base64: string;
}

export function PubApercu({ titre, texte, accueil, messagePreRempli, visuel, nomPage, reponse, className }: {
  /** Le titre affiché sous le visuel, dans la barre du bouton (`link_data.name`). */
  titre: string;
  /** Le texte principal, au-dessus du visuel (`link_data.message`). */
  texte: string;
  /** La phrase d'accueil, premier message de la conversation (`page_welcome_message.text`). */
  accueil: string;
  /** Ce que WhatsApp écrit dans la zone de saisie du prospect (`autofill_message.content`). */
  messagePreRempli: string;
  visuel: VisuelPub | null;
  /**
   * Le nom de la Page qui porte la publicité (migration 0169).
   *
   * ⚠️ `null` = connexion antérieure à 0169, ou nom pas remonté de Meta. On met un libellé neutre plutôt
   * qu'un identifiant : c'est un aperçu de ce que VOIT le prospect, et il ne voit jamais un identifiant.
   */
  nomPage: string | null;
  /** Le troisième écran : qui répond, et ce qu'on sait de ce qu'il dira. */
  reponse: EtatReponse;
  className?: string;
}) {
  const t = useT();

  return (
    <div className={className} data-testid="pub-apercu">
      <ApercuFil titre={titre} texte={texte} visuel={visuel} nomPage={nomPage} />
      <div className="mt-5">
        <ApercuConversation accueil={accueil} messagePreRempli={messagePreRempli} />
      </div>
      <div className="mt-5">
        <ApercuReponse reponse={reponse} messagePreRempli={messagePreRempli} />
      </div>
      <p className="mt-2 text-[11px] text-ink-400">
        {t('Le rendu réel varie selon le placement (fil, Instagram, stories), qui recadre le visuel différemment.',
           'The actual rendering varies by placement (feed, Instagram, stories), each cropping the image differently.')}
      </p>
    </div>
  );
}

/** L'annonce telle qu'elle apparaît dans le fil : en-tête de Page, texte, visuel, puis la barre du bouton. */
function ApercuFil({ titre, texte, visuel, nomPage }: {
  titre: string; texte: string; visuel: VisuelPub | null; nomPage: string | null;
}) {
  const t = useT();
  const nom = nomPage ?? t('Votre Page', 'Your Page');

  return (
    <div>
      <p className="mb-2 text-xs font-medium text-ink-500">{t('Dans le fil d’actualité', 'In the feed')}</p>
      <div className="overflow-hidden rounded-2xl border border-ink-200 bg-white shadow-sm" data-testid="pub-apercu-fil">
        <div className="flex items-center gap-2 px-3 py-2.5">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-ink-200 text-sm font-semibold text-ink-600">
            {nom.slice(0, 1).toUpperCase()}
          </div>
          <div className="min-w-0 leading-tight">
            <div className="truncate text-[13px] font-semibold text-ink-900" data-testid="pub-apercu-page">{nom}</div>
            <div className="text-[11px] text-ink-400">{t('Sponsorisé', 'Sponsored')}</div>
          </div>
        </div>

        <p className="whitespace-pre-wrap break-words px-3 pb-2.5 text-[13px] leading-snug text-ink-800" data-testid="pub-apercu-texte">
          {texte.trim()
            ? texte
            : <span className="text-ink-400">{t('Votre texte principal apparaîtra ici…', 'Your primary text will appear here…')}</span>}
        </p>

        {visuel !== null ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={`data:${visuel.type};base64,${visuel.base64}`} alt=""
            className="aspect-[1.91/1] w-full bg-ink-100 object-cover"
            data-testid="pub-apercu-visuel"
          />
        ) : (
          <div
            className="flex aspect-[1.91/1] w-full items-center justify-center bg-ink-100 px-4 text-center text-[11px] text-ink-400"
            data-testid="pub-apercu-visuel-absent"
          >
            {t('Choisissez un visuel pour le voir ici', 'Choose an image to see it here')}
          </div>
        )}

        <div className="flex items-center gap-3 bg-ink-50 px-3 py-2.5">
          <div className="min-w-0 flex-1">
            <div className="text-[10px] uppercase tracking-wide text-ink-400">WhatsApp</div>
            <div className="truncate text-[13px] font-semibold text-ink-900" data-testid="pub-apercu-titre">
              {titre.trim()
                ? titre
                : <span className="font-normal text-ink-400">{t('Votre titre apparaîtra ici…', 'Your headline will appear here…')}</span>}
            </div>
          </div>
          {/* Le libellé du bouton est posé par Meta (`call_to_action: WHATSAPP_MESSAGE`), pas par nous :
              il n'est donc pas saisissable dans le formulaire, et il ne doit pas en avoir l'air. */}
          <span className="shrink-0 rounded-lg bg-ink-200 px-2.5 py-1.5 text-[12px] font-medium text-ink-700">
            {t('Envoyer un message', 'Send message')}
          </span>
        </div>
      </div>
    </div>
  );
}

/**
 * La conversation qui s'ouvre quand le prospect appuie sur le bouton.
 *
 * 🔴 LES DEUX TEXTES SONT DANS DES EMPLACEMENTS DISTINCTS, ET C'EST TOUT L'INTÉRÊT DE CE PANNEAU.
 * L'accueil est une BULLE reçue, le message pré-rempli est dans la ZONE DE SAISIE, prêt à partir. Les
 * inverser produit une publicité absurde (le prospect s'accueille lui-même) sans qu'aucune validation ne
 * puisse s'en apercevoir : ce sont deux chaînes libres, toutes deux valides.
 */
function ApercuConversation({ accueil, messagePreRempli }: { accueil: string; messagePreRempli: string }) {
  const t = useT();

  return (
    <div data-testid="pub-apercu-conversation">
      {/* Le cadre résout lui-même le nom vérifié du numéro : c'est bien celui-là que le prospect lira. */}
      <PhoneFrame titre={t('Quand il appuie sur le bouton', 'When they tap the button')} contentClassName="min-h-[200px] px-3 py-4">
        <div className="max-w-[88%]">
          <div className="rounded-lg rounded-tl-none bg-white px-2.5 py-1.5 shadow-sm">
            <div className="whitespace-pre-wrap break-words text-[13px] leading-snug text-ink-800" data-testid="pub-apercu-accueil">
              {accueil.trim()
                ? accueil
                : <span className="text-ink-400">{t('Votre phrase d’accueil apparaîtra ici…', 'Your greeting will appear here…')}</span>}
            </div>
            <div className="mt-0.5 flex items-center justify-end gap-1 text-[10px] text-ink-400">12:30</div>
          </div>
        </div>

        <div className="mt-4 flex items-center gap-2">
          <div className="flex min-w-0 flex-1 items-center rounded-full bg-white px-3 py-2 shadow-sm">
            <span className="truncate text-[13px] text-ink-800" data-testid="pub-apercu-prerempli">
              {messagePreRempli.trim()
                ? messagePreRempli
                : <span className="text-ink-400">{t('Message pré-rempli…', 'Pre-filled message…')}</span>}
            </span>
          </div>
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[#25D366] text-white">
            <svg viewBox="0 0 24 24" className="h-4 w-4" fill="currentColor" aria-hidden="true">
              <path d="M2 21l21-9L2 3v7l15 2-15 2z" />
            </svg>
          </div>
        </div>
        <p className="mt-1.5 text-[10px] text-ink-500">
          {t('Il n’a plus qu’à appuyer sur envoyer.', 'They just press send.')}
        </p>
      </PhoneFrame>
    </div>
  );
}

/**
 * LE TROISIÈME ÉCRAN : le prospect a envoyé, et voilà ce qui lui revient.
 *
 * 🔴 DEUX RÉGIMES DE VÉRITÉ, ET L'ÉCART EST LE VRAI CONTENU DE CE PANNEAU. Un scénario est déterministe :
 * son premier message se lit dans le graphe PUBLIÉ, donc on affiche les mots exacts. L'agent de Meta
 * compose : on affiche une illustration, badgée « Exemple », avec une phrase qui dit que les mots ne sont
 * pas ceux-là. Un client qui choisit entre les deux choisit AUSSI entre « je maîtrise la première phrase »
 * et « je ne la maîtrise pas », et c'est ce panneau qui le lui apprend avant qu'il ne paie des clics.
 *
 * 🔴 DEUX ÉTATS SONT DES ALERTES, PAS DES INFORMATIONS : un scénario jamais publié, et un scénario qui
 * n'envoie rien depuis son entrée. Dans les deux cas, un clic PAYÉ recevrait le silence. C'est exactement
 * la régression que ce lot a déjà corrigée une fois côté serveur, et ici elle se voit avant de dépenser.
 */
function ApercuReponse({ reponse, messagePreRempli }: { reponse: EtatReponse; messagePreRempli: string }) {
  const t = useT();

  return (
    <div data-testid="pub-apercu-reponse">
      <PhoneFrame titre={t('La réponse qu’il recevra', 'The answer they get')} contentClassName="min-h-[180px] px-3 py-4">
        {/* Ce que le prospect vient d'envoyer : le message pré-rempli, parti tel quel. Le répéter ici est ce
            qui fait de ce panneau une SUITE du précédent et pas un écran indépendant. */}
        <div className="flex justify-end">
          <div className="max-w-[88%] rounded-lg rounded-tr-none bg-[#d9fdd3] px-2.5 py-1.5 shadow-sm">
            <div className="whitespace-pre-wrap break-words text-[13px] leading-snug text-ink-800">
              {messagePreRempli.trim()
                ? messagePreRempli
                : <span className="text-ink-400">{t('Message pré-rempli…', 'Pre-filled message…')}</span>}
            </div>
            <div className="mt-0.5 flex items-center justify-end gap-1 text-[10px] text-ink-400">
              12:31 <span className="text-[#53bdeb]">✓✓</span>
            </div>
          </div>
        </div>

        <div className="mt-2">{corpsReponse(reponse, t)}</div>
      </PhoneFrame>

      {reponse.etat === 'agent_meta' && (
        <p className="mt-2 text-[11px] text-ink-500" data-testid="pub-apercu-reponse-note">
          {t('Exemple d’échange. L’agent de Meta compose lui-même sa réponse à partir de sa configuration : l’allure sera celle-ci, les mots non.',
             'Sample exchange. The Meta agent composes its own answer from its configuration: the shape will look like this, the words will not.')}
        </p>
      )}
      {reponse.etat === 'connue' && reponse.reponse.genre === 'message' && (
        <p className="mt-2 text-[11px] text-ink-500" data-testid="pub-apercu-reponse-note">
          {t('Ce sont les mots exacts du scénario publié.', 'These are the exact words of the published scenario.')}
        </p>
      )}
    </div>
  );
}

/** Le texte d'illustration de l'agent de Meta. Générique EXPRÈS : il ne doit ressembler à une promesse pour
 *  aucun métier en particulier, seulement montrer la forme d'une première réponse. */
const EXEMPLE_AGENT_META: [string, string] = [
  'Bonjour 👋 Merci pour votre message. Pour vous répondre précisément, pouvez-vous me dire ce dont vous avez besoin et dans quel secteur vous êtes ?',
  'Hello 👋 Thanks for your message. So I can help properly, could you tell me what you need and where you are based?',
];

function corpsReponse(r: EtatReponse, t: (fr: string, en: string) => string): React.ReactNode {
  if (r.etat === 'agent_meta') {
    return (
      <Bulle testid="pub-apercu-reponse-texte" badge={t('Exemple', 'Sample')}>
        {t(...EXEMPLE_AGENT_META)}
      </Bulle>
    );
  }
  if (r.etat === 'sans_scenario') return <Note>{t('Choisissez un scénario pour voir sa première réponse.', 'Choose a scenario to see its first answer.')}</Note>;
  if (r.etat === 'chargement') return <Note>{t('Lecture du scénario…', 'Reading the scenario…')}</Note>;
  if (r.etat === 'illisible') {
    // ⚠️ NOTRE ÉCHEC, DIT COMME TEL. Inventer une réponse ici ferait valider des mots sur une lecture ratée.
    return <Note>{t('Nous n’avons pas pu lire ce scénario. Rechargez la page pour réessayer.', 'We could not read this scenario. Reload the page to try again.')}</Note>;
  }
  if (r.etat === 'hors_ligne') {
    return (
      <Alerte testid="pub-apercu-reponse-alerte">
        {t('Ce scénario n’a jamais été publié : un prospect qui clique n’aurait aucune réponse.',
           'This scenario has never been published: a lead who clicks would get no answer at all.')}
      </Alerte>
    );
  }

  const p = r.reponse;
  if (p.genre === 'message') {
    return (
      <Bulle testid="pub-apercu-reponse-texte" boutons={p.boutons}>
        {p.texte}
      </Bulle>
    );
  }
  if (p.genre === 'modele') {
    return (
      <Note>
        {p.nom === null
          ? t('Ce scénario commence par un modèle sans nom : rien ne partirait.', 'This scenario starts with an unnamed template: nothing would be sent.')
          : t(`Ce scénario commence par le modèle « ${p.nom} ». Son texte est approuvé chez Meta, il n’est pas lisible ici.`,
               `This scenario starts with the “${p.nom}” template. Its text lives approved at Meta and cannot be read here.`)}
      </Note>
    );
  }
  if (p.genre === 'formulaire') return <Note>{t('Ce scénario ouvre un formulaire WhatsApp chez le prospect.', 'This scenario opens a WhatsApp form for the lead.')}</Note>;
  if (p.genre === 'agent_ia') {
    return <Note>{t('Un agent IA répond : comme l’agent de Meta, il compose ses phrases, on ne peut pas les montrer.',
                    'An AI agent answers: like the Meta agent, it composes its own sentences, which cannot be shown.')}</Note>;
  }
  if (p.genre === 'autre_canal') {
    // ⚠️ Un lead publicitaire arrive PAR WhatsApp : un scénario qui ouvre ailleurs ne lui parle pas.
    return (
      <Alerte testid="pub-apercu-reponse-alerte">
        {p.type === 'email'
          ? t('Ce scénario commence par un e-mail : le prospect n’aurait rien sur WhatsApp.', 'This scenario starts with an email: the lead would get nothing on WhatsApp.')
          : t('Ce scénario commence par un message RCS : le prospect n’aurait rien sur WhatsApp.', 'This scenario starts with an RCS message: the lead would get nothing on WhatsApp.')}
      </Alerte>
    );
  }
  if (p.genre === 'indecidable') {
    return <Note>{t('Ce scénario commence par un embranchement : sa première réponse dépend du prospect, donc elle ne peut pas être montrée ici.',
                    'This scenario starts with a branch: its first answer depends on the lead, so it cannot be shown here.')}</Note>;
  }
  if (p.genre === 'aucun_envoi') {
    return (
      <Alerte testid="pub-apercu-reponse-alerte">
        {t('Ce scénario n’envoie rien depuis son bloc d’entrée : un prospect qui clique n’aurait aucune réponse.',
           'This scenario sends nothing from its entry block: a lead who clicks would get no answer.')}
      </Alerte>
    );
  }
  return (
    <Alerte testid="pub-apercu-reponse-alerte">
      {t('Ce scénario est vide : un prospect qui clique n’aurait aucune réponse.', 'This scenario is empty: a lead who clicks would get no answer.')}
    </Alerte>
  );
}

/** Une bulle reçue, avec son badge facultatif et ses boutons. */
function Bulle({ children, testid, badge, boutons = [] }: {
  children: React.ReactNode; testid: string; badge?: string; boutons?: string[];
}) {
  return (
    <div className="max-w-[88%]">
      <div className="rounded-lg rounded-tl-none bg-white px-2.5 py-1.5 shadow-sm">
        {badge !== undefined && (
          <div className="mb-1 inline-flex rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-800">
            {badge}
          </div>
        )}
        <div className="whitespace-pre-wrap break-words text-[13px] leading-snug text-ink-800" data-testid={testid}>{children}</div>
        <div className="mt-0.5 flex items-center justify-end gap-1 text-[10px] text-ink-400">12:31</div>
        {boutons.length > 0 && (
          <div className="-mx-2.5 -mb-1.5 mt-1.5">
            {boutons.map((b, i) => (
              <div key={i} className="border-t border-ink-100 py-1.5 text-center text-[13px] font-medium text-[#00a5f4]">{b}</div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function Note({ children }: { children: React.ReactNode }) {
  return <p className="rounded-lg bg-white/70 px-2.5 py-2 text-[12px] leading-snug text-ink-500" data-testid="pub-apercu-reponse-note-bloc">{children}</p>;
}

/** Un état où un clic PAYÉ recevrait le silence : il ne se dit pas du même ton qu'une information. */
function Alerte({ children, testid }: { children: React.ReactNode; testid: string }) {
  return (
    <p className="rounded-lg bg-red-50 px-2.5 py-2 text-[12px] font-medium leading-snug text-red-700" data-testid={testid}>
      {children}
    </p>
  );
}
