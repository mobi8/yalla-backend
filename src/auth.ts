import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { CognitoIdentityProviderClient, AdminCreateUserCommand, AdminGetUserCommand,
  AdminSetUserPasswordCommand, AdminInitiateAuthCommand, GetTokensFromRefreshTokenCommand,
  RevokeTokenCommand, type AuthenticationResultType } from '@aws-sdk/client-cognito-identity-provider';
import type { Principal } from './model.js';
import { ApiError } from './repository.js';

export const guestKeySchema = z.string().regex(/^[0-9a-f]{64}$/);
export interface Tokens { accessToken: string; idToken: string; refreshToken: string; expiresIn: number; tokenType: string }
export interface GuestIdentity {
  bootstrap(key: string): Promise<{ principal: Principal; tokens: Tokens }>;
  refresh(token: string): Promise<Tokens>;
  revoke(token: string): Promise<void>;
}
function tokens(result: AuthenticationResultType | undefined): Tokens {
  if (!result?.AccessToken || !result.IdToken || !result.RefreshToken || !result.ExpiresIn)
    throw new Error('Cognito did not issue a complete token set');
  return { accessToken: result.AccessToken, idToken: result.IdToken, refreshToken: result.RefreshToken,
    expiresIn: result.ExpiresIn, tokenType: result.TokenType ?? 'Bearer' };
}
export class CognitoGuestIdentity implements GuestIdentity {
  constructor(private client: CognitoIdentityProviderClient, private poolId: string, private clientId: string) {}
  async bootstrap(key: string) {
    guestKeySchema.parse(key);
    // The preimage is a 256-bit client credential, not a device ID. Never accept a username from the caller.
    const Username = `guest_${createHash('sha256').update(key).digest('hex')}`;
    try {
      await this.client.send(new AdminCreateUserCommand({ UserPoolId: this.poolId, Username,
        MessageAction: 'SUPPRESS', TemporaryPassword: `Aa1!${randomBytes(32).toString('base64url')}` }));
    } catch (error) {
      if (!(error instanceof Error) || error.name !== 'UsernameExistsException') throw error;
    }
    const user = await this.client.send(new AdminGetUserCommand({ UserPoolId: this.poolId, Username }));
    if (user.UserStatus === 'FORCE_CHANGE_PASSWORD') {
      await this.client.send(new AdminSetUserPasswordCommand({ UserPoolId: this.poolId, Username,
        Password: `Aa1!${key}`, Permanent: true }));
    }
    // CONFIRMED retries never reset a password, revive disabled users, or change social links.
    const result = await this.client.send(new AdminInitiateAuthCommand({ UserPoolId: this.poolId,
      ClientId: this.clientId, AuthFlow: 'ADMIN_USER_PASSWORD_AUTH', AuthParameters: { USERNAME: Username, PASSWORD: `Aa1!${key}` } }));
    // Cognito subjects are opaque identifiers; observed values need not satisfy RFC UUID variant bits.
    const sub = z.string().min(1).max(128).parse(user.UserAttributes?.find(a => a.Name === 'sub')?.Value);
    return { principal: { provider: 'guest' as const, subject: `${this.poolId}:${sub}` }, tokens: tokens(result.AuthenticationResult) };
  }
  async refresh(refreshToken: string) {
    try {
      const result = await this.client.send(new GetTokensFromRefreshTokenCommand({ ClientId: this.clientId, RefreshToken: refreshToken }));
      return tokens(result.AuthenticationResult);
    } catch (error) {
      if (error instanceof Error && ['NotAuthorizedException', 'RefreshTokenReuseException'].includes(error.name))
        throw new ApiError(401, 'INVALID_REFRESH_TOKEN');
      throw error;
    }
  }
  async revoke(refreshToken: string) {
    await this.client.send(new RevokeTokenCommand({ ClientId: this.clientId, Token: refreshToken }));
  }
}
