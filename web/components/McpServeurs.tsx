'use client';

import { useCallback, useEffect, useState } from 'react';
import { useT } from '@/lib/i18n';
import { cardCls, inputCls } from '@/lib/ui';
import { McpOutilReglage } from '@/components/McpOutilReglage';
import {
  apercuMcp, creerServeurMcp, eprouverServeurMcp, importerMcp, listerOutilsMcp, listerServeursMcp,
  supprimerServeurMcp,
  type AuthMcp, type ChangementMcp, type OutilMcp, type ServeurMcp,
} from '@/lib/api-mcp-connecteurs';
import { Bouton } from '@/components/Bouton';
import { IntroPage, TitrePage } from '@/components/TitrePage';

/**
 * Les serveurs MCP de l'espace, et ce qu'on a importé de chacun.
 *
 * 🔴 L'APERÇU AVANT L'IMPORT, ET IL N'ÉCRIT RIEN. Un rafraîchissement peut faire TOMBER des consentements
 * et marquer des outils indisponibles : écraser n'est acceptable que si l'on montre quoi avant de le faire.
 * C'est le même dispositif que la publication chez Meta, pour la même raison.
 *
 * 🔴 CES OUTILS NE VONT PAS ENCORE À L'AGENT DE META, et l'écran le DIT au lieu de griser une case sans
 * raison. ⚠️ MAIS LA RAISON A CHANGÉ DE CAMP LE 2026-09-24, et la phrase avec. Elle accusait Meta (« il
 * n'accepte pas encore de connexion MCP »), ce qui était exact au 2026-09-10 et vérifié ce jour-là. Meta
 * documente désormais `connector_protocol: MCP` sur ses connecteurs. Le verrou est donc CHEZ NOUS :
 * `src/mba/outils-a-publier.ts` n'expédie que les appels HTTP et les gestes maison. Dire le contraire
 * enverrait le client réclamer chez Meta une limite qui est la nôtre.
 */
