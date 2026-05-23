import { createHash, randomBytes } from 'node:crypto';
import jwt, { type JwtPayload, type SignOptions } from 'jsonwebtoken';
import { env } from '../config/env';
import { parseTtlSeconds } from './ttl';
import type { Role } from '../modules/permissions/permissions.constants';

const getAccessSecret = (): string => {
  if (!env.JWT_ACCESS_SECRET) {
    throw new Error('JWT_ACCESS_SECRET is not configured');
  }
  return env.JWT_ACCESS_SECRET;
};

const getRefreshSecret = (): string => {
  if (!env.JWT_REFRESH_SECRET) {
    throw new Error('JWT_REFRESH_SECRET is not configured');
  }
  return env.JWT_REFRESH_SECRET;
};

export interface AccessTokenPayload extends JwtPayload {
  sub: string;
  sid: string;
  role: Role;
}

export interface RefreshTokenPayload extends JwtPayload {
  sub: string;
  sid: string;
  jti: string;
}

const baseSignOptions: SignOptions = {
  issuer: env.JWT_ISSUER,
  audience: env.JWT_AUDIENCE
};

export const signAccessToken = (params: {
  userId: string;
  sessionId: string;
  role: Role;
}): { token: string; expiresInSeconds: number } => {
  const expiresInSeconds = parseTtlSeconds(env.ACCESS_TOKEN_TTL);
  const token = jwt.sign(
    { sub: params.userId, sid: params.sessionId, role: params.role },
    getAccessSecret(),
    { ...baseSignOptions, expiresIn: expiresInSeconds }
  );
  return { token, expiresInSeconds };
};

export const signRefreshToken = (params: {
  userId: string;
  sessionId: string;
  jti: string;
}): { token: string; expiresInSeconds: number } => {
  const expiresInSeconds = parseTtlSeconds(env.REFRESH_TOKEN_TTL);
  const token = jwt.sign(
    { sub: params.userId, sid: params.sessionId, jti: params.jti },
    getRefreshSecret(),
    { ...baseSignOptions, expiresIn: expiresInSeconds }
  );
  return { token, expiresInSeconds };
};

export const verifyAccessToken = (token: string): AccessTokenPayload => {
  const payload = jwt.verify(token, getAccessSecret(), {
    issuer: env.JWT_ISSUER,
    audience: env.JWT_AUDIENCE
  });
  if (typeof payload === 'string') {
    throw new Error('Unexpected string JWT payload');
  }
  return payload as AccessTokenPayload;
};

export const verifyRefreshToken = (token: string): RefreshTokenPayload => {
  const payload = jwt.verify(token, getRefreshSecret(), {
    issuer: env.JWT_ISSUER,
    audience: env.JWT_AUDIENCE
  });
  if (typeof payload === 'string') {
    throw new Error('Unexpected string JWT payload');
  }
  return payload as RefreshTokenPayload;
};

export const hashRefreshToken = (token: string): string =>
  createHash('sha256').update(token).digest('hex');

export const generateJti = (): string => randomBytes(16).toString('hex');
