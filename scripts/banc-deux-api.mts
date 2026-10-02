/**
 * BANC À DEUX COPIES D'API : le crash test exigé AVANT d'autoriser l'autoscaling (décision de Julien,
 * 2026-10-02 ; plan `docs/superpowers/plans/2026-10-02-deux-workers-et-banc-deux-api.md`).
 *
 * 🔴 CE QU'IL ÉPROUVE, ET POURQUOI UN SEUL PROCESSUS NE PEUT PAS LE MONTRER. Le code multi-instance est livré
 * (lots A, B et C du 2026-09-28) et son essai ne l'était pas. Ce qui se casse avec deux copies, ce n'est pas
 * le débit, c'est tout ce qui suppose un ÉTAT PARTAGÉ : un plafond compté en mémoire redevient un plafond PAR
 * COPIE, donc deux fois le quota vendu ; une clé révoquée reste vivante sur la copie qui n'a pas vu la
 * révocation, et celle d'un prestataire parti ne meurt jamais.
 *
 * Usage (jamais contre la production, cf. les deux gardes) :
 *   BANC_CONFIRME=1 BANC_API_A=http://banc-api-a:8095 BANC_API_B=http://banc-api-b:8095 \
 *     DATABASE_URL=postgres://...base-jetable... npx tsx scripts/banc-deux-api.mts
 *
 * 🔴 LA PRÉPARATION PASSE PAR LE VRAI CODE (`PgApiKeyStore`), PAS PAR UN HACHAGE RECOPIÉ, et pas non plus par
 * la console. Deux raisons. D'abord, recopier la dérivation d'une clé dans un banc créerait une seconde
 * vérité sur un secret, qui divergerait au premier changement. Ensuite, depuis la migration 0182 un admin
 * sans second facteur n'obtient pas de session : son login rend un `enrolToken`, pas un jeton. Passer par
 * l'écran ferait donc dépendre ce banc de l'enrôlement d'un TOTP, qui n'a rien à voir avec ce qu'il mesure.
 *
 * 🔴 L'ORDRE DES ÉPREUVES N'EST PAS LIBRE, et c'est le piège de ce banc : le test du plafond ÉPUISE la minute
 * de l'espace. Lancé en premier, son 429 masquerait le 401 attendu de la révocation, et le banc conclurait
 * « révocation vue des deux côtés » sur un refus qui n'a rien à voir. Le plafond passe donc EN DERNIER.
 */
import { Pool } from 'pg';
import { PgApiKeyStore } from '../src/auth/api-key-store.pg';

const A = process.env.BANC_API_A ?? '';
const B = process.env.BANC_API_B ?? '';
const URL_BASE = process.env.DATABASE_URL ?? '';
/** Le plafond par espace attendu (`API_PLAFOND_MINUTE`, défaut `PLAFOND_API_DEFAUT.minute` = 60). */
const PLAFOND_MINUTE = Number(process.env.BANC_PLAFOND_MINUTE ?? 60);

if (process.env.BANC_CONFIRME !== '1') {
  throw new Error('BANC_CONFIRME=1 manquant : ce banc cree une cle, en revoque une et sature un plafond.');
}
// La production vit sur le pooler Supabase, comme le dit la garde de `banc-charge.mts`.
if (URL_BASE === '') throw new Error('DATABASE_URL manquant');
if (/supabase/i.test(URL_BASE)) throw new Error('DATABASE_URL ressemble a la PRODUCTION : banc interdit.');
for (const [nom, url] of [['BANC_API_A', A], ['BANC_API_B', B]] as const) {
  if (url === '') throw new Error(`${nom} manquant`);
  if (/messagingme\.app/i.test(url)) throw new Error(`${nom} ressemble a la PRODUCTION : banc interdit.`);
}

type Issue = 'ok' | 'echec' | 'non_eprouve';
const verdicts: { nom: string; issue: Issue }[] = [];
const poser = (nom: string, issue: Issue, dit: string): void => {
  verdicts.push({ nom, issue });
  const etiquette = issue === 'ok' ? 'OK   ' : issue === 'echec' ? 'ECHEC' : '?????';
  // eslint-disable-next-line no-console
  console.log(`${etiquette}  ${nom} : ${dit}`);
};

const appel = async (base: string, chemin: string, cle: string): Promise<number> => {
  const r = await fetch(`${base}${chemin}`, { headers: { authorization: `Bearer ${cle}` } });
  return r.status;
};
/** Une lecture `/v1` quelconque : elle ne touche ni Meta, ni la facturation, ni une donnee a preparer. */
const lire = (base: string, cle: string): Promise<number> => appel(base, '/v1/scenarios', cle);

