// tests/aide/fiches-memoire.ts
import type { ClesNormalisees, CreationFiche, EditionFicheApi, FicheApiLigne, FicheIdentite } from '../../src/crm/contact-store.pg';

/**
 * UN RÉPERTOIRE DE FICHES EN MÉMOIRE, AUX RÈGLES DE LA BASE.
 *
 * Il reproduit ce que le dépôt fait pour l'API publique : unicité PAR ESPACE du numéro et du BSUID (fiches
 * supprimées comprises, comme leurs index) et de l'identifiant externe (fiches ACTIVES seulement, comme son
 * index partiel de 0172 : une fiche supprimée ne le retient plus), `coalesce` au rattachement mais TOUT
 * OU RIEN (une clé portée autrement, et rien n'est écrit), résurrection d'une fiche supprimée par la CRÉATION
 * (numéro ou BSUID) quand ses autres clés tiennent, et par elle seule : aucune autre écriture ne touche une
 * fiche supprimée, consentement qui n'écrit que s'il change. Ce que la base
 * fait VRAIMENT de ces règles est vérifié à part (`tests/integration/contacts-identite.integration.test.ts`).
 *
 * ⚠️ `ecritures` journalise chaque écriture : c'est ce qui permet d'affirmer « rien n'a été écrit ».
 */
export interface FicheMemoire {
  id: string;
  tenantId: string;
  externalId: string | null;
  phoneE164: string | null;
  bsuid: string | null;
  profileName: string | null;
  fields: Record<string, string>;
  tags: string[];
  optInStatus: 'opted_in' | 'opted_out' | 'unknown';
  optInSource: string | null;
  optOutAt: string | null;
  supprimee: boolean;
}

let compteur = 0;
/** Un identifiant au FORMAT d'un vrai : `estUuid` refuse « c1 » avant même d'aller chercher. */
export function uuidDeTest(): string {
  compteur += 1;
  return `00000000-0000-4000-8000-${String(compteur).padStart(12, '0')}`;
}

type Cle = 'externalId' | 'phoneE164' | 'bsuid';

export class FichesMemoire {
  readonly fiches: FicheMemoire[] = [];
  readonly ecritures: string[] = [];
  appelsChercher = 0;

  ajouter(tenantId: string, f: Partial<Omit<FicheMemoire, 'tenantId'>> = {}): FicheMemoire {
    const fiche: FicheMemoire = {
      id: f.id ?? uuidDeTest(), tenantId, externalId: f.externalId ?? null, phoneE164: f.phoneE164 ?? null,
      bsuid: f.bsuid ?? null, profileName: f.profileName ?? null, fields: f.fields ?? {}, tags: f.tags ?? [],
      optInStatus: f.optInStatus ?? 'unknown', optInSource: f.optInSource ?? null, optOutAt: f.optOutAt ?? null,
      supprimee: f.supprimee ?? false,
    };
    this.fiches.push(fiche);
    return fiche;
  }

  private actives(tenantId: string): FicheMemoire[] {
    return this.fiches.filter((f) => f.tenantId === tenantId && !f.supprimee);
  }

  private prise(tenantId: string, sauf: string | null, cle: Cle, valeur: string): boolean {
    // L'index de l'identifiant externe ne compte que les fiches ACTIVES (0172) ; ceux du numéro et du BSUID,
    // toutes les fiches.
    return this.fiches.some((f) => f.tenantId === tenantId && f.id !== sauf && f[cle] === valeur && !(cle === 'externalId' && f.supprimee));
  }

  private identite(f: FicheMemoire): FicheIdentite {
    return { id: f.id, externalId: f.externalId, phoneE164: f.phoneE164, bsuid: f.bsuid };
  }

  async chercherParCles(tenantId: string, c: ClesNormalisees): Promise<FicheIdentite[]> {
    this.appelsChercher += 1;
    return this.actives(tenantId)
      // Sans tenir compte de la casse, comme `id = $2::uuid` : la base retrouve un identifiant en majuscules.
      .filter((f) => (c.contactId !== undefined && f.id.toLowerCase() === c.contactId.toLowerCase())
        || (c.externalId !== undefined && f.externalId === c.externalId)
        || (c.phoneE164 !== undefined && f.phoneE164 === c.phoneE164)
        || (c.bsuid !== undefined && f.bsuid === c.bsuid))
      .map((f) => this.identite(f));
  }

