import { lookup as lookupDns } from 'node:dns/promises';

/**
 * LA RÉSOLUTION DNS D'UNE CIBLE, ET CE QU'ELLE CACHE (constat A3 de l'audit externe du 2026-09-02).
 *
 * 🔴 CE QUE `urlRecuperable` NE POUVAIT PAS VOIR. Elle lit le TEXTE de l'hôte : elle refuse `localhost`,
 * `169.254.169.254`, `172.18.0.1`, et même leurs formes exotiques (hexadécimale, entière, IPv6 entre
 * crochets, IPv4 mappée). Vérifié le 2026-09-03, elle les rejette toutes. Mais `crm.exemple.fr` est un nom
 * parfaitement public dont l'enregistrement A peut pointer sur `169.254.169.254` (le service de métadonnées
 * du fournisseur) ou sur `172.18.x.x` (le réseau Docker du VPS, où vivent l'admin NPM et tous les autres
 * conteneurs). Aucun contrôle textuel ne peut voir ça : il faut RÉSOUDRE.
 *
 * ⚠️ CE QUE CE MODULE NE FERME PAS, ET IL FAUT LE SAVOIR. La vérification a lieu AVANT l'appel, et `fetch`
 * refait sa propre résolution : entre les deux, un serveur DNS hostile peut répondre une adresse publique
 * puis une adresse privée (« DNS rebinding »). Fermer CETTE fenêtre demande de fournir à la couche HTTP son
 * PROPRE résolveur (`undici`, option `connect.lookup`), donc d'ajouter une dépendance directe. Le rapport
 * n'est pas là aujourd'hui : le scénario exige que l'attaquant contrôle le domaine que l'ADMINISTRATEUR
 * CLIENT a lui-même saisi dans sa console, c'est-à-dire un administrateur hostile, qui dispose déjà de son
 * propre compte. Le cas RÉALISTE, un nom public qui pointe simplement vers l'intérieur, est fermé ici.
 *
 * Module PUR côté logique (`estAdressePrivee`) et injectable côté réseau : tout se teste sans DNS.
 */

/**
 * Cette adresse IP appartient-elle à un espace qu'un connecteur ne doit JAMAIS atteindre ?
 *
 * Couvre les deux familles, parce qu'une machine à double pile résout souvent les deux et qu'il suffit d'en
 * laisser une passer pour que la garde ne serve à rien.
 */
export function estAdressePrivee(ip: string): boolean {
  const a = ip.trim().toLowerCase();
  if (a === '') return true; // une adresse qu'on ne sait pas lire ne se laisse pas joindre

  // IPv4 mappée en IPv6 (`::ffff:10.0.0.1`) : on la ramène à sa forme v4, sinon elle passerait au travers des
  // deux jeux de règles à la fois, en n'étant tout à fait ni l'une ni l'autre.
  const mappee = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(a);
  const cible = mappee ? mappee[1]! : a;

  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(cible);
  if (v4) {
    const [o1, o2] = [Number(v4[1]), Number(v4[2])];
    return (
      o1 === 0            // « cet hôte »
      || o1 === 10        // privé
      || o1 === 127       // boucle locale
      || (o1 === 100 && o2 >= 64 && o2 <= 127) // CGNAT
      || (o1 === 169 && o2 === 254)            // lien-local ET métadonnées cloud
      || (o1 === 172 && o2 >= 16 && o2 <= 31)  // privé, et c'est là que vit le réseau Docker du VPS
      || (o1 === 192 && o2 === 168)            // privé
      || (o1 === 198 && (o2 === 18 || o2 === 19)) // bancs de mesure
      || o1 >= 224        // multicast et réservé
    );
  }

  // IPv6. Les formes compressées se comparent sur leur préfixe, ce qui suffit ici : on ne cherche pas à
  // valider une adresse, seulement à reconnaître les espaces interdits.
  if (cible === '::' || cible === '::1') return true;
  if (cible.startsWith('fe80:')) return true;                       // lien-local
  if (/^f[cd]/.test(cible)) return true;                            // unique-local (fc00::/7)
  if (cible.startsWith('ff')) return true;                          // multicast
  if (cible.startsWith('64:ff9b:')) return true;                    // NAT64 vers de l'IPv4 quelconque
  return false;
}

/** Le résolveur, injectable pour tester sans DNS. Rend les adresses associées au nom. */
export type Resolveur = (hote: string) => Promise<string[]>;

const resolveurParDefaut: Resolveur = async (hote) => {
  const adresses = await lookupDns(hote, { all: true, verbatim: true });
  return adresses.map((a) => a.address);
};

export interface VerdictResolution {
  ok: boolean;
  /** Lisible, sans jamais citer l'adresse trouvée : elle renseignerait sur la topologie interne. */
  raison?: string;
}

/**
 * L'hôte de cette URL résout-il UNIQUEMENT vers des adresses publiques ?
 *
 * 🔴 UNIQUEMENT, et pas « au moins une » : un nom qui rend une adresse publique ET une adresse privée
 * laisserait le choix à la pile réseau, donc au hasard. Une seule adresse interdite condamne le nom.
 *
 * Une résolution qui ÉCHOUE est un refus, pas un laissez-passer. C'est le sens de la garde : on n'autorise
 * que ce qu'on a pu vérifier. Le coût est nul en pratique, un nom qui ne résout pas n'aurait rien donné.
 */
export async function resolutionPublique(url: string, resoudre: Resolveur = resolveurParDefaut): Promise<VerdictResolution> {
  let hote: string;
  try {
    hote = new URL(url).hostname.replace(/^\[|\]$/g, '');
  } catch {
    return { ok: false, raison: 'adresse illisible' };
  }
  // Un littéral d'adresse ne se résout pas, il se lit. `urlRecuperable` les refuse déjà tous, mais cette
  // fonction doit rester juste TOUTE SEULE : elle est appelée depuis plusieurs chemins, et une garde qui
  // dépend d'une autre garde ailleurs finit par être appelée sans elle.
  if (/^[\d.]+$/.test(hote) || hote.includes(':')) {
    return estAdressePrivee(hote) ? { ok: false, raison: 'adresse interne' } : { ok: true };
  }

  let adresses: string[];
  try {
    adresses = await resoudre(hote);
  } catch {
    return { ok: false, raison: 'nom introuvable' };
  }
  if (adresses.length === 0) return { ok: false, raison: 'nom introuvable' };
  if (adresses.some(estAdressePrivee)) return { ok: false, raison: 'ce nom pointe vers une adresse interne' };
  return { ok: true };
}
