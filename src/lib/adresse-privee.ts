import { lookup as lookupDns } from 'node:dns/promises';

/**
 * La résolution DNS d'une cible.
 *
 * 🔴 `urlRecuperable` lit le texte de l'hôte : elle ne peut rien contre `crm.exemple.fr`, nom public dont
 * l'enregistrement A peut pointer sur `169.254.169.254` (métadonnées du fournisseur) ou sur `172.18.x.x` (le
 * réseau Docker du VPS). Il faut résoudre.
 *
 * Cette vérification a lieu avant l'appel ; le « DNS rebinding » (public puis privé) est fermé par
 * `fetchPublic` (`connexion-publique.ts`), qui revérifie à l'ouverture de la socket avec `estAdressePrivee`.
 * Les deux restent : celle-ci donne un refus lisible, l'autre ne remonte que comme une panne réseau.
 *
 * Logique pure (`estAdressePrivee`), réseau injectable : tout se teste sans DNS.
 */

/**
 * Cette adresse IP appartient-elle à un espace qu'un connecteur ne doit jamais atteindre ? Les deux familles :
 * une machine à double pile résout souvent les deux, en laisser passer une suffit à rendre la garde inutile.
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
      || (o1 === 169 && o2 === 254)            // lien-local et métadonnées cloud
      || (o1 === 172 && o2 >= 16 && o2 <= 31)  // privé, et c'est là que vit le réseau Docker du VPS
      || (o1 === 192 && o2 === 168)            // privé
      || (o1 === 198 && (o2 === 18 || o2 === 19)) // bancs de mesure
      || o1 >= 224        // multicast et réservé
    );
  }

  // IPv6 : on développe l'adresse et on compare des nombres, jamais des préfixes de texte. 🔴 `fe80::/10` fait
  // dix bits (de `fe80::` à `febf::`), et une IPv4 mappée s'écrit aussi en hexadécimal (`::ffff:ac12:1` est
  // `172.18.0.1`, la passerelle Docker du VPS) : un test de préfixe de chaîne les laisse passer.
  const groupes = developperIPv6(cible);
  if (groupes === null) return true; // illisible = on ne s'y connecte pas

  // IPv4 mappée (::ffff:0:0/96) ou compatible (::/96, dépréciée) : les 32 derniers bits sont une IPv4, quelle
  // que soit leur écriture. On la reconstitue et on applique les règles v4.
  const prefixeNul = groupes.slice(0, 5).every((g) => g === 0);
  if (prefixeNul && (groupes[5] === 0xffff || groupes[5] === 0)) {
    const v4 = `${groupes[6]! >> 8}.${groupes[6]! & 0xff}.${groupes[7]! >> 8}.${groupes[7]! & 0xff}`;
    // `::` et `::1` retombent naturellement sur 0.0.0.0 et 0.0.0.1, tous deux dans l'espace `0.0.0.0/8`.
    return estAdressePrivee(v4);
  }

  const t = groupes[0]!;
  if (t >= 0xfe80 && t <= 0xfebf) return true; // lien-local, fe80::/10
  if (t >= 0xfc00 && t <= 0xfdff) return true; // unique-local, fc00::/7
  if (t >= 0xff00) return true;                // multicast, ff00::/8
  if (t === 0x0064 && groupes[1] === 0xff9b) return true; // NAT64, 64:ff9b::/96
  if (t === 0x2001 && (groupes[1]! & 0xfffe) === 0x0000) return true; // Teredo/documentation 2001::/23
  if (t === 0x2001 && groupes[1] === 0x0db8) return true; // documentation, 2001:db8::/32
  return false;
}

/**
 * Développe une adresse IPv6 en ses huit groupes de 16 bits, `null` si elle n'est pas lisible. Gère la
 * compression `::` (au plus une fois) et la queue en décimal pointé (`::ffff:1.2.3.4`).
 */
function developperIPv6(brut: string): number[] | null {
  let s = brut;
  // Queue en décimal pointé : on la convertit en deux groupes hexadécimaux avant tout le reste.
  const queue = /^(.*:)(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (queue) {
    const o = [queue[2], queue[3], queue[4], queue[5]].map(Number);
    if (o.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
    s = `${queue[1]}${((o[0]! << 8) | o[1]!).toString(16)}:${((o[2]! << 8) | o[3]!).toString(16)}`;
  }

  const morceaux = s.split('::');
  if (morceaux.length > 2) return null; // `::` ne peut apparaître qu'une fois
  const lire = (bout: string): number[] | null => {
    if (bout === '') return [];
    const gs = bout.split(':');
    const out: number[] = [];
    for (const g of gs) {
      if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
      out.push(parseInt(g, 16));
    }
    return out;
  };
  const gauche = lire(morceaux[0]!);
  const droite = morceaux.length === 2 ? lire(morceaux[1]!) : [];
  if (gauche === null || droite === null) return null;

  if (morceaux.length === 1) return gauche.length === 8 ? gauche : null;
  const manquants = 8 - gauche.length - droite.length;
  if (manquants < 1) return null; // `::` doit remplacer au moins un groupe
  return [...gauche, ...Array<number>(manquants).fill(0), ...droite];
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
 * Plafond de la résolution elle-même : `dns.lookup` passe par le résolveur du système, dont le délai dépend de
 * `resolv.conf` et qui n'accepte aucun signal d'abandon. Sans lui, un DNS muet immobilise la requête avant
 * même que le plafond de l'appel HTTP commence à courir.
 */
const DELAI_RESOLUTION_MS = 3_000;

/**
 * L'hôte de cette URL résout-il uniquement vers des adresses publiques ?
 *
 * 🔴 Uniquement, pas « au moins une » : un nom qui rend une adresse publique et une privée laisserait le choix
 * à la pile réseau. Une seule adresse interdite condamne le nom, et une résolution qui échoue est un refus.
 */
export async function resolutionPublique(url: string, resoudre: Resolveur = resolveurParDefaut): Promise<VerdictResolution> {
  let hote: string;
  try {
    hote = new URL(url).hostname.replace(/^\[|\]$/g, '');
  } catch {
    return { ok: false, raison: 'adresse illisible' };
  }
  // Un littéral se lit, il ne se résout pas. `urlRecuperable` les refuse déjà, mais cette fonction doit rester
  // juste seule : une garde qui dépend d'une autre garde finit par être appelée sans elle.
  if (/^[\d.]+$/.test(hote) || hote.includes(':')) {
    return estAdressePrivee(hote) ? { ok: false, raison: 'adresse interne' } : { ok: true };
  }

  let adresses: string[];
  try {
    // Plafond posé ici plutôt que chez les appelants, pour la même raison. Une résolution trop lente est un refus.
    // Le minuteur est `unref` : une garde ne retient pas le process.
    adresses = await new Promise<string[]>((tenir, rejeter) => {
      const t = setTimeout(() => rejeter(new Error('resolution trop lente')), DELAI_RESOLUTION_MS);
      if (typeof t.unref === 'function') t.unref();
      resoudre(hote).then(tenir, rejeter).finally(() => { clearTimeout(t); });
    });
  } catch {
    return { ok: false, raison: 'nom introuvable' };
  }
  if (adresses.length === 0) return { ok: false, raison: 'nom introuvable' };
  if (adresses.some(estAdressePrivee)) return { ok: false, raison: 'ce nom pointe vers une adresse interne' };
  return { ok: true };
}
