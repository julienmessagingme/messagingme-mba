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

  // IPv6 : on DÉVELOPPE l'adresse et on compare des NOMBRES, jamais des préfixes de texte.
  //
  // 🔴 Les tests de préfixe étaient faux, et le contre-audit du 2026-09-03 l'a démontré. `fe80::/10` ne
  // couvre pas seulement ce qui commence par « fe80 » : le préfixe fait DIX bits, donc il va de `fe80::` à
  // `febf::`. `fe90::1`, `fea0::1` et `feb0::1` sont link-local et passaient. Pire, une IPv4 mappée s'écrit
  // aussi en HEXADÉCIMAL : `::ffff:ac12:1` est exactement `172.18.0.1`, la passerelle du réseau Docker du
  // VPS, et il passait. Mesuré : cinq cas sur huit ratés, dont l'adresse même que cette garde existe pour
  // bloquer.
  //
  // La leçon, et elle vaut pour toute frontière de sécurité : **une plage d'adresses se compare en
  // arithmétique, jamais en préfixe de chaîne.** Un préfixe de texte décrit ce qu'on a en tête, pas ce que
  // la norme définit, et l'écart ne se voit sur aucun exemple qu'on pense à écrire.
  const groupes = developperIPv6(cible);
  if (groupes === null) return true; // illisible = on ne s'y connecte pas

  // IPv4 mappée (::ffff:0:0/96) ou compatible (::/96, dépréciée) : les 32 derniers bits SONT une IPv4, quelle
  // que soit la façon dont on les a écrits. On la reconstitue et on applique les règles v4.
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
 * Développe une adresse IPv6 en ses HUIT groupes de 16 bits. `null` si elle n'est pas lisible.
 *
 * Écrit à la main plutôt qu'importé : le dépôt n'ajoute pas une dépendance pour trente lignes, et cette
 * fonction n'a qu'un seul appelant. Elle gère les deux formes que la norme autorise et qu'on rencontre : la
 * compression `::` (au plus une fois) et la queue en notation décimale pointée (`::ffff:1.2.3.4`).
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
  if (manquants < 1) return null; // `::` doit remplacer AU MOINS un groupe
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
 * Plafond de la résolution elle-même.
 *
 * 🔴 **Une résolution DNS n'est bornée par rien de ce que nous écrivons** : `dns.lookup` passe par le
 * résolveur du système, dont le délai dépend de `resolv.conf` et qui n'accepte aucun signal d'abandon. Un nom
 * dont le serveur faisant autorité ne répond pas immobilise donc la requête AVANT même que le plafond de
 * l'appel HTTP ait commencé à courir : les deux budgets s'ADDITIONNAIENT au lieu de se recouvrir. Signalé par
 * le contre-contre-rapport du 2026-09-03.
 *
 * Trois secondes suffisent très largement à un DNS qui marche, et un DNS qui n'a pas répondu en trois
 * secondes n'aurait de toute façon rien donné d'exploitable.
 */
const DELAI_RESOLUTION_MS = 3_000;

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
    // ⚠️ Le plafond est posé ICI plutôt que chez les appelants, pour la même raison que le reste de cette
    // fonction : elle est appelée depuis plusieurs chemins, et une garde qui dépend d'un appelant finit par
    // être appelée sans elle. Une résolution trop lente est traitée comme une résolution qui ÉCHOUE, donc par
    // un REFUS : on n'autorise que ce qu'on a pu vérifier.
    //
    // Le minuteur est `unref` : c'est une garde, elle ne doit pas retenir le process.
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
