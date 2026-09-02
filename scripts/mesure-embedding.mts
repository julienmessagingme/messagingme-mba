/**
 * CHOISIR LE MODELE D'EMBEDDING, EN LE MESURANT (chantier vectorisation, 2026-09-02).
 *
 * 🔴 POURQUOI CE CHOIX SE MESURE ET NE SE DEVINE PAS. Deux raisons, et la seconde est irreversible :
 *   1. nos clients ecrivent en FRANÇAIS, et beaucoup de modeles d'embedding sont excellents en anglais et
 *      mediocres ailleurs. La reputation d'un modele ne dit rien de notre cas ;
 *   2. la DIMENSION du vecteur est figee par le modele et devient celle de la colonne Postgres. En changer
 *      plus tard oblige a recalculer les vecteurs de TOUS les clients.
 *
 * CE QU'IL EPROUVE, et c'est exactement le defaut que la vectorisation doit corriger : une question posee
 * avec les mots du CLIENT doit retrouver la fiche ecrite avec les mots de L'ENTREPRISE. « C'est combien pour
 * resilier » doit trouver « Conditions de sortie de contrat », que le plein texte ne trouvera jamais : ces
 * deux phrases n'ont AUCUN mot en commun.
 *
 * Le banc rend, par modele : la dimension, le rang de la bonne fiche pour chaque question, et le cout.
 *
 * Usage : AI_GATEWAY_API_KEY=... npx tsx scripts/mesure-embedding.mts
 */
const cle = process.env.AI_GATEWAY_API_KEY ?? '';
if (cle === '') throw new Error('AI_GATEWAY_API_KEY requis : ce banc appelle le vrai Gateway.');

/** Les candidats serieux : multilingues declares, ou tres largement eprouves. */
const MODELES = (process.argv[2] ?? [
  'openai/text-embedding-3-small',
  'google/text-multilingual-embedding-002',
  'mistral/mistral-embed',
  'cohere/embed-v4.0',
].join(',')).split(',');

/**
 * Le corpus d'epreuve : des fiches ecrites dans la langue d'une ENTREPRISE. Volontairement sans les mots que
 * le client emploiera, sinon le plein texte suffirait et le banc ne prouverait rien.
 */
const FICHES = [
  { id: 'sortie', texte: "Conditions de sortie de contrat. Le souscripteur peut mettre fin a son engagement a l'echeance annuelle, moyennant un preavis de deux mois. Des frais de dossier de 45 euros s'appliquent hors cas de motif legitime." },
  { id: 'panne', texte: "Assistance en cas d'immobilisation du vehicule. Un depannage sur place est declenche sous 45 minutes en zone urbaine. Le remorquage vers le reparateur agree le plus proche est pris en charge." },
  { id: 'horaires', texte: "Accueil telephonique et physique. Nos conseillers vous repondent du lundi au vendredi de 8h30 a 19h, et le samedi matin de 9h a 12h30. Les agences sont fermees les jours feries." },
  { id: 'paiement', texte: "Modalites de reglement. Le prelevement automatique est propose mensuellement, trimestriellement ou annuellement. Un changement de periodicite prend effet a la prochaine echeance." },
  { id: 'sinistre', texte: "Declaration d'un dommage. Vous disposez de cinq jours ouvres pour nous informer, ou deux jours en cas de vol. Le constat amiable accelere considerablement le traitement du dossier." },
  { id: 'electrique', texte: "Motorisation cent pour cent electrique. L'autonomie annoncee en cycle mixte atteint 454 kilometres. La recharge rapide en courant continu permet de passer de 10 a 80 pour cent en dix-huit minutes." },
];

/**
 * Les questions telles qu'un CLIENT les pose, avec la fiche attendue. Aucune ne reprend les mots-cles de sa
 * fiche : c'est tout l'interet, et c'est ce que le plein texte rate.
 */
const EPREUVES = [
  { question: "c'est combien pour resilier ?", attendu: 'sortie' },
  { question: 'je suis en rade sur le bord de la route, vous faites quoi ?', attendu: 'panne' },
  { question: 'vous etes ouverts le week-end ?', attendu: 'horaires' },
  { question: 'je voudrais payer tous les trois mois au lieu de chaque mois', attendu: 'paiement' },
  { question: 'on m a vole ma voiture cette nuit, je fais quoi ?', attendu: 'sinistre' },
  { question: 'elle tient combien de kilometres sans recharger ?', attendu: 'electrique' },
];

interface ReponseEmbeddings {
  data?: Array<{ embedding?: number[] }>;
  usage?: { prompt_tokens?: number; total_tokens?: number; cost?: number };
  error?: { message?: string };
}

async function embarquer(modele: string, textes: string[]): Promise<{ vecteurs: number[][]; tokens: number; cout: number }> {
  const res = await fetch('https://ai-gateway.vercel.sh/v1/embeddings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cle}` },
    body: JSON.stringify({ model: modele, input: textes }),
  });
  const corps = (await res.json()) as ReponseEmbeddings;
  if (!res.ok) throw new Error(`${res.status} ${corps.error?.message ?? ''}`.trim());
  const vecteurs = (corps.data ?? []).map((d) => d.embedding ?? []);
  if (vecteurs.length !== textes.length) throw new Error(`${vecteurs.length} vecteurs pour ${textes.length} textes`);
  return { vecteurs, tokens: Number(corps.usage?.total_tokens ?? corps.usage?.prompt_tokens ?? 0), cout: Number(corps.usage?.cost ?? 0) };
}

/** Cosinus. C'est l'operateur que pgvector appliquera (`<=>` rend 1 - cosinus). */
function cosinus(a: number[], b: number[]): number {
  let ps = 0; let na = 0; let nb = 0;
  for (let i = 0; i < a.length; i += 1) { ps += a[i]! * b[i]!; na += a[i]! * a[i]!; nb += b[i]! * b[i]!; }
  return na === 0 || nb === 0 ? 0 : ps / (Math.sqrt(na) * Math.sqrt(nb));
}

for (const modele of MODELES) {
  try {
    const fiches = await embarquer(modele, FICHES.map((f) => f.texte));
    const questions = await embarquer(modele, EPREUVES.map((e) => e.question));
    const dimension = fiches.vecteurs[0]?.length ?? 0;

    let premiers = 0;
    const details: string[] = [];
    for (let i = 0; i < EPREUVES.length; i += 1) {
      const q = questions.vecteurs[i]!;
      const classement = FICHES
        .map((f, j) => ({ id: f.id, score: cosinus(q, fiches.vecteurs[j]!) }))
        .sort((a, b) => b.score - a.score);
      const rang = classement.findIndex((c) => c.id === EPREUVES[i]!.attendu) + 1;
      if (rang === 1) premiers += 1;
      // L'ECART au deuxieme compte autant que le rang : un premier a 0,001 pres n'est pas un choix, c'est
      // un hasard, et il basculera sur la question suivante.
      const ecart = classement[0]!.score - classement[1]!.score;
      details.push(`rang=${rang} ecart=${ecart.toFixed(3)} « ${EPREUVES[i]!.question.slice(0, 38)} »`);
    }
    console.log(`\n=== ${modele} ===`);
    console.log(`dimension=${dimension} bonnes_reponses_en_1er=${premiers}/${EPREUVES.length} tokens=${fiches.tokens + questions.tokens} cout=$${(fiches.cout + questions.cout).toFixed(6)}`);
    for (const d of details) console.log('  ' + d);
  } catch (err) {
    console.log(`\n=== ${modele} ===\nINDISPONIBLE : ${err instanceof Error ? err.message : String(err)}`);
  }
}
