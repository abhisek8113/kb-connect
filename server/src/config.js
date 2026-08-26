import 'dotenv/config';

const num = (v, d) => (v === undefined ? d : Number(v));

export const config = {
  port: num(process.env.PORT, 4000),
  env: process.env.NODE_ENV || 'development',
  corsOrigins: (process.env.CORS_ORIGINS || 'http://localhost:4000')
    .split(',').map(s => s.trim()).filter(Boolean),

  jwt: {
    accessSecret: process.env.JWT_ACCESS_SECRET || 'dev-access-secret',
    refreshSecret: process.env.JWT_REFRESH_SECRET || 'dev-refresh-secret',
    accessTtl: num(process.env.ACCESS_TOKEN_TTL, 900),
    refreshTtl: num(process.env.REFRESH_TOKEN_TTL, 1209600),
  },
  bcryptRounds: num(process.env.BCRYPT_ROUNDS, 12),

  databaseUrl: process.env.DATABASE_URL || 'postgres://kb:kb@localhost:5432/kbconnect',

  jitsi: {
    domain: process.env.JITSI_DOMAIN || 'meet.jit.si',
    appId: process.env.JITSI_APP_ID || 'kbconnect',
    appSecret: process.env.JITSI_APP_SECRET || 'dev-jitsi-secret',
    tokenTtl: num(process.env.JITSI_TOKEN_TTL, 7200),
  },
};

if (config.env === 'production') {
  for (const [k, v] of Object.entries({
    JWT_ACCESS_SECRET: process.env.JWT_ACCESS_SECRET,
    JWT_REFRESH_SECRET: process.env.JWT_REFRESH_SECRET,
    JITSI_APP_SECRET: process.env.JITSI_APP_SECRET,
  })) {
    if (!v || v.startsWith('change-me') || v.startsWith('dev-')) {
      throw new Error(`Refusing to start in production with insecure ${k}. Set a strong value.`);
    }
  }
}
