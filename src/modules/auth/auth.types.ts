import type { UserDto } from '../users/user.types';

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresInSeconds: number;
  refreshTokenExpiresInSeconds: number;
}

export interface AuthResult {
  user: UserDto;
  tokens: AuthTokens;
}

export interface RequestContext {
  userAgent?: string;
  ipAddress?: string;
}
