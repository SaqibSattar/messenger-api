const UNITS: Record<string, number> = {
  s: 1,
  m: 60,
  h: 60 * 60,
  d: 60 * 60 * 24
};

export const parseTtlSeconds = (ttl: string): number => {
  const match = /^(\d+)([smhd])$/.exec(ttl.trim());
  if (!match) {
    throw new Error(
      `Invalid TTL format: "${ttl}". Expected <number><s|m|h|d>, e.g. "15m"`
    );
  }
  const value = Number(match[1]);
  const unit = match[2];
  return value * UNITS[unit];
};
