'use client';

/**
 * Redimensionne une image côté client (canvas) -> data URL JPEG léger. Pur navigateur, aucune dépendance.
 * `max` = plus grand côté (px), `quality` = compression JPEG. Utilisé par le carousel (handle média) et
 * par le FlowBuilder (image embarquée en base64 dans le flow_json — capper plus petit).
 */
export async function resizeToDataUrl(file: File, max = 1024, quality = 0.82): Promise<string> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((res, rej) => {
      const i = new Image();
      i.onload = () => res(i);
      i.onerror = () => rej(new Error('image illisible'));
      i.src = url;
    });
    const scale = Math.min(1, max / Math.max(img.width, img.height));
    const w = Math.max(1, Math.round(img.width * scale));
    const h = Math.max(1, Math.round(img.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('canvas indisponible');
    ctx.drawImage(img, 0, 0, w, h);
    return canvas.toDataURL('image/jpeg', quality);
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Longueur de la chaîne base64 d'un data URL (préfixe `data:image/...;base64,` retiré). C'est CETTE
 *  grandeur que le serveur borne (IMG_MAX sur `src.length` après strip) — le client compare la même. */
export function dataUrlBase64Length(dataUrl: string): number {
  return dataUrl.replace(/^data:image\/[a-z]+;base64,/i, '').length;
}
