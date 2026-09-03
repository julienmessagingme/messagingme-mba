/**
 * MESURER UN TOUR D'AGENT REEL (geste 4 du chantier IA, plan post-audit du 2026-09-02).
 *
 * 🔴 CE QUE CE BANC REPOND, ET POURQUOI IL FALLAIT LE FAIRE AVANT DE CHOISIR LES CHIFFRES. Un tour d'agent
 * n'est pas un appel : c'est jusqu'a six allers-retours, et chacun renvoie l'integralite du prompt systeme,
 * des definitions d'outils et des resultats d'outils deja accumules. Trois inconnues en decoulaient, et
 * aucune ne se devine :
 *   1. combien de tokens un tour coute VRAIMENT, et combien d allers-retours il fait ;
 *   2. combien de temps il dure, ce qui decide de la concurrence par la loi de Little ;
 *   3. si la partie CONSTANTE du prompt est servie depuis un cache, ce qui change le cout et le debit
 *      tenable d un ordre de grandeur.
 *
 * ⚠️ IL APPELLE LE VRAI GATEWAY ET IL COUTE DE L ARGENT. Quelques dizaines d appels sur un modele rapide,
 * donc quelques centimes, mais ce n est pas gratuit et ce n est pas un test.
 *
 * ⚠️ IL NE TOUCHE NI LA BASE NI AUCUN ESPACE CLIENT : aucune session d agent n est ouverte, aucun credit n
 * est debite, rien n est ecrit. C est un banc, pas un chemin de production.
 *
 * POURQUOI LE CORPUS HYUNDAI (idee de Julien). La question du cache ne se pose que sur un prefixe LONG :
 * mesurer avec une fiche d agent de trois lignes ne dirait rien de ce qui nous attend chez un vrai client.
 * Le corpus Hyundai (17 modeles, leurs descriptions, les concessions) donne une base de connaissance de
 * taille realiste sans avoir a inventer des donnees plausibles, qui seraient un troisieme mensonge.
 *
 * Usage (sur le VPS, ou la cle du Gateway existe) :
 *   AI_GATEWAY_API_KEY=... AGENT_MODEL=zai/glm-4.7-flash \
 *     npx tsx scripts/mesure-tour-agent.mts /home/ubuntu/hyundai/data/vehicules.json 5
 */
import { readFileSync } from 'node:fs';
import { GatewayChatClient } from '../src/agent/llm/chat-client';
import type { ChatMessage } from '../src/agent/llm/chat-client';
import { promptSysteme } from '../src/agent/prompt';
import { outilsExposes } from '../src/agent/outils-maison';
import { OUTILS_MAISON } from '../src/agent/outils-maison';

const cle = process.env.AI_GATEWAY_API_KEY ?? '';
const modele = process.env.AGENT_MODEL ?? 'zai/glm-4.7-flash';
if (cle === '') throw new Error('AI_GATEWAY_API_KEY requis : ce banc appelle le vrai Gateway.');

const [cheminCorpus, nbTours] = process.argv.slice(2);
if (!cheminCorpus) throw new Error('usage : mesure-tour-agent.mts <chemin/vehicules.json> [nbTours]');
const TOURS = Number(nbTours ?? 5);

/** Le corpus, reduit a ce qu une base de connaissance porterait vraiment : pas les URL d images. */
interface Vehicule { nom?: string; description?: string; slug?: string }
const brut = JSON.parse(readFileSync(cheminCorpus, 'utf8')) as { vehicules?: Vehicule[] };
const vehicules = (brut.vehicules ?? []).map((v) => ({
  nom: String(v.nom ?? v.slug ?? ''),
  description: String(v.description ?? '').slice(0, 600),
})).filter((v) => v.nom !== '');
if (vehicules.length === 0) throw new Error(`aucun vehicule lisible dans ${cheminCorpus}`);

/** La fiche de l agent, telle qu un client la remplirait. C est ce qui devient le prompt systeme. */
const fiche = {
  nom: 'Alex',
  objectif: [
    'Conseiller un client sur le modele Hyundai qui lui convient, en te fondant UNIQUEMENT sur le catalogue.',
    'Quand le besoin est clair, proposer un essai en concession et recueillir la ville du client.',
    'Ne jamais inventer un prix, une autonomie ou une disponibilite : si tu ne sais pas, tu le dis.',
  ].join('\n'),
  ton: 'Chaleureux, direct, phrases courtes. Vouvoiement. Jamais plus de trois questions d affilee.',
  personnalite: 'Tu connais la gamme par coeur et tu detestes le jargon technique inutile.',
  reglesTransfert: 'Demande explicite de parler a un humain, reclamation, ou question de financement.',
  reglesArret: '',
  sorties: [] as Array<{ code: string; libelle: string }>,
};

