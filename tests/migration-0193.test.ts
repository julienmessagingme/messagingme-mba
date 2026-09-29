import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { NUMERO_AFFICHE_SQL, NUMERO_AFFICHE_VALIDE_SQL } from '../src/agent/credits.pg';

/**
 * 0193 : le crédit offert ne se donne jamais deux fois au même numéro AFFICHÉ (relecture du 2026-09-29). Un numéro
 * retiré d'un compte WhatsApp puis rajouté à un autre change d'identifiant Meta : la borne de 0191, posée sur
 * l'identifiant, le laissait repartir avec 5 € sur un espace neuf.
 *
 * 🔴 LA MÊME NORMALISATION DES DEUX CÔTÉS. La reprise de la migration et l'offre du code calculent le numéro affiché
 * avec la même expression SQL : si elles divergeaient, une ligne reprise (« +33 6 12... » normalisé d'une façon) et
 * une offre neuve (normalisée d'une autre) ne se heurteraient jamais sur l'index unique, et la borne ne tiendrait
 * qu'en apparence. Leur effet en base : `tests/integration/agent-credits.integration.test.ts`, en CI.
 *
 * Et la session Stripe d'un achat sur son mouvement (le lien « Facture » de la page Crédit IA), reprise par la note
 * pour l'achat déjà crédité en production.
 */
const sql = readFileSync(new URL('../db/migrations/0193_credit_offert_et_factures.sql', import.meta.url), 'utf8');
const code = sql.split(/\r?\n/).filter((l) => !l.trim().startsWith('--')).join('\n').replace(/\s+/g, ' ').trim();
const credits = readFileSync(new URL('../src/agent/credits.pg.ts', import.meta.url), 'utf8');

describe('migration 0193', () => {
  it('🔴 une colonne nullable SANS défaut, et un index UNIQUE sur elle (plusieurs nuls restent possibles)', () => {
    expect(code).toContain('alter table credits_offerts add column if not exists numero_affiche text;');
    expect(code).toContain('create unique index if not exists credits_offerts_numero_affiche_uidx on credits_offerts (numero_affiche);');
  });

  it('🔴 la reprise et l’offre normalisent le numéro affiché avec la MÊME expression', () => {
    expect(code).toContain(NUMERO_AFFICHE_SQL);
    expect(code).toContain(NUMERO_AFFICHE_VALIDE_SQL.replace(/\s+/g, ' '));
    // Le code, lui, écrit la colonne avec ces deux mêmes fragments.
    expect(credits).toContain('${NUMERO_AFFICHE_SQL}');
    expect(credits).toContain('${NUMERO_AFFICHE_VALIDE_SQL}');
  });

  it('🔴 la reprise ne donne un numéro qu’à UNE ligne par numéro : un doublon ne fait pas échouer l’index', () => {
    expect(code).toMatch(/select distinct on \(numero\) o\.tenant_id, numero [^;]*order by numero, o\.offert_le, o\.tenant_id/);
    expect(code).toContain('and co.numero_affiche is null;');
  });

  it('🔴 la session Stripe d’un achat : une colonne nullable sur le journal, sans clé étrangère ni défaut', () => {
    expect(code).toContain('alter table agent_credit_mouvements add column if not exists stripe_session_id text;');
    expect(code).not.toMatch(/stripe_session_id text [^;]*references/);
  });

  it('🔴 la reprise des achats passe par la note EXACTE écrite par le webhook, dans le même espace', () => {
    // Si le texte du webhook changeait, la reprise ne rattacherait plus rien : le fragment est comparé au code.
    const store = readFileSync(new URL('../src/stripe/store.pg.ts', import.meta.url), 'utf8');
    expect(store).toContain('`achat Stripe ${p.offre} (${p.sessionId})`');
    expect(code).toContain(
      "update agent_credit_mouvements m set stripe_session_id = p.session_id from stripe_paiements p where m.raison = 'achat' "
      + "and m.stripe_session_id is null and m.tenant_id = p.tenant_id and m.note = 'achat Stripe ' || p.offre || ' (' || p.session_id || ')';",
    );
  });

  it('additive : aucune suppression, et chaque reprise n’écrit que sa colonne neuve', () => {
    expect(code).not.toMatch(/\b(drop |delete from|truncate)/i);
    expect(code.match(/\bupdate \w+/gi)).toEqual(['update credits_offerts', 'update agent_credit_mouvements']);
    expect(code).toMatch(/update credits_offerts co set numero_affiche = premiers\.numero from/);
    expect(code).toMatch(/update agent_credit_mouvements m set stripe_session_id = p\.session_id from/);
  });

  it('⚠️ transactionnelle et sans accent grave dans le SQL', () => {
    expect(sql).not.toMatch(/--\s*migrate:\s*no-transaction/);
    expect(sql).not.toContain('`');
  });
});
