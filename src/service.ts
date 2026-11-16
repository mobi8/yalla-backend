import { newSave, type Principal, type Save } from './model.js';
import { ApiError, type PlayerRepository } from './repository.js';

export class PlayerService {
  constructor(private repository: PlayerRepository, private makeSave: () => Save = newSave) {}
  async read(principal: Principal): Promise<Save> {
    const id = await this.repository.find(principal);
    if (!id) throw new ApiError(404, 'PLAYER_NOT_FOUND');
    const save = await this.repository.read(id);
    if (!save) throw new Error('Auth link without player');
    return save;
  }
  async createGuest(principal: Principal): Promise<{ created: boolean; save: Save }> {
    if (principal.provider !== 'guest') throw new ApiError(403, 'GUEST_REQUIRED');
    const existing = await this.repository.find(principal);
    if (existing) return { created: false, save: await this.read(principal) };
    const save = this.makeSave();
    try { await this.repository.create(principal, save); }
    catch (error) {
      // A concurrent winner or an ambiguous timeout may have committed. Never create again blindly.
      const winner = await this.repository.find(principal);
      if (winner) return { created: false, save: await this.read(principal) };
      throw error;
    }
    return { created: true, save };
  }
}
