/**
 * L'ADRESSE D'UNE ORG SALESFORCE, saisie par l'admin du client (plan 2026-09-26, lot L1).
 *
 * 🔴 C'EST UNE ADRESSE SAISIE PAR UN CLIENT, donc la première des deux vérifications du dépôt : celle du TEXTE.
 * La seconde (ce vers quoi le nom RÉSOUT) reste `resolutionPublique`, au clic « Connecter », et chaque appel passe
 * ensuite par `fetchPublic` (`src/salesforce/client.ts`). Cette garde est plus stricte que `urlRecuperable`, qui
 * accepte n'importe quel hôte public : ici, seuls les domaines d'org de Salesforce passent.
 *
 * ⚠️ L'ADMIN COLLE SOUVENT L'ADRESSE DE SA BARRE DE NAVIGATION, pas son adresse My Domain : l'interface
 * Lightning (`…lightning.force.com`) ou la Configuration (`…my.salesforce-setup.com`), avec un chemin. Les trois
 * formes désignent la même org et se ramènent à `…my.salesforce.com`, la seule où parle l'API. Le chemin est
 * écarté : nous construisons nos propres adresses depuis l'origine. `login.salesforce.com` est refusée : ce
 * n'est l'adresse d'aucune org, et le jeton du client doit être demandé à la sienne.
 *
 * Les formes d'adresse mesurées au lot L0 (`docs/salesforce-mesures-2026-09.md`) : `…develop.my.salesforce.com`
 * (Developer Edition) et `…scratch.my.salesforce.com` ; la production n'a pas de qualificatif, une sandbox porte
 * `.sandbox`. Government Cloud et la Chine ont d'autres domaines : hors du V1.
 */

export type GenreOrg = 'production' | 'sandbox' | 'developer' | 'scratch' | 'autre';

export type AdresseOrg =
  | { ok: true; origine: string; hote: string; genre: GenreOrg }
  | { ok: false; raison: string };

/** Le qualificatif d'une adresse d'org, entre son nom et le domaine. Liste fermée : un inconnu est refusé. */
const QUALIFICATIFS: Readonly<Record<string, GenreOrg>> = {
  sandbox: 'sandbox',
  develop: 'developer',
  scratch: 'scratch',
  demo: 'autre',
  patch: 'autre',
  trailblaze: 'autre',
};

/** Les trois domaines sous lesquels une org se montre, et qui désignent tous la même org. */
const DOMAINES = ['my.salesforce.com', 'lightning.force.com', 'my.salesforce-setup.com'] as const;

/** Le nom My Domain : lettres, chiffres, tirets (une sandbox porte `nom--sandbox`). */
const NOM_RE = /^[a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])?$/;

const REFUS_FORME = "Collez l'adresse de votre org Salesforce, par exemple https://votre-societe.my.salesforce.com.";

export function lireMyDomain(brut: string): AdresseOrg {
  const texte = brut.trim();
  if (texte === '') return { ok: false, raison: REFUS_FORME };
  // Sans schéma, on suppose https ; un http EXPLICITE est refusé plus bas, jamais corrigé en silence.
  const avecSchema = /^[a-z][a-z0-9+.-]*:\/\//i.test(texte) ? texte : `https://${texte}`;
  let url: URL;
  try {
    url = new URL(avecSchema);
  } catch {
    return { ok: false, raison: REFUS_FORME };
  }
  if (url.protocol !== 'https:') return { ok: false, raison: "L'adresse de l'org doit commencer par https://." };
  if (url.username !== '' || url.password !== '') {
    return { ok: false, raison: "L'adresse ne doit contenir ni identifiant ni mot de passe." };
  }
  if (url.port !== '') return { ok: false, raison: "L'adresse de l'org ne porte pas de numéro de port." };

  const hote = url.hostname.toLowerCase();
  if (hote === 'login.salesforce.com' || hote === 'test.salesforce.com') {
    return { ok: false, raison: "C'est l'adresse de connexion générale de Salesforce : collez celle de VOTRE org (menu de votre avatar, sous votre nom)." };
  }
  const domaine = DOMAINES.find((d) => hote.endsWith(`.${d}`));
  if (!domaine) return { ok: false, raison: REFUS_FORME };

  const labels = hote.slice(0, -(domaine.length + 1)).split('.');
  const nom = labels[0] ?? '';
  let genre: GenreOrg = 'production';
  if (labels.length === 2) {
    const g = QUALIFICATIFS[labels[1]!];
    if (!g) return { ok: false, raison: REFUS_FORME };
    genre = g;
  } else if (labels.length !== 1) {
    return { ok: false, raison: REFUS_FORME };
  }
  if (!NOM_RE.test(nom)) return { ok: false, raison: REFUS_FORME };

  const hoteApi = [nom, ...labels.slice(1), 'my.salesforce.com'].join('.');
  return { ok: true, origine: `https://${hoteApi}`, hote: hoteApi, genre };
}
