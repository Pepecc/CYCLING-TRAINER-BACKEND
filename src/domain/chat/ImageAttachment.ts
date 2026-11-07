// Imágenes que el ciclista adjunta en el chat o sube para importar un plan.
// Llegan en base64 (el frontend las reduce antes de enviarlas) y se guardan en Firestore como bytes:
// cada imagen va en su propio documento, que no puede pasar de 1 MiB.

export const IMAGE_MEDIA_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'] as const
export type ImageMediaType = typeof IMAGE_MEDIA_TYPES[number]

export const MAX_IMAGE_BYTES = 900 * 1024
export const MAX_IMAGES_PER_MESSAGE = 4

export interface ImageInput {
  mediaType: ImageMediaType
  data: string            // base64 sin el prefijo data:
  name: string | null
}

export class ImageValidationError extends Error {}

// Accepts { mediaType, data } with plain base64 or a data URL. Throws ImageValidationError.
export function parseImage(raw: unknown, label = 'La imagen'): ImageInput {
  if (!raw || typeof raw !== 'object') throw new ImageValidationError(`${label} no tiene un formato válido`)
  const r = raw as Record<string, unknown>
  if (typeof r.data !== 'string' || !r.data) throw new ImageValidationError(`${label} no tiene datos`)

  let data = r.data.trim()
  let mediaType = typeof r.mediaType === 'string' ? r.mediaType.toLowerCase() : ''
  const dataUrl = /^data:([^;,]+);base64,/.exec(data)
  if (dataUrl) {
    mediaType = mediaType || dataUrl[1].toLowerCase()
    data = data.slice(dataUrl[0].length)
  }
  if (mediaType === 'image/jpg') mediaType = 'image/jpeg'
  if (!(IMAGE_MEDIA_TYPES as readonly string[]).includes(mediaType)) {
    throw new ImageValidationError(`${label}: formato no admitido (JPEG, PNG, WebP o GIF)`)
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(data)) throw new ImageValidationError(`${label}: los datos no son base64 válido`)

  const bytes = Math.floor((data.length * 3) / 4) - (data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0)
  if (bytes > MAX_IMAGE_BYTES) {
    throw new ImageValidationError(`${label} ocupa demasiado (${Math.round(bytes / 1024)} KB, máx. ${MAX_IMAGE_BYTES / 1024} KB)`)
  }

  const name = typeof r.name === 'string' && r.name.trim() ? r.name.trim().slice(0, 120) : null
  return { mediaType: mediaType as ImageMediaType, data, name }
}

export function parseImages(raw: unknown): ImageInput[] {
  if (raw === undefined || raw === null) return []
  if (!Array.isArray(raw)) throw new ImageValidationError('Las imágenes deben ir en una lista')
  if (raw.length > MAX_IMAGES_PER_MESSAGE) {
    throw new ImageValidationError(`Como máximo ${MAX_IMAGES_PER_MESSAGE} imágenes por mensaje`)
  }
  return raw.map((img, i) => parseImage(img, raw.length > 1 ? `La imagen ${i + 1}` : 'La imagen'))
}