/**
 * MODE « PREFIXE LONG » (troisieme argument, `long`).
 *
 * 🔴 Pourquoi ce mode existe. La premiere mesure a donne `cached_tokens = 0` sur cinq tours portant un
 * prefixe IDENTIQUE. Deux explications tiennent, et elles n appellent pas la meme suite : soit le fournisseur
 * ne cache pas (ou ne le rapporte pas), soit notre prefixe est trop COURT pour son seuil, la plupart des
 * fournisseurs ne cachant qu au-dela d environ 1 024 tokens, et le notre en fait a peine 1 090.
 *
 * Conclure « pas de cache » sans avoir ecarte la seconde serait exactement l erreur que ce chantier corrige :
 * affirmer sans mesurer. Ce mode verse le catalogue DANS le prompt systeme, ce qui le porte a plusieurs
 * milliers de tokens, tres au-dessus de tout seuil plausible.
 */
const PREFIXE_LONG = (process.argv[4] ?? '') === 'long';
const catalogueTexte = vehicules.map((v) => `- ${v.nom} : ${v.description}`).join('\n');
if (PREFIXE_LONG) fiche.objectif = `${fiche.objectif}\n\nCatalogue complet, a citer sans jamais l inventer :\n${catalogueTexte}`;

const systeme = promptSysteme({
  mentionIa: 'Bonjour, je suis un assistant automatique.',
  contenu: fiche as never,
  contactConnu: false,
});

/**
 * Les outils REELS du produit, pas une liste inventee : leur schema pese dans CHAQUE appel, donc il fait
 * partie de ce qu on mesure. On construit ici la ligne `agent_tools` que la console ecrirait quand un client
 * active un outil maison, en reprenant les libelles francais du catalogue.
 *
 * `envoyer_bloc` est ecarte : il n a de sens qu attache a un bloc de scenario reel.
 */
const outils = outilsExposes(
  OUTILS_MAISON.filter((o) => o.handler !== 'envoyer_bloc').map((o, i) => ({
    id: `banc-${i}`,
    tenantId: 'banc',
    agentId: 'banc',
    origin: 'mba',
    name: o.nomDefaut,
    description: o.description.fr,
    nePasUtiliser: o.nePasUtiliser.fr,
    params: o.params.map((p) => ({ name: p.name, description: p.description })),
    binding: { handler: o.handler },
    sourceId: null,
    requestId: null,
    extraction: [],
  })) as never,
  [],
);

/**
 * Le resultat que renverrait l outil de recherche de connaissance. C EST LUI qui fait grossir le contexte
 * d un aller-retour a l autre, et c est la moitie du sujet : ce qui est cache, c est le PREFIXE constant,
 * pas ce qui s ajoute.
 */
const resultatConnaissance = JSON.stringify({
  fiches: vehicules.map((v) => ({ titre: v.nom, contenu: v.description })),
});

/** Le nom sous lequel la recherche de connaissance est EXPOSEE au modele, dérivé du catalogue. */
const NOM_CONNAISSANCE = OUTILS_MAISON.find((o) => o.handler === 'chercher_connaissance')!.nomDefaut;

const QUESTIONS = [
  'Bonjour, je cherche une voiture pour la ville, pas trop chere, plutot hybride. Vous avez quoi ?',
  'Je fais 80 km par jour sur autoroute, quel modele vous me conseillez ?',
  'Ma femme veut un SUV mais moi je veux electrique, il y a quelque chose pour nous deux ?',
  'C est quoi la difference entre la i20 et la i30 ?',
  'Je peux essayer un modele electrique pres de Lyon ?',
];

const client = new GatewayChatClient(cle);

interface Mesure { tour: number; ar: number; tokensIn: number; tokensCaches: number; tokensOut: number; ms: number; coutDollars: number; fin: number }
/** L instant de chaque echec, pour savoir A QUELLE MINUTE il est arrive : un refus qui n arrive qu apres la
 *  troisieme minute est la signature d un plafond par fenetre, et un total ne le dirait pas. */
const instantsEchecs: number[] = [];
const mesures: Mesure[] = [];
const echecs: string[] = [];

