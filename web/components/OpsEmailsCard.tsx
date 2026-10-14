'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  lireEmailsOps, ecrireTexteEmailOps, retablirTexteEmailOps, poserInterrupteurEmailOps, apercuEmailOps, essaiEmailOps,
  type ModeleEmailOps, type TexteEmailOps,
} from '@/lib/api';
import { useLocale, useT } from '@/lib/i18n';
import { inputCls } from '@/lib/ui';
import { fmtNum } from '@/lib/format';
import { Bouton } from '@/components/Bouton';

/**
 * LA SECTION « E-MAILS » DE /ops (lot 7, spec `docs/superpowers/specs/2026-10-14-emails-produit-design.md`) : les
 * e-mails que le produit envoie aux clients, leurs chiffres du mois, un interrupteur chacun, leurs textes français et
 * anglais, l'aperçu et l'essai.
 *
 * L'écran ne décide de rien : le serveur refuse une variable inconnue (et la nomme), exige la note, signe de l'adresse
 * de l'exploitant. Silencieux et masqué si l'API n'a pas encore la route (une console publiée avant l'API).
 */

const CATEGORIES: Array<{ cle: ModeleEmailOps['categorie']; fr: string; en: string }> = [
  { cle: 'service', fr: 'Alertes de service (toujours envoyées)', en: 'Service alerts (always sent)' },
  { cle: 'transfert', fr: 'Conversations passées à l’équipe', en: 'Conversations handed to the team' },
  { cle: 'commercial', fr: 'E-mails commerciaux (désinscription possible)', en: 'Marketing e-mails (can unsubscribe)' },
];

/** Le brouillon d'un texte, en champs de saisie : un bouton sans libellé ni lien n'existe pas. */
interface Brouillon { sujet: string; corps: string; libelle: string; lien: string }

function versBrouillon(t: TexteEmailOps): Brouillon {
  return { sujet: t.sujet, corps: t.corps, libelle: t.bouton?.libelle ?? '', lien: t.bouton?.lien ?? '' };
}

function depuisBrouillon(b: Brouillon): TexteEmailOps {
  const libelle = b.libelle.trim();
  const lien = b.lien.trim();
  return { sujet: b.sujet, corps: b.corps, bouton: libelle === '' && lien === '' ? null : { libelle, lien } };
}

