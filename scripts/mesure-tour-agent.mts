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

interface Mesure { tour: number; ar: number; tokensIn: number; tokensCaches: number; tokensOut: number; ms: number; coutDollars: number }
const mesures: Mesure[] = [];

for (let tour = 0; tour < TOURS; tour += 1) {
  const messages: ChatMessage[] = [
    { role: 'system', content: systeme },
    { role: 'user', content: QUESTIONS[tour % QUESTIONS.length]! },
  ];
  // Meme borne que la production : un tour ne fait pas plus de six allers-retours.
  for (let ar = 0; ar < 6; ar += 1) {
    const debut = Date.now();
    const r = await client.completer({ modele, messages, ...(outils.length > 0 ? { outils } : {}) });
    const ms = Date.now() - debut;
    mesures.push({ tour, ar, tokensIn: r.usage.tokensIn, tokensCaches: r.usage.tokensCaches, tokensOut: r.usage.tokensOut, ms, coutDollars: r.usage.coutDollars });
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

const parTour = new Map<number, Mesure[]>();
for (const m of mesures) parTour.set(m.tour, [...(parTour.get(m.tour) ?? []), m]);

const somme = (f: (m: Mesure) => number): number => mesures.reduce((n, m) => n + f(m), 0);
const premiers = mesures.filter((m) => m.ar === 0);

console.log('\n=== SYNTHESE ===');
console.log(JSON.stringify({
  modele,
  taille_prompt_systeme_caracteres: systeme.length,
  outils_exposes: outils.length,
  tours: TOURS,
  allers_retours_total: mesures.length,
  allers_retours_par_tour_moyen: Number((mesures.length / TOURS).toFixed(2)),
  tokens_in_total: somme((m) => m.tokensIn),
  tokens_caches_total: somme((m) => m.tokensCaches),
  part_cachee_pourcent: somme((m) => m.tokensIn) === 0 ? 0 : Math.round((somme((m) => m.tokensCaches) / somme((m) => m.tokensIn)) * 100),
  tokens_out_total: somme((m) => m.tokensOut),
  duree_moyenne_tour_ms: Math.round([...parTour.values()].reduce((n, l) => n + l.reduce((s, m) => s + m.ms, 0), 0) / TOURS),
  duree_max_tour_ms: Math.max(...[...parTour.values()].map((l) => l.reduce((s, m) => s + m.ms, 0))),
  cout_total_dollars: Number(somme((m) => m.coutDollars).toFixed(6)),
  // 🔴 LA question du cache : le PREMIER aller-retour de chaque tour porte le meme prefixe constant. Si le
  // cache opere, sa part cachee doit grimper des le deuxieme TOUR, pas seulement au deuxieme aller-retour.
  premiers_allers_retours: premiers.map((m) => ({ tour: m.tour, in: m.tokensIn, caches: m.tokensCaches })),
}, null, 2));
