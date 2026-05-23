import argon2 from 'argon2';
import mongoose, { type FilterQuery, type Types } from 'mongoose';
import {
  ConflictError,
  UnauthorizedError,
  BadRequestError
} from '../../utils/errors';
import {
  generateJti,
  hashRefreshToken,
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken
} from '../../utils/jwt';
import { parseTtlSeconds } from '../../utils/ttl';
import { env } from '../../config/env';
import { logger } from '../../utils/logger';
import { User, toUserDto, type UserDocument } from '../users/user.model';
import { USER_STATUS } from '../users/user.types';
import {
  Session,
  SESSION_REVOKED_REASON,
  type SessionDocument
} from '../sessions/session.model';
import type {
  ChangePasswordInput,
  ForgotPasswordInput,
  LoginInput,
  RegisterInput
} from './auth.validation';
import type { AuthResult, AuthTokens, RequestContext } from './auth.types';

const ARGON2_OPTIONS: argon2.Options = {
  type: argon2.argon2id
};

const findUserByIdentifier = async (
  email?: string,
  phone?: string
): Promise<(UserDocument & { passwordHash: string }) | null> => {
  const filter: FilterQuery<UserDocument> = {};
  if (email) filter.email = email.toLowerCase();
  else if (phone) filter.phone = phone;
  else return null;

  // Explicitly select passwordHash because the schema hides it by default.
  const user = await User.findOne(filter).select('+passwordHash +passwordChangedAt');
  return user as (UserDocument & { passwordHash: string }) | null;
};

const issueTokensForUser = async (params: {
  userId: Types.ObjectId;
  role: UserDocument['role'];
  ctx: RequestContext;
}): Promise<{ tokens: AuthTokens; session: SessionDocument }> => {
  const jti = generateJti();
  const refreshTtl = parseTtlSeconds(env.REFRESH_TOKEN_TTL);
  const session = new Session({
    userId: params.userId,
    refreshTokenHash: 'pending',
    userAgent: params.ctx.userAgent,
    ipAddress: params.ctx.ipAddress,
    expiresAt: new Date(Date.now() + refreshTtl * 1000),
    rotatedAt: new Date()
  });

  const { token: refreshToken, expiresInSeconds: refreshExp } = signRefreshToken({
    userId: params.userId.toString(),
    sessionId: session._id.toString(),
    jti
  });
  session.refreshTokenHash = hashRefreshToken(refreshToken);
  await session.save();

  const { token: accessToken, expiresInSeconds: accessExp } = signAccessToken({
    userId: params.userId.toString(),
    sessionId: session._id.toString(),
    role: params.role
  });

  return {
    session,
    tokens: {
      accessToken,
      refreshToken,
      accessTokenExpiresInSeconds: accessExp,
      refreshTokenExpiresInSeconds: refreshExp
    }
  };
};

export const register = async (
  input: RegisterInput,
  ctx: RequestContext
): Promise<AuthResult> => {
  const passwordHash = await argon2.hash(input.password, ARGON2_OPTIONS);

  try {
    const user = await User.create({
      email: input.email,
      phone: input.phone,
      passwordHash,
      displayName: input.displayName
    });

    const { tokens } = await issueTokensForUser({
      userId: user._id,
      role: user.role,
      ctx
    });

    user.lastLoginAt = new Date();
    await user.save();

    return { user: toUserDto(user), tokens };
  } catch (err) {
    if (
      err instanceof mongoose.mongo.MongoServerError &&
      err.code === 11000
    ) {
      // Generic message to avoid revealing which identifier is taken.
      throw new ConflictError('Account could not be created');
    }
    throw err;
  }
};

export const login = async (
  input: LoginInput,
  ctx: RequestContext
): Promise<AuthResult> => {
  const user = await findUserByIdentifier(input.email, input.phone);

  // Constant-ish verification path to discourage user enumeration: always
  // run argon2.verify with a dummy hash when the user is missing.
  const dummyHash =
    '$argon2id$v=19$m=65536,t=3,p=4$ZHVtbXktc2FsdC1ub3QtcmVhbA$JdRb6tlV6lEUf2hYL+rDpQqXJJjcPRf2HoSj1qNZ5gE';
  const referenceHash = user?.passwordHash ?? dummyHash;

  let valid = false;
  try {
    valid = await argon2.verify(referenceHash, input.password);
  } catch {
    valid = false;
  }

  if (!user || !valid) {
    throw new UnauthorizedError('Invalid credentials');
  }

  if (user.status !== USER_STATUS.ACTIVE) {
    throw new UnauthorizedError('Account is not active');
  }

  const { tokens } = await issueTokensForUser({
    userId: user._id,
    role: user.role,
    ctx
  });

  user.lastLoginAt = new Date();
  await user.save();

  return { user: toUserDto(user), tokens };
};