export function McpServeurs({ tenantId, isAdmin }: { tenantId: string; isAdmin: boolean }) {
  const t = useT();
  const [serveurs, setServeurs] = useState<ServeurMcp[] | null>(null);
  const [ouvert, setOuvert] = useState<string | null>(null);
  const [outils, setOutils] = useState<Record<string, OutilMcp[]>>({});
  const [champs, setChamps] = useState<{ champs: string[]; champsContact: string[] }>({ champs: [], champsContact: [] });
  const [plan, setPlan] = useState<{ sourceId: string; plan: ChangementMcp[]; tronque: boolean } | null>(null);
  const [epreuve, setEpreuve] = useState<{ sourceId: string; ok: boolean; erreur?: string } | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [neuf, setNeuf] = useState<{ label: string; baseUrl: string; authKind: AuthMcp; authSecret: string; authHeaderName: string } | null>(null);

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
      setChamps({ champs: r.champs, champsContact: r.champsContact });
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
        <TitrePage>{t('Connecteurs MCP', 'MCP connectors')}</TitrePage>
        <IntroPage>
          {t('Les serveurs MCP que vos agents IA peuvent interroger. Déclarés une fois ici, leur catalogue d’outils est importé puis proposé à chaque agent dans son onglet Outils.',
            'The MCP servers your AI agents can query. Declared once here, their tool catalogue is imported and then offered to each agent in its Tools tab.')}
        </IntroPage>
        {/* ⚠️ ON LE DIT, ON NE GRISE PAS : une case désactivée sans explication enverrait le client ouvrir
            un ticket. Et on dit que la limite est LA NÔTRE, parce qu'elle l'est. */}
        <p className="mt-2 text-xs text-ink-500" data-testid="mcp-note-mba">
          {t('Ces outils servent vos agents IA. L’agent de Meta ne les reçoit pas encore : notre publication vers Meta ne sait envoyer que des appels HTTP.',
            'These tools serve your AI agents. Meta’s agent does not receive them yet: what we publish to Meta can only carry HTTP calls.')}
        </p>
      </header>

      {erreur && <p className="text-xs text-danger" data-testid="mcp-erreur">{erreur}</p>}

      {isAdmin && (
        <div className={cardCls} data-testid="mcp-declarer">
          {neuf === null ? (
            <button type="button" className="text-sm text-brand-700 underline hover:text-brand-800" data-testid="mcp-declarer-ouvrir"
              onClick={() => setNeuf({ label: '', baseUrl: '', authKind: 'bearer', authSecret: '', authHeaderName: '' })}>
              {t('+ déclarer un serveur MCP', '+ declare an MCP server')}
            </button>
          ) : (
            <div className="space-y-2">
              <input className={inputCls} value={neuf.label} data-testid="mcp-neuf-label"
                placeholder={t('Nom (ex. Notion)', 'Name (e.g. Notion)')}
                onChange={(e) => setNeuf({ ...neuf, label: e.target.value })} />
              {/* ⚠️ L'ADRESSE DU POINT MCP, PAS UNE RACINE. Un serveur MCP a UNE adresse unique, là où un
                  connecteur API a une base sous laquelle on compose des chemins. Le dire ici évite de
                  coller l'adresse d'une API REST et de se demander pourquoi rien ne répond. */}
              <input className={inputCls} value={neuf.baseUrl} data-testid="mcp-neuf-url"
                placeholder={t('Adresse du point MCP (https://…/mcp)', 'MCP endpoint address (https://…/mcp)')}
                onChange={(e) => setNeuf({ ...neuf, baseUrl: e.target.value })} />
              <select className={inputCls} value={neuf.authKind} data-testid="mcp-neuf-auth"
                onChange={(e) => setNeuf({ ...neuf, authKind: e.target.value as AuthMcp })}>
                <option value="bearer">{t('jeton (Bearer)', 'token (Bearer)')}</option>
                <option value="header">{t('jeton dans un en-tête nommé', 'token in a named header')}</option>
                <option value="none">{t('aucune authentification', 'no authentication')}</option>
              </select>
              {neuf.authKind === 'header' && (
                <input className={inputCls} value={neuf.authHeaderName} data-testid="mcp-neuf-entete"
                  placeholder={t('nom de l’en-tête', 'header name')}
                  onChange={(e) => setNeuf({ ...neuf, authHeaderName: e.target.value })} />
              )}
              {neuf.authKind !== 'none' && (
                <input className={inputCls} type="password" value={neuf.authSecret} data-testid="mcp-neuf-secret"
                  placeholder={t('jeton', 'token')}
                  onChange={(e) => setNeuf({ ...neuf, authSecret: e.target.value })} />
              )}
              <div className="flex gap-2">
                <Bouton taille="petite" type="button" disabled={busy} data-testid="mcp-neuf-creer"
                  onClick={() => void agir(async () => {
                    await creerServeurMcp(tenantId, {
                      label: neuf.label, baseUrl: neuf.baseUrl, authKind: neuf.authKind,
                      ...(neuf.authHeaderName ? { authHeaderName: neuf.authHeaderName } : {}),
                      ...(neuf.authSecret ? { authSecret: neuf.authSecret } : {}),
                    });
                    setNeuf(null);
                    setServeurs((await listerServeursMcp(tenantId)).serveurs);
                  })}>
                  {t('Déclarer', 'Declare')}
                </Bouton>
                <Bouton variante="secondaire" taille="petite" type="button"
                  onClick={() => setNeuf(null)}>{t('Annuler', 'Cancel')}</Bouton>
              </div>
            </div>
          )}
        </div>
      )}

      {serveurs.length === 0 ? (
        <p className="text-sm text-ink-500" data-testid="mcp-vide">
          {t('Aucun serveur MCP déclaré. Utilisez le bouton ci-dessus pour en ajouter un : il vous faudra son adresse et son jeton.',
            'No MCP server yet. Use the button above to add one: you will need its address and its token.')}
        </p>
      ) : (
        <ul className="space-y-3">
          {serveurs.map((s) => (
            <li key={s.id} className={cardCls} data-testid={`mcp-serveur-${s.id}`}>
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                <span className="font-medium text-ink-900">{s.label}</span>
                <code className="text-xs text-ink-500">{s.baseUrl}</code>
                {s.status !== 'active' && (
                  <span className="rounded-full bg-ink-100 px-2 py-0.5 text-xs text-ink-500">{s.status}</span>
                )}
              </div>

              {/* 🔴 CE QUI REND UN SERVEUR MORT VISIBLE AVANT QU'UN CONTACT NE LE DÉCOUVRE. Un jeton expiré
                  ne produit aucune erreur applicative : l'agent dégraderait en silence, en pleine
                  conversation. */}
              <p className="mt-1 text-xs text-ink-500" data-testid={`mcp-etat-${s.id}`}>
                {s.lastError
                  ? <span className="text-danger">{t('Dernière erreur : ', 'Last error: ')}{s.lastError}</span>
                  : s.lastOkAt
                    ? `${t('A répondu le ', 'Answered on ')}${new Date(s.lastOkAt).toLocaleString()}`
                    : t('Jamais éprouvé.', 'Never tested.')}
              </p>

              {isAdmin && (
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <Bouton variante="secondaire" taille="petite" type="button" disabled={busy} data-testid={`mcp-eprouver-${s.id}`}
                    onClick={() => void agir(async () => { setEpreuve({ sourceId: s.id, ...(await eprouverServeurMcp(tenantId, s.id)) }); })}>
                    {t('Éprouver la connexion', 'Test the connection')}
                  </Bouton>
                  <Bouton variante="secondaire" taille="petite" type="button" disabled={busy} data-testid={`mcp-apercu-${s.id}`}
                    onClick={() => void agir(async () => { setPlan({ sourceId: s.id, ...(await apercuMcp(tenantId, s.id)) }); })}>
                    {t('Voir ce qui va changer', 'Preview changes')}
                  </Bouton>
                  <button type="button" disabled={busy} data-testid={`mcp-supprimer-${s.id}`}
                    className="rounded-lg border border-ink-300 bg-white px-2 py-0.5 text-xs text-danger transition-colors duration-150 hover:bg-danger-50 disabled:opacity-50"
                    onClick={() => void agir(async () => {
                      await supprimerServeurMcp(tenantId, s.id);
                      setServeurs((await listerServeursMcp(tenantId)).serveurs);
                    })}>
                    {t('Supprimer', 'Delete')}
                  </button>
                  <Bouton variante="secondaire" taille="petite" type="button" disabled={busy} data-testid={`mcp-outils-${s.id}`}
                    onClick={() => void agir(async () => {
                      setOuvert(ouvert === s.id ? null : s.id);
                      if (ouvert !== s.id) await chargerOutils(s.id);
                    })}>
                    {t('Les outils importés', 'Imported tools')}
                  </Bouton>
                </div>
              )}

              {epreuve?.sourceId === s.id && (
                <p className={`mt-2 text-xs ${epreuve.ok ? 'text-succes-700' : 'text-danger'}`} data-testid={`mcp-epreuve-${s.id}`}>
                  {epreuve.ok ? t('Le serveur répond.', 'The server answers.') : epreuve.erreur}
                </p>
              )}

              {plan?.sourceId === s.id && (
                <div className="mt-3 rounded-2xl border border-ink-200 bg-ink-50/50 p-3" data-testid={`mcp-plan-${s.id}`}>
                  {plan.tronque && (
                    /* 🔴 UN PLAFOND SILENCIEUX SE LIT COMME UNE COUVERTURE COMPLÈTE. Et il a une conséquence
                       que le client doit connaître : sur un catalogue tronqué, rien n'est retiré. */
                    <p className="mb-2 rounded-lg bg-alerte-50 px-2 py-1 text-xs text-ink-900" data-testid={`mcp-tronque-${s.id}`}>
                      {t('Ce serveur annonce plus d’outils que nous n’en lisons d’un coup. Rien ne sera retiré tant que la liste est incomplète.',
                        'This server announces more tools than we read at once. Nothing will be removed while the list is incomplete.')}
                    </p>
                  )}
                  {plan.plan.length === 0 ? (
                    <p className="text-xs text-succes-700">{t('Rien à changer.', 'Nothing to change.')}</p>
                  ) : (
                    <ul className="space-y-0.5">
                      {plan.plan.map((c, i) => (
                        <li key={`${c.type}-${c.nom}-${i}`} className={`text-xs ${c.type === 'disparu' ? 'text-danger' : 'text-ink-500'}`}>
                          <code>{c.nom}</code> : {LIBELLE[c.type]}
                          {'consentementsTombes' in c && c.consentementsTombes > 0 && (
                            <span className="text-danger">
                              {t(` (${c.consentementsTombes} agent(s) perdront l’accès)`, ` (${c.consentementsTombes} agent(s) will lose access)`)}
                            </span>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                  {plan.plan.length > 0 && (
                    <Bouton taille="petite" type="button" disabled={busy} data-testid={`mcp-importer-${s.id}`}
                      className="mt-2"
                      onClick={() => void agir(async () => {
                        await importerMcp(tenantId, s.id);
                        setPlan(null);
                        setServeurs((await listerServeursMcp(tenantId)).serveurs);
                        if (ouvert === s.id) await chargerOutils(s.id);
                      })}>
                      {t(`Appliquer ces ${plan.plan.length} changement(s)`, `Apply these ${plan.plan.length} change(s)`)}
                    </Bouton>
                  )}
                </div>
              )}

              {ouvert === s.id && (
                <ul className="mt-3 space-y-2" data-testid={`mcp-liste-outils-${s.id}`}>
                  {(outils[s.id] ?? []).length === 0
                    ? <li className="text-xs text-ink-500">{t('Aucun outil importé.', 'No imported tool.')}</li>
                    : (outils[s.id] ?? []).map((o) => (
                      <li key={o.id}>
                        <McpOutilReglage tenantId={tenantId} outil={o} champs={champs.champs}
                          champsContact={champs.champsContact} onChange={() => void chargerOutils(s.id)} />
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