export function OpsEmailsCard({ token }: { token: string }) {
  const t = useT();
  const { locale } = useLocale();
  const [modeles, setModeles] = useState<ModeleEmailOps[] | null>(null);
  const [essaiPossible, setEssaiPossible] = useState(false);
  const [absente, setAbsente] = useState(false);
  const [ouvert, setOuvert] = useState<string | null>(null);
  const [langue, setLangue] = useState<'fr' | 'en'>('fr');
  const [brouillon, setBrouillon] = useState<Brouillon | null>(null);
  const [note, setNote] = useState('');
  const [apercu, setApercu] = useState<{ sujet: string; text: string } | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; texte: string } | null>(null);
  const [enCours, setEnCours] = useState(false);

  const charger = useCallback(() => {
    lireEmailsOps(token)
      // Une réponse sans la liste (une route simulée qui rend `{}`, une API d'une autre forme) masque la carte au lieu
      // de faire tomber toute la page /ops.
      .then((r) => {
        if (!Array.isArray(r?.modeles)) { setAbsente(true); return; }
        setModeles(r.modeles);
        setEssaiPossible(r.essaiPossible === true);
      })
      // Silencieux et masqué : une API plus ancienne que cette console n'a pas la route.
      .catch(() => setAbsente(true));
  }, [token]);
  useEffect(() => { charger(); }, [charger]);

  const modele = modeles?.find((m) => m.cle === ouvert) ?? null;

  /** Ouvrir un modèle dans une langue : le texte en vigueur (modifié, sinon celui d'origine) devient le brouillon. */
  function ouvrir(m: ModeleEmailOps, l: 'fr' | 'en') {
    setOuvert(m.cle);
    setLangue(l);
    setBrouillon(versBrouillon(m.textes[l].modifie ?? m.textes[l].origine));
    setApercu(null);
    setMsg(null);
  }

  /** Un geste vers le serveur : message de succès, ou celui que le serveur a écrit (variable inconnue, note...). */
  async function geste(f: () => Promise<unknown>, ok: string) {
    setEnCours(true);
    setMsg(null);
    try {
      await f();
      setMsg({ ok: true, texte: ok });
      return true;
    } catch (err) {
      setMsg({ ok: false, texte: err instanceof Error ? err.message : t('Échec.', 'Failed.') });
      return false;
    } finally {
      setEnCours(false);
    }
  }

  if (absente) {
    return (
      <div className="rounded-carte border border-ink-200 bg-white p-5">
        <h2 className="text-sm font-semibold text-ink-900">{t('E-mails', 'E-mails')}</h2>
        <p className="mt-1 text-xs text-ink-500">
          {t('Section pas encore disponible : l’API de ce serveur n’a pas les e-mails du produit.', 'Section not available yet: this server’s API does not have product e-mails.')}
        </p>
      </div>
    );
  }
  if (modeles === null) return null;

  return (
    <div className="rounded-carte border border-ink-200 bg-white p-5" data-testid="ops-emails">
      <h2 className="text-sm font-semibold text-ink-900">{t('E-mails', 'E-mails')}</h2>
      <p className="mt-1 text-xs text-ink-500">
        {t(
          'Les e-mails que le produit envoie aux admins des espaces. Les chiffres sont ceux du mois en cours ; ouverts et cliqués viennent du webhook de Resend.',
          'The e-mails the product sends to workspace admins. Figures are for the current month; opened and clicked come from the Resend webhook.',
        )}
      </p>

      {/* La NOTE est obligatoire côté serveur pour chaque écriture : elle dit pourquoi, et l'adresse est enregistrée avec. */}
      <div className="mt-4">
        <label htmlFor="emails-note" className="block text-xs font-medium text-ink-900">{t('Pourquoi ce changement ?', 'Why this change?')}</label>
        <input
          id="emails-note" value={note} onChange={(e) => setNote(e.target.value)} data-testid="ops-emails-note"
          placeholder={t('obligatoire pour enregistrer, rétablir ou couper', 'required to save, restore or switch off')}
          className={`mt-1 ${inputCls}`}
        />
      </div>

      {CATEGORIES.map((c) => {
        const liste = modeles.filter((m) => m.categorie === c.cle);
        if (liste.length === 0) return null;
        return (
          <div key={c.cle} className="mt-5">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-500">{locale === 'en' ? c.en : c.fr}</h3>
            <table className="mt-2 w-full text-left text-sm">
              <thead className="text-xs text-ink-500">
                <tr>
                  <th className="py-1 pr-3 font-medium">{t('E-mail', 'E-mail')}</th>
                  <th className="py-1 pr-3 text-right font-medium">{t('Envoyés', 'Sent')}</th>
                  <th className="py-1 pr-3 text-right font-medium">{t('Échecs', 'Failed')}</th>
                  <th className="py-1 pr-3 text-right font-medium">{t('Ouverts', 'Opened')}</th>
                  <th className="py-1 pr-3 text-right font-medium">{t('Cliqués', 'Clicked')}</th>
                  <th className="py-1 font-medium" />
                </tr>
              </thead>
              <tbody>
                {liste.map((m) => (
                  <tr key={m.cle} className="border-t border-ink-100" data-testid={`ops-email-${m.cle}`}>
                    <td className="py-2 pr-3">
                      <div className="font-medium text-ink-900">{m.nom}</div>
                      <div className="text-xs text-ink-500">{m.quand}</div>
                      {(m.textes.fr.modifie || m.textes.en.modifie) && (
                        <div className="text-xs text-brand-700">{t('Texte modifié', 'Text edited')}</div>
                      )}
                    </td>
                    <td className="py-2 pr-3 text-right tabular-nums">{fmtNum(m.chiffres.envoyes, locale)}</td>
                    <td className="py-2 pr-3 text-right tabular-nums">{fmtNum(m.chiffres.echecs, locale)}</td>
                    <td className="py-2 pr-3 text-right tabular-nums">{fmtNum(m.chiffres.ouverts, locale)}</td>
                    <td className="py-2 pr-3 text-right tabular-nums">{fmtNum(m.chiffres.cliques, locale)}</td>
                    <td className="py-2 text-right">
                      <div className="flex justify-end gap-2">
                        <Bouton
                          type="button" variante="secondaire" taille="petite" disabled={enCours}
                          data-testid={`ops-email-actif-${m.cle}`}
                          onClick={() => {
                            void geste(() => poserInterrupteurEmailOps(token, m.cle, !m.actif, note), m.actif ? t('Coupé', 'Switched off') : t('Rallumé', 'Switched on'))
                              .then((ok) => { if (ok) { setNote(''); charger(); } });
                          }}
                        >
                          {m.actif ? t('Actif', 'On') : t('Coupé', 'Off')}
                        </Bouton>
                        <Bouton type="button" variante="discret" taille="petite" onClick={() => ouvrir(m, 'fr')} data-testid={`ops-email-ouvrir-${m.cle}`}>
                          {t('Modifier', 'Edit')}
                        </Bouton>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      })}

      {modele && brouillon && (
        <div className="mt-6 border-t border-ink-100 pt-5" data-testid="ops-email-edition">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-ink-900">{modele.nom}</h3>
            <div className="inline-flex overflow-hidden rounded-controle border border-ink-200 text-xs">
              {(['fr', 'en'] as const).map((l) => (
                <button
                  key={l} type="button" aria-pressed={langue === l} onClick={() => ouvrir(modele, l)}
                  className={`px-2 py-0.5 font-medium ${langue === l ? 'bg-brand-600 text-white' : 'text-ink-500 hover:bg-ink-50'}`}
                >
                  {l.toUpperCase()}
                </button>
              ))}
            </div>
          </div>
          {modele.textes[langue].modifie && (
            <p className="mt-1 text-xs text-ink-500">
              {t('Modifié par', 'Edited by')} {modele.textes[langue].modifie!.par}
            </p>
          )}

          <label className="mt-3 block text-xs font-medium text-ink-900" htmlFor="email-sujet">{t('Sujet', 'Subject')}</label>
          <input id="email-sujet" className={`mt-1 ${inputCls}`} value={brouillon.sujet} onChange={(e) => setBrouillon({ ...brouillon, sujet: e.target.value })} data-testid="ops-email-sujet" />

          <label className="mt-3 block text-xs font-medium text-ink-900" htmlFor="email-corps">{t('Texte (une ligne vide sépare deux paragraphes)', 'Text (a blank line separates two paragraphs)')}</label>
          <textarea id="email-corps" rows={9} className={`mt-1 ${inputCls}`} value={brouillon.corps} onChange={(e) => setBrouillon({ ...brouillon, corps: e.target.value })} data-testid="ops-email-corps" />

          <div className="mt-3 grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-ink-900" htmlFor="email-bouton">{t('Bouton : libellé', 'Button: label')}</label>
              <input id="email-bouton" className={`mt-1 ${inputCls}`} value={brouillon.libelle} onChange={(e) => setBrouillon({ ...brouillon, libelle: e.target.value })} />
            </div>
            <div>
              <label className="block text-xs font-medium text-ink-900" htmlFor="email-lien">{t('Bouton : lien (vide = pas de bouton)', 'Button: link (empty = no button)')}</label>
              <input id="email-lien" className={`mt-1 ${inputCls}`} value={brouillon.lien} onChange={(e) => setBrouillon({ ...brouillon, lien: e.target.value })} />
            </div>
          </div>

          <div className="mt-3 text-xs text-ink-500">
            <span className="font-medium text-ink-900">{t('Variables : ', 'Variables: ')}</span>
            {modele.variables.map((v) => (
              <span key={v.nom} className="mr-3 inline-block" title={v.description}>
                <code className="text-brand-700">{`{{${v.nom}}}`}</code> {v.description}
              </span>
            ))}
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-2">
            <Bouton
              type="button" disabled={enCours} data-testid="ops-email-enregistrer"
              onClick={() => { void geste(() => ecrireTexteEmailOps(token, modele.cle, langue, depuisBrouillon(brouillon), note), t('Enregistré', 'Saved')).then((ok) => { if (ok) { setNote(''); charger(); } }); }}
            >
              {t('Enregistrer', 'Save')}
            </Bouton>
            <Bouton
              type="button" variante="secondaire" disabled={enCours} data-testid="ops-email-apercu"
              onClick={() => { void geste(async () => { const r = await apercuEmailOps(token, modele.cle, langue, depuisBrouillon(brouillon)); setApercu({ sujet: r.sujet, text: r.text }); }, t('Aperçu à jour', 'Preview updated')); }}
            >
              {t('Aperçu', 'Preview')}
            </Bouton>
            <Bouton
              type="button" variante="secondaire" disabled={enCours || !essaiPossible} data-testid="ops-email-essai"
              onClick={() => { void geste(() => essaiEmailOps(token, modele.cle, langue, depuisBrouillon(brouillon)), t('Essai envoyé à votre adresse', 'Test sent to your address')); }}
            >
              {t('M’envoyer un essai', 'Send me a test')}
            </Bouton>
            {modele.textes[langue].modifie && (
              <Bouton
                type="button" variante="discret" disabled={enCours} data-testid="ops-email-retablir"
                onClick={() => { void geste(() => retablirTexteEmailOps(token, modele.cle, langue, note), t('Texte d’origine rétabli', 'Original text restored')).then((ok) => { if (ok) { setNote(''); setOuvert(null); charger(); } }); }}
              >
                {t('Rétablir le texte d’origine', 'Restore the original text')}
              </Bouton>
            )}
          </div>
          {apercu && (
            <div className="mt-4 rounded-controle border border-ink-200 bg-ink-50 p-3" data-testid="ops-email-apercu-rendu">
              <div className="text-xs text-ink-500">{t('Sujet', 'Subject')}</div>
              <div className="text-sm font-medium text-ink-900">{apercu.sujet}</div>
              <pre className="mt-2 whitespace-pre-wrap font-sans text-sm text-ink-900">{apercu.text}</pre>
            </div>
          )}
        </div>
      )}

      {msg && (
        <p className={`mt-3 text-xs ${msg.ok ? 'text-succes-700' : 'text-danger-700'}`} data-testid="ops-emails-message">{msg.texte}</p>
      )}
    </div>
  );
}