  async creerFicheApi(tenantId: string, c: { phoneE164?: string; bsuid?: string; externalId?: string }): Promise<CreationFiche> {
    const cle: Cle = c.phoneE164 !== undefined ? 'phoneE164' : 'bsuid';
    const valeur = c.phoneE164 ?? c.bsuid;
    if (valeur === undefined) throw new Error('creerFicheApi : un numéro ou un BSUID est requis');
    const existante = this.fiches.find((f) => f.tenantId === tenantId && f[cle] === valeur);
    if (existante) {
      // Comme le `where` du `do update` : une fiche qui porte une AUTRE clé n'est ni touchée ni ressuscitée.
      if (c.externalId !== undefined && existante.externalId !== null && existante.externalId !== c.externalId) return 'conflit';
      if (c.bsuid !== undefined && existante.bsuid !== null && existante.bsuid !== c.bsuid) return 'conflit';
      if (c.externalId !== undefined && existante.externalId === null && this.prise(tenantId, existante.id, 'externalId', c.externalId)) return 'conflit';
      if (c.bsuid !== undefined && existante.bsuid === null && this.prise(tenantId, existante.id, 'bsuid', c.bsuid)) return 'conflit';
      // La RÉSURRECTION remet la fiche dans l'index de l'identifiant externe : si une fiche active a repris le
      // sien entre-temps, la base viole l'unicité, et c'est un conflit.
      if (existante.supprimee && existante.externalId !== null && this.prise(tenantId, existante.id, 'externalId', existante.externalId)) return 'conflit';
      existante.externalId ??= c.externalId ?? null;
      existante.bsuid ??= c.bsuid ?? null;
      existante.supprimee = false;
      this.ecritures.push(`maj:${existante.id}`);
      return { ...this.identite(existante), created: false };
    }
    if (c.externalId !== undefined && this.prise(tenantId, null, 'externalId', c.externalId)) return 'conflit';
    if (c.bsuid !== undefined && this.prise(tenantId, null, 'bsuid', c.bsuid)) return 'conflit';
    const f = this.ajouter(tenantId, { phoneE164: c.phoneE164 ?? null, bsuid: c.bsuid ?? null, externalId: c.externalId ?? null });
    this.ecritures.push(`creation:${f.id}`);
    return { ...this.identite(f), created: true };
  }

  async rattacherCles(tenantId: string, contactId: string, c: { externalId?: string; phoneE164?: string; bsuid?: string }): Promise<'ok' | 'conflit' | 'absente'> {
    const f = this.actives(tenantId).find((x) => x.id === contactId);
    if (!f) return 'absente';
    // Tout ou rien, comme le `where` de la base : une clé portée AUTREMENT, ou prise par une autre fiche, et
    // la fiche n'est pas touchée du tout.
    for (const cle of ['externalId', 'phoneE164', 'bsuid'] as const) {
      const v = c[cle];
      if (v === undefined) continue;
      if (f[cle] !== null && f[cle] !== v) return 'conflit';
      if (f[cle] === null && this.prise(tenantId, f.id, cle, v)) return 'conflit';
    }
    f.externalId ??= c.externalId ?? null;
    f.phoneE164 ??= c.phoneE164 ?? null;
    f.bsuid ??= c.bsuid ?? null;
    this.ecritures.push(`rattachement:${f.id}`);
    return 'ok';
  }

  /** Comme la base : une fiche supprimée (ou purgée) n'est PAS éditée, `false`. */
  async editerFicheApi(tenantId: string, contactId: string, e: EditionFicheApi): Promise<boolean> {
    const f = this.actives(tenantId).find((x) => x.id === contactId);
    if (!f) return false;
    Object.assign(f.fields, e.fields);
    for (const k of e.removeFields) delete f.fields[k];
    if (e.profileName !== undefined) f.profileName = e.profileName;
    f.tags = [...new Set([...f.tags, ...e.addTags])].filter((t) => !e.removeTags.includes(t));
    this.ecritures.push(`edition:${f.id}`);
    return true;
  }

  async poserExternalId(tenantId: string, contactId: string, externalId: string): Promise<'ok' | 'conflit' | 'absente'> {
    const f = this.actives(tenantId).find((x) => x.id === contactId);
    if (!f) return 'absente';
    if (this.prise(tenantId, f.id, 'externalId', externalId)) return 'conflit';
    f.externalId = externalId;
    this.ecritures.push(`externalId:${f.id}`);
    return 'ok';
  }

  async lireFicheApi(tenantId: string, contactId: string): Promise<FicheApiLigne | null> {
    const f = this.actives(tenantId).find((x) => x.id === contactId);
    if (!f) return null;
    return {
      id: f.id, externalId: f.externalId, phoneE164: f.phoneE164, bsuid: f.bsuid, profileName: f.profileName,
      fields: { ...f.fields }, tags: [...f.tags], optInStatus: f.optInStatus, optInSource: f.optInSource,
      optOutAt: f.optOutAt, rcsOptoutAt: null, blockedAt: null, whatsappJoignable: null, whatsappJoignableLe: null,
      createdAt: '2026-09-01T00:00:00.000Z',
    };
  }

  async ecrireConsentementParId(tenantId: string, contactId: string, statut: 'opted_in' | 'opted_out', source: string): Promise<'change' | 'inchange' | 'refuse' | 'absente'> {
    const f = this.actives(tenantId).find((x) => x.id === contactId);
    if (!f) return 'absente';
    if (f.optInStatus === statut) return 'inchange';
    // La règle de la base : un STOP ne se lève pas par machine.
    if (statut === 'opted_in' && f.optInStatus === 'opted_out') return 'refuse';
    f.optInStatus = statut;
    f.optInSource = source;
    f.optOutAt = statut === 'opted_out' ? new Date().toISOString() : null;
    this.ecritures.push(`consentement:${f.id}:${statut}`);
    return 'change';
  }
}
