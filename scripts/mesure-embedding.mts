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

/**
 * 🔴 LES QUESTIONS HORS SUJET, ET C'EST LE TEST QUI DECIDE DE TOUT. La garde anti-hallucination du produit
 * repose sur une propriete : quand aucune fiche ne repond, l'agent doit SORTIR par « sans source » plutot que
 * de repondre de memoire. Le plein texte l'obtient gratuitement (aucun mot commun, aucune ligne remontee).
 *
 * Le vectoriel, lui, rend TOUJOURS un classement : il y a toujours une fiche « la moins loin ». Si une
 * question sans reponse produit quand meme un premier bien detache, alors AUCUNE regle semantique n'est sure,
 * et il faudra en tirer les consequences plutot que d'ecrire une regle qui rassure.
 */
const HORS_SUJET = [
  'vous vendez des velos electriques ?',
  'quelle est la recette de la tarte tatin ?',
  'je cherche un emploi chez vous, vous recrutez ?',
  'combien coute un billet de train pour Marseille ?',
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

/**
 * 🔴 LE RERANKER, ET POURQUOI IL CHANGE TOUT. Un embedding est un « bi-encodeur » : il encode la question et
 * la fiche SEPAREMENT, puis compare. Son cosinus dit « ces deux textes se ressemblent », ce qui n'est pas la
 * meme question que « cette fiche REPOND-elle a cette question ». C'est pour ça que le hors-sujet remonte a
 * 0,361 quand une vraie question descend a 0,299 : les deux nuages se chevauchent et AUCUN seuil n'est posable.
 *
 * Un reranker est un « cross-encodeur » : il lit la question ET la fiche ENSEMBLE et rend un score de
 * pertinence calibre. C'est l'outil du VERDICT, la ou l'embedding est l'outil du RAPPEL.
 *
 * Ce banc-ci mesure la seule chose qui compte : ce score separe-t-il les questions qui ont une reponse de
 * celles qui n'en ont pas ? Si non, on n'aura fait que deplacer le probleme.
 */
async function reranker(modele: string, question: string, documents: string[]): Promise<number[]> {
  const res = await fetch('https://ai-gateway.vercel.sh/v1/rerank', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cle}` },
    body: JSON.stringify({ model: modele, query: question, documents, top_n: documents.length }),
  });
  const corps = (await res.json()) as { results?: Array<{ index?: number; relevance_score?: number }>; error?: { message?: string } };
  if (!res.ok) throw new Error(`${res.status} ${corps.error?.message ?? ''}`.trim());
  const scores = new Array<number>(documents.length).fill(0);
  for (const r of corps.results ?? []) if (typeof r.index === 'number') scores[r.index] = Number(r.relevance_score ?? 0);
  return scores;
}

const RERANKERS = (process.argv[3] ?? '').split(',').filter((m) => m !== '');
for (const modele of RERANKERS) {
  try {
    console.log(`
=== RERANKER ${modele} ===`);
    const bonnes: number[] = [];
    for (const e of EPREUVES) {
      const scores = await reranker(modele, e.question, FICHES.map((f) => f.texte));
      const bonne = scores[FICHES.findIndex((f) => f.id === e.attendu)]!;
      const rang = [...scores].sort((a, b) => b - a).indexOf(bonne) + 1;
      bonnes.push(bonne);
      console.log(`  rang=${rang} score_bonne=${bonne.toFixed(4)} « ${e.question.slice(0, 30)} »`);
    }
    const horsSujet: number[] = [];
    for (const q of HORS_SUJET) {
      const scores = await reranker(modele, q, FICHES.map((f) => f.texte));
      const premier = Math.max(...scores);
      horsSujet.push(premier);
      console.log(`  HORS SUJET premier=${premier.toFixed(4)} « ${q.slice(0, 30)} »`);
    }
    const minBonne = Math.min(...bonnes);
    const maxHs = Math.max(...horsSujet);
    console.log(`  -> bonnes: min=${minBonne.toFixed(4)} | hors-sujet: max=${maxHs.toFixed(4)}`);
    console.log(`  -> SEUIL POSABLE : ${minBonne > maxHs ? `OUI, entre ${maxHs.toFixed(4)} et ${minBonne.toFixed(4)}` : 'NON, ça se chevauche encore'}`);
  } catch (err) {
    console.log(`  INDISPONIBLE : ${err instanceof Error ? err.message : String(err)}`);
  }
}

for (const modele of MODELES) {
  try {
    const fiches = await embarquer(modele, FICHES.map((f) => f.texte));
    const questions = await embarquer(modele, EPREUVES.map((e) => e.question));
    const dimension = fiches.vecteurs[0]?.length ?? 0;

    let premiers = 0;
    const details: string[] = [];
    const bonnes: number[] = [];
    const mauvaises: number[] = [];
    const ecarts: number[] = [];
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
      // 🔴 Le score ABSOLU de la bonne fiche, et celui de la meilleure MAUVAISE. C'est de ces deux nuages que
      // se lit un seuil : au-dessus duquel une fiche est « vraiment » pertinente, en dessous duquel elle ne
      // l'est pas. Un seuil pose a l'intuition serait soit inerte, soit un filtre qui coupe les bonnes fiches.
      const bonne = classement.find((c) => c.id === EPREUVES[i]!.attendu)!.score;
      const pireMeilleure = classement.filter((c) => c.id !== EPREUVES[i]!.attendu)[0]!.score;
      bonnes.push(bonne); mauvaises.push(pireMeilleure); ecarts.push(ecart);
      details.push(`rang=${rang} bonne=${bonne.toFixed(3)} meilleure_mauvaise=${pireMeilleure.toFixed(3)} ecart=${ecart.toFixed(3)} « ${EPREUVES[i]!.question.slice(0, 30)} »`);
    }
    console.log(`\n=== ${modele} ===`);
    console.log(`dimension=${dimension} bonnes_reponses_en_1er=${premiers}/${EPREUVES.length} tokens=${fiches.tokens + questions.tokens} cout=$${(fiches.cout + questions.cout).toFixed(6)}`);
    for (const d of details) console.log('  ' + d);
    // La SEPARATION des deux nuages : c'est elle qui dit si un seuil est posable, et ou.
    console.log(`  -> bonnes: min=${Math.min(...bonnes).toFixed(3)} max=${Math.max(...bonnes).toFixed(3)} | mauvaises: min=${Math.min(...mauvaises).toFixed(3)} max=${Math.max(...mauvaises).toFixed(3)}`);
    console.log(`  -> seuil posable : ${Math.min(...bonnes) > Math.max(...mauvaises) ? `OUI, entre ${Math.max(...mauvaises).toFixed(3)} et ${Math.min(...bonnes).toFixed(3)}` : 'NON, les nuages se chevauchent'}`);

    // Le test qui decide : une question SANS reponse dans le corpus doit se distinguer d'une question qui en a
    // une. On regarde le score du premier et son ecart au deuxieme, exactement ce qu'une regle observerait.
    const hs = await embarquer(modele, HORS_SUJET);
    const scoresHs: Array<{ premier: number; ecart: number }> = [];
    for (let i = 0; i < HORS_SUJET.length; i += 1) {
      const c = FICHES.map((f, j) => cosinus(hs.vecteurs[i]!, fiches.vecteurs[j]!)).sort((a, b) => b - a);
      scoresHs.push({ premier: c[0]!, ecart: c[0]! - c[1]! });
      console.log(`  HORS SUJET premier=${c[0]!.toFixed(3)} ecart=${(c[0]! - c[1]!).toFixed(3)} « ${HORS_SUJET[i]!.slice(0, 30)} »`);
    }
    const pireHs = Math.max(...scoresHs.map((x) => x.premier));
    const pireEcartHs = Math.max(...scoresHs.map((x) => x.ecart));
    console.log(`  -> un SCORE separe-t-il le hors-sujet ? ${Math.min(...bonnes) > pireHs ? `OUI (> ${pireHs.toFixed(3)})` : `NON (hors-sujet monte a ${pireHs.toFixed(3)}, une bonne descend a ${Math.min(...bonnes).toFixed(3)})`}`);
    console.log(`  -> un ECART separe-t-il le hors-sujet ? ${Math.min(...ecarts) > pireEcartHs ? `OUI (> ${pireEcartHs.toFixed(3)})` : `NON (hors-sujet atteint ${pireEcartHs.toFixed(3)}, un bon descend a ${Math.min(...ecarts).toFixed(3)})`}`);
  } catch (err) {
    console.log(`\n=== ${modele} ===\nINDISPONIBLE : ${err instanceof Error ? err.message : String(err)}`);
  }
}
