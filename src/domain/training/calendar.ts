// Utilidades de fechas en la zona horaria del ciclista (no en UTC del servidor).
// Un entreno a las 00:30 en Madrid debe contar para ese día, no para el anterior.

export const APP_TIMEZONE = process.env.APP_TIMEZONE ?? 'Europe/Madrid'

const keyFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: APP_TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit',
})

// 'YYYY-MM-DD' del día local
export function dayKey(date: Date): string {
  return keyFormatter.format(date)
}

// Suma días a una clave 'YYYY-MM-DD' (aritmética en UTC para evitar saltos por cambio de hora)
export function addDays(key: string, days: number): string {
  const d = new Date(`${key}T12:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

// Días de `from` a `to` (claves 'YYYY-MM-DD'); negativo si `to` es anterior
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86_400_000)
}

// Lunes de la semana de una clave 'YYYY-MM-DD'
export function mondayKey(key: string): string {
  const dow = new Date(`${key}T12:00:00Z`).getUTCDay()  // 0 = domingo
  return addDays(key, dow === 0 ? -6 : 1 - dow)
}

// Formatea una clave de día para mostrarla en español
export function formatDayKey(key: string, opts: Intl.DateTimeFormatOptions): string {
  return new Date(`${key}T12:00:00Z`).toLocaleDateString('es-ES', { ...opts, timeZone: 'UTC' })
}

export function formatDate(date: Date, opts: Intl.DateTimeFormatOptions): string {
  return date.toLocaleDateString('es-ES', { ...opts, timeZone: APP_TIMEZONE })
}
