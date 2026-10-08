import { describe, it, expect } from 'vitest';
import type { Pool } from 'pg';
import { construireSocle, type ConfigSocle } from '../src/socle';
import { FILE_POUSSEE_OPTOUT } from '../src/crm/poussee-optout';
import { FILE_SIGNAUX_BATCH } from '../src/signaux/batch';
import { SOURCE_STOP_WHATSAPP } from '../src/crm/consentement';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * LE SOCLE COMMUN DE L'API ET DU WORKER, EXÉCUTÉ (`src/socle.ts`).
 *
 * 🔴 « Un opt-out écrit par n'importe quel processus est annoncé » : l'annonce au connecteur du client et le
 * signal vivent sur le dépôt des contacts, et ce dépôt est construit par le socle pour les deux processus. Ce test
 * le construit tel que les deux racines le font, écrit un STOP par ce dépôt et regarde ce qui part dans la file.
 * Il remplace deux expressions régulières qui cherchaient la même construction dans le texte de chaque racine :
 * elles prouvaient qu'un motif était écrit, pas qu'un refus partait.
 */
const TENANT = '11111111-1111-4111-8111-111111111111';
const WA_ID = '33612345678';

const configuration: ConfigSocle = {
  DRY_RUN: 'true',
  PGBOSS_SCHEMA: 'pgboss',
  ENCRYPTION_KEY: 'x'.repeat(64),
  META_ACCESS_TOKEN: '',
  META_APP_ID: '',
  META_APP_SECRET: '',
  META_GRAPH_VERSION: 'v21.0',
  META_MM_LITE: 'false',
  PHONE_RATE_PER_MINUTE_MAX: 80,
  RCS_PROVIDER: 'fake',
  CREDIT_OFFERT_MICRO_EUR: 0,
  CONTROL_HUMAN_TIMEOUT_MS: 2 * 60 * 60 * 1000,
  // Sans modèle ni Resend : le démarreur du répondeur rend `indisponible` sans lire la base, l'alerte se journalise.
  AI_GATEWAY_API_KEY: '',
  RESEND_API_KEY: '',
  SUPPORT_FROM: 'test@exemple.test',
  APP_URL: 'https://console.exemple.test',
};

/** Un faux pool qui répond aux deux lectures du chemin (la fiche avant l'écriture, les espaces branchés), et une file qui garde ce qu'on lui confie. */
function banc() {
  const requetes: string[] = [];
  const pool = {
    query: async (sql: string) => {
      requetes.push(sql);
      // L'espace a branché un outil : sans ça, l'émetteur n'enfile rien, et le test ne verrait pas le signal.
      if (sql.includes('from integration_batch')) return { rows: [{ tenant_id: TENANT }] };
      // La fiche était abonnée : l'écriture la fait passer à `opted_out` (`passe`), donc l'annonce est due. Reconnue
      // à ce qu'elle fait (elle écrit `contacts`) et à la colonne qu'on lui répond (`passe`), pas à l'ordre de ses
      // affectations, que rien ne fixe.
      if (/\bupdate contacts set\b/.test(sql) && /\bas passe\b/.test(sql)) return { rows: [{ id: 'fiche-1', passe: true }] };
      return { rows: [] };
    },
  } as unknown as Pool;
  const enfiles: Array<{ file: string; job: unknown }> = [];
  const queue = {
    enqueue: async (file: string, job: unknown): Promise<void> => { enfiles.push({ file, job }); },
  };
  return { requetes, enfiles, socle: construireSocle({ pool, queue, config: configuration }) };
}

