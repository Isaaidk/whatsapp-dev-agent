export const TELEGRAM_MAX_MESSAGE_LENGTH = 4000;

export function formatTelegramText(text: string): string {
  return text
    .replace(/```[\w-]*\n?/g, '')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*|__|~~/g, '')
    .replace(/^\s*#{1,6}\s+/gm, '')
    .replace(/^\s*[*+]\s+/gm, '- ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Divide un texto en fragmentos que Telegram pueda aceptar. Telegram rechaza
 * mensajes de más de 4096 caracteres, así que cortamos por saltos de línea o
 * espacios para no partir palabras a la mitad.
 */
export function splitTelegramText(
  text: string,
  limit = TELEGRAM_MAX_MESSAGE_LENGTH,
): string[] {
  const normalized = text.trim();
  if (!normalized) return [];
  if (normalized.length <= limit) return [normalized];

  const chunks: string[] = [];
  let remaining = normalized;
  while (remaining.length > limit) {
    let cut = remaining.lastIndexOf('\n', limit);
    if (cut <= 0) cut = remaining.lastIndexOf(' ', limit);
    if (cut <= 0) cut = limit;
    chunks.push(remaining.slice(0, cut).trimEnd());
    remaining = remaining.slice(cut).trimStart();
  }
  if (remaining) chunks.push(remaining);
  return chunks.map((chunk, index, all) =>
    all.length > 1 ? `${chunk}\n\n(${index + 1}/${all.length})` : chunk,
  );
}