async function main(): Promise<void> {
  const pool = new Pool({ connectionString: URL_BASE, max: 2 });
  const cles = new PgApiKeyStore(pool);
  const espace = process.env.BANC_TENANT
    ?? (await pool.query<{ id: string }>('select id from tenants order by created_at limit 1')).rows[0]?.id;
  if (!espace) throw new Error('aucun espace en base : lancer `npm run seed` sur la base jetable d abord.');

  // ----- ÉPREUVE 1 : une cle creee est acceptee par les DEUX copies -----
  // Precondition des deux suivantes : sans elle, un 401 de B ne voudrait rien dire.
  const acceptee = await cles.create(espace, 'banc deux copies, acceptation', ['contacts:read', 'sends:create']);
  const a1 = await lire(A, acceptee.key);
  const b1 = await lire(B, acceptee.key);
  if (a1 === 200 && b1 === 200) poser('cle acceptee par les deux copies', 'ok', 'A 200, B 200');
  else poser('cle acceptee par les deux copies', 'echec', `A ${a1}, B ${b1}`);

  // ----- ÉPREUVE 2 : une cle REVOQUEE est refusee par les DEUX copies -----
  // 🔴 Le defaut que seule une seconde copie revele : un cache local au processus laisserait entrer sur la
  // copie qui n a pas vu la revocation.
  const jetable = await cles.create(espace, 'banc deux copies, revocation', ['contacts:read', 'sends:create']);
  const avantA = await lire(A, jetable.key);
  const avantB = await lire(B, jetable.key);
  if (avantA !== 200 || avantB !== 200) {
    poser('cle revoquee refusee des deux cotes', 'non_eprouve', `refusee avant revocation (A ${avantA}, B ${avantB})`);
  } else {
    const fait = await cles.revoke(espace, jetable.id);
    if (!fait) poser('cle revoquee refusee des deux cotes', 'non_eprouve', 'la revocation elle-meme a echoue');
    else {
      const apresA = await lire(A, jetable.key);
      const apresB = await lire(B, jetable.key);
      const refuse = (c: number): boolean => c === 401 || c === 403;
      if (refuse(apresA) && refuse(apresB)) poser('cle revoquee refusee des deux cotes', 'ok', `A ${apresA}, B ${apresB}`);
      else poser('cle revoquee refusee des deux cotes', 'echec', `A ${apresA}, B ${apresB} : une copie l acceptait encore`);
    }
  }

  // ----- ÉPREUVE 3 : le plafond par espace est GLOBAL aux deux copies -----
  // 🔴 EN DERNIER, parce qu elle epuise la minute (cf. l en-tete). Si chaque copie comptait pour elle-meme, on
  // passerait le double du quota vendu : c est ce que la migration 0186 ferme.
  let acceptes = 0;
  let refuses = 0;
  const refusePar = new Set<string>();
  const tirs = PLAFOND_MINUTE * 2 + 10;
  let inattendu = 0;
  for (let i = 0; i < tirs; i++) {
    const cote = i % 2 === 0 ? 'A' : 'B';
    const c = await lire(cote === 'A' ? A : B, acceptee.key);
    if (c === 200) acceptes++;
    else if (c === 429) { refuses++; refusePar.add(cote); }
    else { inattendu = c; break; }
  }
  const dit = `${acceptes} acceptes, ${refuses} refuses sur ${tirs} tirs alternes, plafond annonce ${PLAFOND_MINUTE}`;
  if (inattendu !== 0) poser('plafond global aux deux copies', 'non_eprouve', `reponse inattendue ${inattendu} : ${dit}`);
  else if (refuses === 0) poser('plafond global aux deux copies', 'non_eprouve', `${dit} : aucun refus, plafond desactive ?`);
  else if (acceptes > PLAFOND_MINUTE * 1.5) poser('plafond global aux deux copies', 'echec', `${dit} : chaque copie compte pour elle-meme`);
  else if (refusePar.size < 2) poser('plafond global aux deux copies', 'echec', `${dit} : une seule copie refuse, l autre ne voit pas le compteur`);
  else poser('plafond global aux deux copies', 'ok', dit);

  await pool.end();
}

main()
  .then(() => {
    const echecs = verdicts.filter((v) => v.issue === 'echec').length;
    const inconnus = verdicts.filter((v) => v.issue === 'non_eprouve').length;
    // eslint-disable-next-line no-console
    console.log(`\nBILAN : ${verdicts.length - echecs - inconnus} ok, ${echecs} echec(s), ${inconnus} non eprouve(s).`);
    // 🔴 Un « non eprouve » ne vaut PAS un succes : l autoscaling reste interdit tant qu une propriete n a pas
    // ete CONSTATEE. C est la difference entre « on a regarde » et « on a vu ».
    if (echecs > 0 || inconnus > 0) process.exit(1);
  })
  .catch((e) => {
    // eslint-disable-next-line no-console
    console.error('BANC EN ECHEC :', e instanceof Error ? e.message : e);
    process.exit(1);
  });