/** Un tour complet, exactement comme la boucle de production le joue. */
async function jouerUnTour(tour: number): Promise<void> {
  const messages: ChatMessage[] = [
    { role: 'system', content: systeme },
    { role: 'user', content: QUESTIONS[tour % QUESTIONS.length]! },
  ];
  // Meme borne que la production : un tour ne fait pas plus de six allers-retours.
  for (let ar = 0; ar < 6; ar += 1) {
    const debut = Date.now();
    let r;
    try {
      r = await client.completer({ modele, messages, ...(outils.length > 0 ? { outils } : {}) });
    } catch (err) {
      // 🔴 UN ECHEC EST UNE MESURE, PAS UN ACCIDENT. C'est meme LA mesure qu'on cherche sous concurrence :
      // un 429 dit ou est la limite du Gateway, et l'avaler reviendrait a ne pas voir la reponse.
      const message = err instanceof Error ? err.message : String(err);
      echecs.push(`tour=${tour} ar=${ar} ${message}`);
      instantsEchecs.push(Date.now());
      console.log(`tour=${tour} ar=${ar} ECHEC ${message}`);
      return;
    }
    const ms = Date.now() - debut;
    mesures.push({ tour, ar, tokensIn: r.usage.tokensIn, tokensCaches: r.usage.tokensCaches, tokensOut: r.usage.tokensOut, ms, coutDollars: r.usage.coutDollars, fin: Date.now() });
    console.log(`tour=${tour} ar=${ar} in=${r.usage.tokensIn} caches=${r.usage.tokensCaches} out=${r.usage.tokensOut} ${ms}ms outils=${r.appelsOutils.length} finish=${r.finish}`);
    if (r.appelsOutils.length === 0) break;
    // On rejoue exactement ce que fait la boucle de production : le message assistant qui porte les appels,
    // puis un message `tool` par appel. C'est ce qui fait grossir le contexte a l'aller-retour suivant.
    messages.push({ role: 'assistant', content: r.texte ?? '', tool_calls: r.appelsOutils.map((a) => ({ id: a.id, type: 'function', function: { name: a.nom, arguments: a.argumentsJson } })) } as never);
    for (const a of r.appelsOutils) {
      // ⚠️ On compare le nom EXPOSE au modele (`nomDefaut`), pas le handler. Ma premiere version comparait le
      // handler : la recherche de connaissance n'etait donc jamais reconnue, le corpus n'entrait jamais dans
      // le contexte, et le banc mesurait un prompt de 1 100 tokens en croyant en mesurer un long. Un banc qui
      // se trompe de mesure est pire qu'une absence de banc, parce qu'il produit un chiffre.
      messages.push({ role: 'tool', tool_call_id: a.id, content: a.nom === NOM_CONNAISSANCE ? resultatConnaissance : '{"ok":true}' } as never);
    }
  }
}

/**
 * MODE CONCURRENCE (cinquieme argument). Sans lui, les tours sont joues l un apres l autre et le banc mesure
 * la duree d un tour SEUL, c est-a-dire l entree de la loi de Little et pas sa verification.
 *
 * 🔴 Ce mode-ci repond a la question qui restait ouverte : le Gateway ne publie AUCUNE limite en tokens par
 * minute, ni dans sa documentation ni dans ses en-tetes de reponse (verifie le 2026-09-02). Quand la
 * specification est muette, on mesure : on lance N tours EN MEME TEMPS et on regarde si des 429 arrivent et
 * si la duree par tour se degrade.
 */
const PARALLELES = Math.max(1, Number(process.argv[5] ?? 1));

/**
 * MODE DUREE (`DUREE_S`), et c est le constat A4 de l audit externe du 2026-09-02.
 *
 * 🔴 CE QU UNE RAFALE DE DIX SECONDES NE PEUT PAS VOIR. Un plafond de debit s applique presque toujours sur
 * une FENETRE (tokens par minute, requetes par minute). Une rafale plus courte que la fenetre tient toujours,
 * quelle que soit la limite : elle mesure la capacite d un seau plein, pas le debit auquel il se remplit. Le
 * seul moyen de distinguer les deux est de tenir la charge PLUS LONGTEMPS que la fenetre, donc plusieurs
 * minutes, et de regarder si la duree par tour derive ou si des refus apparaissent en cours de route.
 *
 * Pose en variable d environnement et non en sixieme argument positionnel : la signature en compte deja cinq,
 * et un sixieme se serait lu de travers un jour ou l autre.
 */
const DUREE_S = Math.max(0, Number(process.env.DUREE_S ?? 0));
const debutBanc = Date.now();
const finPrevue = DUREE_S > 0 ? debutBanc + DUREE_S * 1000 : 0;
/** Le banc continue-t-il ? En mode duree c est l horloge qui decide, sinon c est le compteur de tours. */
const encore = (tour: number): boolean => (DUREE_S > 0 ? Date.now() < finPrevue : tour < TOURS);

if (PARALLELES === 1 && DUREE_S === 0) {
  for (let tour = 0; tour < TOURS; tour += 1) await jouerUnTour(tour);
} else {
  // Une vague de `PARALLELES` tours a la fois, jusqu'a epuisement : c'est le comportement d'une file dont la
  // concurrence est plafonnee, donc celui du worker.
  let prochain = 0;
  const fil = async (): Promise<void> => {
    for (;;) {
      const tour = prochain;
      prochain += 1;
      if (!encore(tour)) return;
      await jouerUnTour(tour);
    }
  };
  await Promise.all(Array.from({ length: PARALLELES }, () => fil()));
}