export const refresh = async (
  refreshToken: string,
  ctx: RequestContext
): Promise<AuthTokens> => {
  let payload;
  try {
    payload = verifyRefreshToken(refreshToken);
  } catch {
    throw new UnauthorizedError('Invalid refresh token');
  }

  const session = await Session.findById(payload.sid);
  if (!session || session.userId.toString() !== payload.sub) {
    throw new UnauthorizedError('Invalid refresh token');
  }

  const presentedHash = hashRefreshToken(refreshToken);

  // Refresh token reuse: a session that's already been rotated/revoked
  // should never be presented again. Treat as compromise and revoke all
  // sessions for this user.
  if (session.revokedAt) {
    logger.warn(
      { userId: session.userId.toString(), sessionId: session._id.toString() },
      'Refresh token reuse detected — revoking all sessions for user'
    );
    await Session.updateMany(
      { userId: session.userId, revokedAt: { $exists: false } },
      {
        $set: {
          revokedAt: new Date(),
          revokedReason: SESSION_REVOKED_REASON.REUSED
        }
      }
    );
    throw new UnauthorizedError('Refresh token has been revoked');
  }

  if (session.refreshTokenHash !== presentedHash) {
    throw new UnauthorizedError('Invalid refresh token');
  }

  if (session.expiresAt.getTime() <= Date.now()) {
    throw new UnauthorizedError('Refresh token expired');
  }

  const user = await User.findById(session.userId);
  if (!user || user.status !== USER_STATUS.ACTIVE) {
    throw new UnauthorizedError('Account is not active');
  }

  // Rotate: issue a new session, mark the old one rotated.
  const { tokens, session: newSession } = await issueTokensForUser({
    userId: user._id,
    role: user.role,
    ctx
  });

  session.revokedAt = new Date();
  session.revokedReason = SESSION_REVOKED_REASON.ROTATED;
  session.replacedBySessionId = newSession._id;
  await session.save();

  return tokens;
};

export const logout = async (refreshToken: string): Promise<void> => {
  let payload;
  try {
    payload = verifyRefreshToken(refreshToken);
  } catch {
    // Treat invalid token as a no-op logout to avoid leaking signal.
    return;
  }

  const session = await Session.findById(payload.sid);
  if (!session || session.userId.toString() !== payload.sub) return;
  if (session.revokedAt) return;
  if (session.refreshTokenHash !== hashRefreshToken(refreshToken)) return;

  session.revokedAt = new Date();
  session.revokedReason = SESSION_REVOKED_REASON.LOGOUT;
  await session.save();
};

export const logoutAll = async (userId: string): Promise<number> => {
  const result = await Session.updateMany(
    { userId, revokedAt: { $exists: false } },
    {
      $set: {
        revokedAt: new Date(),
        revokedReason: SESSION_REVOKED_REASON.LOGOUT_ALL
      }
    }
  );
  return result.modifiedCount ?? 0;
};

export const changePassword = async (
  userId: string,
  input: ChangePasswordInput
): Promise<void> => {
  const user = await User.findById(userId).select('+passwordHash');
  if (!user) {
    throw new UnauthorizedError();
  }
  const valid = await argon2.verify(user.passwordHash, input.currentPassword);
  if (!valid) {
    throw new UnauthorizedError('Current password is incorrect');
  }
  user.passwordHash = await argon2.hash(input.newPassword, ARGON2_OPTIONS);
  user.passwordChangedAt = new Date();
  await user.save();

  await Session.updateMany(
    { userId: user._id, revokedAt: { $exists: false } },
    {
      $set: {
        revokedAt: new Date(),
        revokedReason: SESSION_REVOKED_REASON.PASSWORD_CHANGE
      }
    }
  );
};

export const forgotPassword = async (
  _input: ForgotPasswordInput
): Promise<void> => {
  // Intentionally a no-op for now: a real password reset flow (token
  // generation, email/SMS dispatch, audit trail) lands in a later module.
  // The endpoint exists so clients can integrate against a stable surface,
  // and it MUST NOT reveal whether the account exists.
  return;
};

export const resetPassword = async (): Promise<void> => {
  // Not yet implemented — paired placeholder with forgotPassword. Reject
  // clearly so callers don't assume their reset succeeded.
  throw new BadRequestError('Password reset flow is not yet enabled');
};

export const findUserById = async (userId: string) => User.findById(userId);
