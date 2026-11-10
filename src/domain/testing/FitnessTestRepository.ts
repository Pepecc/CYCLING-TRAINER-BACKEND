import { FitnessTestResultProps } from './fitnessTest'

// Historial de tests de cada usuario
export interface FitnessTestRepository {
  save(result: FitnessTestResultProps): Promise<void>
  findAll(userId: string): Promise<FitnessTestResultProps[]>   // del más reciente al más antiguo
}
