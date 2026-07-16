'use client';

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';

/**
 * i18n léger, sans dépendance : la langue vit dans un contexte (persisté en localStorage), et chaque chaîne
 * porte sa traduction AU POINT D'APPEL via `t('texte FR', 'EN text')`. Pas de dictionnaire central à maintenir
 * en parallèle : la traduction est co-localisée avec la chaîne (maintenable, pas de dérive). Anglais absent -> FR.
 *
 * Usage dans un composant :  const t = useT();  ...  {t('Bonjour', 'Hello')}
 * Défaut FR ; le choix (menu compte) est mémorisé par navigateur.
 */
import type { Locale } from './locale';
export type { Locale } from './locale';
const STORAGE_KEY = 'mba_locale';

interface LocaleCtx {
  locale: Locale;
  setLocale: (l: Locale) => void;
}
const Ctx = createContext<LocaleCtx>({ locale: 'fr', setLocale: () => {} });

export function LocaleProvider({ children }: { children: ReactNode }) {
  // Défaut 'fr' au 1er rendu (identique serveur/client -> pas de mismatch d'hydratation). Le choix mémorisé
  // est appliqué APRÈS le montage (effet client), au prix d'un bref flash si l'utilisateur avait choisi EN.
  const [locale, setLocaleState] = useState<Locale>('fr');
  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(STORAGE_KEY);
      if (saved === 'fr' || saved === 'en') {
        setLocaleState(saved);
        // Resynchronise AUSSI <html lang> (le layout SSR pose lang="fr" par défaut) : sans ça, une préférence
        // EN chargée affichait l'app en anglais avec un document déclaré... français.
        try { document.documentElement.lang = saved; } catch { /* edge */ }
      }
    } catch { /* localStorage indisponible -> reste FR */ }
  }, []);
  const setLocale = useCallback((l: Locale) => {
    setLocaleState(l);
    try { window.localStorage.setItem(STORAGE_KEY, l); } catch { /* non bloquant */ }
    try { document.documentElement.lang = l; } catch { /* SSR/edge */ }
  }, []);
  return <Ctx.Provider value={{ locale, setLocale }}>{children}</Ctx.Provider>;
}

export function useLocale(): LocaleCtx {
  return useContext(Ctx);
}

/** Retourne `t(fr, en?)` -> la chaîne dans la langue courante (repli FR si l'anglais n'est pas fourni). */
export function useT(): (fr: string, en?: string) => string {
  const { locale } = useContext(Ctx);
  return useCallback((fr: string, en?: string) => (locale === 'en' && en !== undefined ? en : fr), [locale]);
}
