// Estados CSRF del flujo OAuth de Wahoo (state → userId), persistidos para
// sobrevivir a reinicios del servidor y funcionar con varias instancias.
export interface OAuthStateRepository {
  create(state: string, userId: string, ttlMs: number): Promise<void>
  // Devuelve el userId y elimina el state (un solo uso). null si no existe o ha expirado.
  consume(state: string): Promise<string | null>
}