describe('le socle commun aux deux processus', () => {
  it('🔴 un STOP écrit par le dépôt de contacts du socle part vers le connecteur ET vers les signaux', async () => {
    const { socle, enfiles } = banc();

    await socle.contactStore.setOptInByWaId(TENANT, WA_ID, 'opted_out', 'personne', SOURCE_STOP_WHATSAPP, 'wamid.STOP');

    const annonces = enfiles.filter((e) => e.file === FILE_POUSSEE_OPTOUT);
    expect(annonces, 'aucune annonce d’opt-out : le connecteur du client ne serait jamais prévenu').toHaveLength(1);
    expect(annonces[0]!.job).toEqual({ tenantId: TENANT, waIds: [WA_ID] });

    const signaux = enfiles.filter((e) => e.file === FILE_SIGNAUX_BATCH);
    expect(signaux, 'aucun signal de désabonnement : l’outil du client ne l’apprendrait pas').toHaveLength(1);
    expect(signaux[0]!.job).toMatchObject({ tenantId: TENANT, signaux: [{ nom: 'em_opted_out', waId: WA_ID, canal: 'whatsapp' }] });
  });

  it('la construction ne touche ni la base ni la file : l’ordre d’appel dans une racine ne change rien', () => {
    const { requetes, enfiles } = banc();
    expect(requetes).toEqual([]);
    expect(enfiles).toEqual([]);
  });

  /**
   * 🔴 LA LIAISON TARDIVE DU RÉPONDEUR (lot 5). Le fil se construit avant l'exécuteur, le démarreur du répondeur a
   * besoin des lancements de l'exécuteur : le socle branche le démarreur APRÈS, et le fil lève tant qu'il ne l'est
   * pas. Ce cas fait passer un message d'un espace à répondeur IA par le fil du VRAI socle : il doit atteindre le
   * démarreur (sans modèle configuré ici, il rend `indisponible` et la conversation passe à l'équipe), pas lever
   * « non branché ».
   */
  it('🔴 le socle BRANCHE le démarreur du répondeur : un message d’un espace à répondeur IA l’atteint', async () => {
    const requetes: string[] = [];
    const pool = {
      query: async (sql: string) => {
        requetes.push(sql);
        if (/from tenant_settings where tenant_id = \$1/.test(sql)) {
          return { rows: [{ mba_enabled: false, repondeur_agent_id: '22222222-2222-4222-8222-222222222222', control_handback_seconds: null }] };
        }
        if (/from phone_numbers where tenant_id = \$1/.test(sql)) return { rows: [{ id: 'pn1' }] };
        return { rows: [] };
      },
    } as unknown as Pool;
    const socle = construireSocle({ pool, queue: { enqueue: async () => {} }, config: configuration });
    await expect(socle.fil.remettreSiPersonneNeSuit(TENANT, WA_ID, 'Bonjour', { rouverte: false })).resolves.toBeUndefined();
    // Le démarreur a répondu (`indisponible`) : la conversation passe à l'équipe, avec la cause qui le dit.
    const bascule = requetes.find((q) => /update conversations/.test(q) && /'app_human'|\$3/.test(q));
    expect(bascule, 'la conversation passe à l’équipe').toBeDefined();
  });

  it('🔴 RC6 : le socle BRANCHE aussi le démarreur du scénario répondeur : un message d’un espace en mode « Scénario » l’atteint', async () => {
    const requetes: string[] = [];
    const pool = {
      query: async (sql: string) => {
        requetes.push(sql);
        if (/from tenant_settings where tenant_id = \$1/.test(sql)) {
          return { rows: [{ mba_enabled: false, repondeur_mode: 'scenario', repondeur_workflow_id: '33333333-3333-4333-8333-333333333333', repondeur_delai_scenario_s: 86400, control_handback_seconds: null }] };
        }
        if (/from phone_numbers where tenant_id = \$1/.test(sql)) return { rows: [{ id: 'pn1' }] };
        // L'espace est en Entreprise : en Base, le scénario répondeur est gelé (lot 6, B2a), et rien ne le lirait.
        if (/offre_de_l_espace\(\$1::uuid\) as offre/.test(sql)) return { rows: [{ offre: 'entreprise', entreprise_utilisateurs: null, conservation: null, dernier_fini: null }] };
        return { rows: [] };
      },
    } as unknown as Pool;
    const socle = construireSocle({ pool, queue: { enqueue: async () => {} }, config: configuration });
    await expect(socle.fil.remettreSiPersonneNeSuit(TENANT, WA_ID, 'Bonjour', { rouverte: false })).resolves.toBeUndefined();
    // Le démarreur a lu le scénario (introuvable ici : `indisponible`), donc il était branché ; l'équipe prend la suite.
    expect(requetes.some((q) => /from workflows where id = \$1/.test(q)), 'le scénario a été lu').toBe(true);
    expect(requetes.some((q) => /update conversations/.test(q)), 'la conversation passe à l’équipe').toBe(true);
  });
});

/** Les fichiers de `src/`, sans leurs commentaires : une explication qui cite le code ne compte pas. */
function sources(): Array<{ fichier: string; texte: string }> {
  const racine = fileURLToPath(new URL('../src', import.meta.url));
  const out: Array<{ fichier: string; texte: string }> = [];
  const visiter = (dossier: string): void => {
    for (const nom of readdirSync(dossier)) {
      const complet = join(dossier, nom);
      if (statSync(complet).isDirectory()) { visiter(complet); continue; }
      if (!nom.endsWith('.ts')) continue;
      const texte = readFileSync(complet, 'utf8').replace(/^\s*\/\*[\s\S]*?\*\//gm, '').replace(/^\s*\/\/.*$/gm, '');
      out.push({ fichier: `src/${relative(racine, complet).split('\\').join('/')}`, texte });
    }
  };
  visiter(racine);
  return out;
}

describe('le socle est le seul à construire ce qu il garantit', () => {
  it('🔴 aucun dépôt de contacts n est construit hors du socle : il échapperait à l annonce d opt-out', () => {
    const sites = sources().flatMap(({ fichier, texte }) => [...texte.matchAll(/new PgContactStore\(/g)].map(() => fichier));
    expect(sites).toEqual(['src/socle.ts']);
  });

  it('🔴 chaque racine n a qu UN site d appel au socle : deux appels doubleraient ses caches et leurs invalidations', () => {
    const sites = sources().flatMap(({ fichier, texte }) => [...texte.matchAll(/(?<!function )\bconstruireSocle\(/g)].map(() => fichier));
    expect(sites.sort()).toEqual(['src/index.ts', 'src/worker.ts']);
  });
});