const dureeBancMs = Date.now() - debutBanc;

const parTour = new Map<number, Mesure[]>();
for (const m of mesures) parTour.set(m.tour, [...(parTour.get(m.tour) ?? []), m]);

const somme = (f: (m: Mesure) => number): number => mesures.reduce((n, m) => n + f(m), 0);
const premiers = mesures.filter((m) => m.ar === 0);

/**
 * Le banc DECOUPE PAR MINUTE. Sans ce decoupage, un banc de dix minutes ne vaut pas mieux qu un banc de dix
 * secondes : il rend une moyenne, et une moyenne noie exactement la degradation qu on cherche.
 */
interface Minute { minute: number; n: number; msTotal: number; tokens: number; echecs: number }
const minutes: Minute[] = [];
const bucket = (t: number): Minute => {
  const i = Math.floor((t - debutBanc) / 60_000);
  let m = minutes.find((x) => x.minute === i);
  if (!m) { m = { minute: i, n: 0, msTotal: 0, tokens: 0, echecs: 0 }; minutes.push(m); }
  return m;
};
for (const m of mesures) {
  const b = bucket(m.fin);
  b.n += 1;
  b.msTotal += m.ms;
  b.tokens += m.tokensIn + m.tokensOut;
}
for (const t of instantsEchecs) bucket(t).echecs += 1;
minutes.sort((a, b2) => a.minute - b2.minute);

console.log('\n=== SYNTHESE ===');
console.log(JSON.stringify({
  modele,
  taille_prompt_systeme_caracteres: systeme.length,
  outils_exposes: outils.length,
  tours: DUREE_S > 0 ? parTour.size : TOURS,
  mode: DUREE_S > 0 ? `duree ${DUREE_S} s` : `${TOURS} tours`,
  allers_retours_total: mesures.length,
  allers_retours_par_tour_moyen: parTour.size === 0 ? 0 : Number((mesures.length / parTour.size).toFixed(2)),
  tokens_in_total: somme((m) => m.tokensIn),
  tokens_caches_total: somme((m) => m.tokensCaches),
  part_cachee_pourcent: somme((m) => m.tokensIn) === 0 ? 0 : Math.round((somme((m) => m.tokensCaches) / somme((m) => m.tokensIn)) * 100),
  tokens_out_total: somme((m) => m.tokensOut),
  duree_moyenne_tour_ms: parTour.size === 0 ? 0 : Math.round([...parTour.values()].reduce((n, l) => n + l.reduce((s, m) => s + m.ms, 0), 0) / parTour.size),
  duree_max_tour_ms: Math.max(...[...parTour.values()].map((l) => l.reduce((s, m) => s + m.ms, 0))),
  cout_total_dollars: Number(somme((m) => m.coutDollars).toFixed(6)),
  // === Ce que seul le mode concurrence renseigne ===
  tours_en_parallele: PARALLELES,
  duree_totale_banc_ms: dureeBancMs,
  // 🔴 LE chiffre a confronter au plan Vercel : les limites d un gateway s expriment en tokens par minute,
  // pas en requetes simultanees. Extrapole du debit REELLEMENT obtenu pendant ce banc.
  tokens_par_minute_obtenus: Math.round(((somme((m) => m.tokensIn) + somme((m) => m.tokensOut)) / dureeBancMs) * 60_000),
  // Un echec sous concurrence est une MESURE : un 429 dit ou est la limite.
  echecs: echecs.length,
  detail_echecs: echecs.slice(0, 5),
  // 🔴 LA question du cache : le PREMIER aller-retour de chaque tour porte le meme prefixe constant. Si le
  // cache opere, sa part cachee doit grimper des le deuxieme TOUR, pas seulement au deuxieme aller-retour.
  premiers_allers_retours: premiers.slice(0, 20).map((m) => ({ tour: m.tour, in: m.tokensIn, caches: m.tokensCaches })),
  // 🔴 LA DERIVE, minute par minute, et c est POUR CA que le banc doit tenir plusieurs minutes (constat A4).
  // Une rafale courte rend une moyenne et une moyenne cache une pente : si un plafond par fenetre existe, il
  // se voit ici, en duree qui monte ou en debit qui tombe apres la premiere minute, jamais dans un total.
  par_minute: minutes.map((m) => ({
    minute: m.minute,
    allers_retours: m.n,
    duree_moyenne_ar_ms: Math.round(m.msTotal / m.n),
    tokens: m.tokens,
    echecs: m.echecs,
  })),
}, null, 2));
