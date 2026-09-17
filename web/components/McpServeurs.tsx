'use client';

import { useCallback, useEffect, useState } from 'react';
import { useT } from '@/lib/i18n';
import { cardCls } from '@/lib/ui';
import { McpOutilReglage } from '@/components/McpOutilReglage';
import {
  apercuMcp, eprouverServeurMcp, importerMcp, listerOutilsMcp, listerServeursMcp,
  type ChangementMcp, type OutilMcp, type ServeurMcp,
} from '@/lib/api-mcp-connecteurs';

/**
 * Les serveurs MCP de l'espace, et ce qu'on a importé de chacun.
 *
 * 🔴 L'APERÇU AVANT L'IMPORT, ET IL N'ÉCRIT RIEN. Un rafraîchissement peut faire TOMBER des consentements
 * et marquer des outils indisponibles : écraser n'est acceptable que si l'on montre quoi avant de le faire.
 * C'est le même dispositif que la publication chez Meta, pour la même raison.
 *
 * 🔴 CES OUTILS NE VONT PAS À L'AGENT DE META, et l'écran le DIT au lieu de griser une case sans raison.
 * Meta n'accepte pas encore de connexion MCP.
 */
export function McpServeurs({ tenantId, isAdmin }: { tenantId: string; isAdmin: boolean }) {
  const t = useT();
  const [serveurs, setServeurs] = useState<ServeurMcp[] | null>(null);
  const [ouvert, setOuvert] = useState<string | null>(null);
  const [outils, setOutils] = useState<Record<string, OutilMcp[]>>({});
  const [plan, setPlan] = useState<{ sourceId: string; plan: ChangementMcp[]; tronque: boolean } | null>(null);
  const [epreuve, setEpreuve] = useState<{ sourceId: string; ok: boolean; erreur?: string } | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let vivant = true;
    listerServeursMcp(tenantId)
      .then((r) => { if (vivant) setServeurs(r.serveurs); })
      .catch(() => { if (vivant) setServeurs([]); });
    return () => { vivant = false; };
  }, [tenantId]);

  const chargerOutils = useCallback(async (sourceId: string) => {
    try {
      const r = await listerOutilsMcp(tenantId, sourceId);
      setOutils((v) => ({ ...v, [sourceId]: r.outils }));
    } catch { setOutils((v) => ({ ...v, [sourceId]: [] })); }
  }, [tenantId]);

  async function agir(travail: () => Promise<void>): Promise<void> {
    if (busy) return;
    setBusy(true);
    setErreur(null);
    try { await travail(); } catch (e) {
      // Le message du SERVEUR, pas un message maison : il dit précisément ce qui bloque (transport non pris
      // en charge, jeton refusé, serveur injoignable), et le remplacer renverrait le client chercher
      // lui-même ce que le serveur savait déjà.
      setErreur(e instanceof Error ? e.message : t('L’opération a échoué.', 'The operation failed.'));
    } finally { setBusy(false); }
  }

  const LIBELLE: Record<ChangementMcp['type'], string> = {
    nouveau: t('nouvel outil', 'new tool'),
    inchange: t('inchangé', 'unchanged'),
    schema_change: t('schéma changé, autorisation à redonner', 'schema changed, needs re-authorising'),
    disparu: t('DISPARU du serveur', 'GONE from the server'),
  };

  if (serveurs === null) return null;

  return (
    <section className="space-y-4" data-testid="mcp-serveurs">
      <header>
        <h1 className="text-lg font-semibold text-ink-900">{t('Connecteurs MCP', 'MCP connectors')}</h1>
        <p className="mt-1 text-sm text-ink-600">
          {t('Les serveurs MCP que vos agents IA peuvent interroger. Déclarés une fois ici, leur catalogue d’outils est importé puis proposé à chaque agent dans son onglet Outils.',
            'The MCP servers your AI agents can query. Declared once here, their tool catalogue is imported and then offered to each agent in its Tools tab.')}
        </p>
        {/* ⚠️ ON LE DIT, ON NE GRISE PAS. Meta n'accepte pas MCP : une case désactivée sans explication
            enverrait le client ouvrir un ticket pour une limite qui n'est pas la nôtre. */}
        <p className="mt-2 text-xs text-ink-500" data-testid="mcp-note-mba">
          {t('Ces outils servent vos agents IA. L’agent de Meta ne peut pas les recevoir : Meta n’accepte pas encore de connexion MCP.',
            'These tools serve your AI agents. Meta’s agent cannot receive them: Meta does not accept MCP connections yet.')}
        </p>
      </header>

      {erreur && <p className="text-xs text-coral" data-testid="mcp-erreur">{erreur}</p>}

      {serveurs.length === 0 ? (
        <p className="text-sm text-ink-500" data-testid="mcp-vide">
          {t('Aucun serveur MCP déclaré. Ajoutez-en un depuis Tools > Connecteurs API, en choisissant le type MCP.',
            'No MCP server yet. Add one from Tools > API connectors, choosing the MCP type.')}
        </p>
      ) : (
        <ul className="space-y-3">
          {serveurs.map((s) => (
            <li key={s.id} className={cardCls} data-testid={`mcp-serveur-${s.id}`}>
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                <span className="font-medium text-ink-900">{s.label}</span>
                <code className="text-xs text-ink-500">{s.baseUrl}</code>
                {s.status !== 'active' && (
                  <span className="rounded-full bg-ink-100 px-2 py-0.5 text-[11px] text-ink-600">{s.status}</span>
                )}
              </div>

              {/* 🔴 CE QUI REND UN SERVEUR MORT VISIBLE AVANT QU'UN CONTACT NE LE DÉCOUVRE. Un jeton expiré
                  ne produit aucune erreur applicative : l'agent dégraderait en silence, en pleine
                  conversation. */}
              <p className="mt-1 text-xs text-ink-500" data-testid={`mcp-etat-${s.id}`}>
                {s.lastError
                  ? <span className="text-coral">{t('Dernière erreur : ', 'Last error: ')}{s.lastError}</span>
                  : s.lastOkAt
                    ? `${t('A répondu le ', 'Answered on ')}${new Date(s.lastOkAt).toLocaleString()}`
                    : t('Jamais éprouvé.', 'Never tested.')}
              </p>

              {isAdmin && (
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <button type="button" disabled={busy} data-testid={`mcp-eprouver-${s.id}`}
                    className="rounded-lg border border-ink-300 bg-white px-2 py-0.5 text-xs disabled:opacity-50"
                    onClick={() => void agir(async () => { setEpreuve({ sourceId: s.id, ...(await eprouverServeurMcp(tenantId, s.id)) }); })}>
                    {t('Éprouver la connexion', 'Test the connection')}
                  </button>
                  <button type="button" disabled={busy} data-testid={`mcp-apercu-${s.id}`}
                    className="rounded-lg border border-ink-300 bg-white px-2 py-0.5 text-xs disabled:opacity-50"
                    onClick={() => void agir(async () => { setPlan({ sourceId: s.id, ...(await apercuMcp(tenantId, s.id)) }); })}>
                    {t('Voir ce qui va changer', 'Preview changes')}
                  </button>
                  <button type="button" disabled={busy} data-testid={`mcp-outils-${s.id}`}
                    className="rounded-lg border border-ink-300 bg-white px-2 py-0.5 text-xs disabled:opacity-50"
                    onClick={() => void agir(async () => {
                      setOuvert(ouvert === s.id ? null : s.id);
                      if (ouvert !== s.id) await chargerOutils(s.id);
                    })}>
                    {t('Les outils importés', 'Imported tools')}
                  </button>
                </div>
              )}

              {epreuve?.sourceId === s.id && (
                <p className={`mt-2 text-xs ${epreuve.ok ? 'text-mint-700' : 'text-coral'}`} data-testid={`mcp-epreuve-${s.id}`}>
                  {epreuve.ok ? t('Le serveur répond.', 'The server answers.') : epreuve.erreur}
                </p>
              )}

              {plan?.sourceId === s.id && (
                <div className="mt-3 rounded-2xl border border-ink-200 bg-ink-50/50 p-3" data-testid={`mcp-plan-${s.id}`}>
                  {plan.tronque && (
                    /* 🔴 UN PLAFOND SILENCIEUX SE LIT COMME UNE COUVERTURE COMPLÈTE. Et il a une conséquence
                       que le client doit connaître : sur un catalogue tronqué, rien n'est retiré. */
                    <p className="mb-2 rounded-lg bg-gold/10 px-2 py-1 text-xs text-ink-700" data-testid={`mcp-tronque-${s.id}`}>
                      {t('Ce serveur annonce plus d’outils que nous n’en lisons d’un coup. Rien ne sera retiré tant que la liste est incomplète.',
                        'This server announces more tools than we read at once. Nothing will be removed while the list is incomplete.')}
                    </p>
                  )}
                  {plan.plan.length === 0 ? (
                    <p className="text-xs text-mint-700">{t('Rien à changer.', 'Nothing to change.')}</p>
                  ) : (
                    <ul className="space-y-0.5">
                      {plan.plan.map((c, i) => (
                        <li key={`${c.type}-${c.nom}-${i}`} className={`text-xs ${c.type === 'disparu' ? 'text-coral' : 'text-ink-600'}`}>
                          <code>{c.nom}</code> : {LIBELLE[c.type]}
                          {'consentementsTombes' in c && c.consentementsTombes > 0 && (
                            <span className="text-coral">
                              {t(` (${c.consentementsTombes} agent(s) perdront l’accès)`, ` (${c.consentementsTombes} agent(s) will lose access)`)}
                            </span>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                  {plan.plan.length > 0 && (
                    <button type="button" disabled={busy} data-testid={`mcp-importer-${s.id}`}
                      className="mt-2 rounded-lg bg-brand-600 px-2 py-0.5 text-xs font-medium text-white disabled:opacity-50"
                      onClick={() => void agir(async () => {
                        await importerMcp(tenantId, s.id);
                        setPlan(null);
                        setServeurs((await listerServeursMcp(tenantId)).serveurs);
                        if (ouvert === s.id) await chargerOutils(s.id);
                      })}>
                      {t(`Appliquer ces ${plan.plan.length} changement(s)`, `Apply these ${plan.plan.length} change(s)`)}
                    </button>
                  )}
                </div>
              )}

              {ouvert === s.id && (
                <ul className="mt-3 space-y-2" data-testid={`mcp-liste-outils-${s.id}`}>
                  {(outils[s.id] ?? []).length === 0
                    ? <li className="text-xs text-ink-500">{t('Aucun outil importé.', 'No imported tool.')}</li>
                    : (outils[s.id] ?? []).map((o) => (
                      <li key={o.id}>
                        <McpOutilReglage tenantId={tenantId} outil={o} onChange={() => void chargerOutils(s.id)} />
                      </li>
                    ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
