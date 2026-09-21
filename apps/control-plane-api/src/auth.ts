import { createHash, randomBytes } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { z } from 'zod';
import type { Express, Request, RequestHandler } from 'express';
import type { PublicAuthConfig } from '@agents-foundry/contracts';
import type { ControlPlaneDatabase } from './database.js';

export const GOOGLE_ISSUER = 'https://accounts.google.com';
export type GoogleConfig = {
  mode: 'google';
  clientId: string;
  clientSecret: string;
  workspaceDomain: string;
  callbackUrl: string;
  adminUrl: string;
  employeeUrl: string;
  secureCookies: boolean;
};
export type AuthConfig = { mode: 'demo' } | GoogleConfig;
export const hashToken = (value: string) => createHash('sha256').update(value).digest('hex');
const randomToken = () => randomBytes(32).toString('base64url');

export function loadAuthConfig(env: NodeJS.ProcessEnv = process.env): AuthConfig {
  if (env['AUTH_MODE'] === 'demo') {
    if (env['NODE_ENV'] === 'production') throw new Error('DEMO_AUTH_FORBIDDEN_IN_PRODUCTION');
    return { mode: 'demo' };
  }
  if (env['AUTH_MODE'] && env['AUTH_MODE'] !== 'google') throw new Error('INVALID_AUTH_MODE');
  const required = (name: string) => z.string().trim().min(1).parse(env[name]);
  const callbackUrl = required('GOOGLE_CALLBACK_URL');
  const adminUrl = required('ADMIN_APP_URL');
  const employeeUrl = required('EMPLOYEE_APP_URL');
  const urls = [callbackUrl, adminUrl, employeeUrl].map((value) => new URL(value));
  for (const url of urls) {
    const local = ['localhost', '127.0.0.1'].includes(url.hostname);
    if (
      (url.protocol !== 'https:' &&
        !(local && url.protocol === 'http:' && env['NODE_ENV'] !== 'production')) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error('INVALID_AUTH_URL');
  }
  if (urls[0].pathname !== '/api/auth/callback') throw new Error('INVALID_CALLBACK_PATH');
  const secureCookies = urls[0].protocol === 'https:';
  if (urls.some((url) => url.protocol !== urls[0].protocol))
    throw new Error('AUTH_URL_SCHEMES_MUST_MATCH');
  if (urls.some((url) => url.hostname !== urls[0].hostname))
    throw new Error('AUTH_URL_HOSTS_MUST_MATCH');
  return {
    mode: 'google',
    clientId: required('GOOGLE_CLIENT_ID'),
    clientSecret: required('GOOGLE_CLIENT_SECRET'),
    workspaceDomain: z
      .string()
      .regex(/^[a-z0-9]+(?:[.-][a-z0-9]+)*\.[a-z]{2,}$/)
      .parse(required('GOOGLE_WORKSPACE_DOMAIN').toLowerCase()),
    callbackUrl,
    adminUrl,
    employeeUrl,
    secureCookies,
  };
}

export function publicAuthConfig(config: AuthConfig): PublicAuthConfig {
  return config.mode === 'demo'
    ? config
    : { mode: 'google', workspaceDomain: config.workspaceDomain };
}

export class GoogleSignIn {
  constructor(
    private readonly config: GoogleConfig,
    private readonly keys: JWTVerifyGetKey = createRemoteJWKSet(
      new URL('https://www.googleapis.com/oauth2/v3/certs'),
      { timeoutDuration: 5000 },
    ),
    private readonly request: typeof fetch = fetch,
  ) {}

  async exchange(code: string, verifier: string, nonce: string): Promise<string> {
    const response = await this.request('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        code_verifier: verifier,
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
        redirect_uri: this.config.callbackUrl,
      }),
      signal: AbortSignal.timeout(10000),
      redirect: 'error',
    });
    if (!response.ok) throw new Error('GOOGLE_TOKEN_EXCHANGE_FAILED');
    const { id_token } = z
      .object({ id_token: z.string().min(1).max(20000) })
      .parse(await response.json());
    const { payload } = await jwtVerify(id_token, this.keys, {
      issuer: [GOOGLE_ISSUER, 'accounts.google.com'],
      audience: this.config.clientId,
      algorithms: ['RS256'],
      requiredClaims: ['sub', 'iss', 'aud', 'exp', 'iat', 'nonce'],
      clockTolerance: 5,
    });
    if (
      payload['nonce'] !== nonce ||
      payload['hd'] !== this.config.workspaceDomain ||
      payload['email_verified'] !== true ||
      (payload['azp'] !== undefined && payload['azp'] !== this.config.clientId) ||
      (Array.isArray(payload.aud) &&
        payload.aud.length > 1 &&
        payload['azp'] !== this.config.clientId) ||
      typeof payload.iat !== 'number' ||
      payload.iat > Date.now() / 1000 + 5
    )
      throw new Error('GOOGLE_IDENTITY_REJECTED');
    return z.string().min(1).max(512).parse(payload.sub);
  }
}

function cookie(req: Request, name: string): string | undefined {
  const values = (req.header('cookie') ?? '')
    .split(';')
    .map((item) => item.trim())
    .filter((item) => item.startsWith(`${name}=`));
  if (values.length !== 1) return undefined;
  const token = values[0].slice(name.length + 1);
  return /^[A-Za-z0-9_-]{43}$/.test(token) ? token : undefined;
}

export function configureAuth(
  app: Express,
  database: ControlPlaneDatabase,
  config: AuthConfig,
  google?: GoogleSignIn,
): RequestHandler {
  app.get('/api/auth/config', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json(publicAuthConfig(config));
  });
  if (config.mode === 'demo') {
    if (process.env['NODE_ENV'] === 'production')
      throw new Error('DEMO_AUTH_FORBIDDEN_IN_PRODUCTION');
    return (req, res, next) => {
      const id = req.header('x-actor-id');
      const role = req.header('x-actor-role');
      const organizationId = req.header('x-organization-id');
      if (!id || !role || !organizationId) {
        res.status(401).json({ error: 'AUTHENTICATION_REQUIRED' });
        return;
      }
      try {
        database.resolveActor(id, role, organizationId);
        res.locals['actor'] = { id, role, organizationId };
        next();
      } catch {
        res.status(403).json({ error: 'ACTOR_FORBIDDEN' });
      }
    };
  }
  const provider = google ?? new GoogleSignIn(config);
  const sessionName = config.secureCookies ? '__Host-af_session' : 'af_session';
  const loginName = config.secureCookies ? '__Host-af_login' : 'af_login';
  const options = {
    httpOnly: true,
    secure: config.secureCookies,
    sameSite: 'lax' as const,
    path: '/',
  };
  const origins = new Set([new URL(config.adminUrl).origin, new URL(config.employeeUrl).origin]);
  const requireOrigin: RequestHandler = (req, res, next) => {
    if (!origins.has(req.header('origin') ?? '')) {
      res.status(403).json({ error: 'ORIGIN_FORBIDDEN' });
      return;
    }
    next();
  };

  app.get('/api/auth/login', (req, res) => {
    const destination =
      req.query['client'] === 'admin'
        ? config.adminUrl
        : req.query['client'] === 'employee'
          ? config.employeeUrl
          : undefined;
    if (!destination) {
      res.status(400).json({ error: 'INVALID_CLIENT' });
      return;
    }
    const state = randomToken(),
      nonce = randomToken(),
      verifier = randomToken(),
      binding = randomToken();
    const previous = cookie(req, loginName);
    if (previous) database.discardLogin(hashToken(previous));
    database.createLogin(
      hashToken(binding),
      { state, nonce, verifier, destination },
      Date.now() + 600000,
    );
    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    url.search = new URLSearchParams({
      client_id: config.clientId,
      redirect_uri: config.callbackUrl,
      response_type: 'code',
      scope: 'openid email profile',
      state,
      nonce,
      hd: config.workspaceDomain,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
      prompt: 'select_account',
    }).toString();
    res.cookie(loginName, binding, { ...options, maxAge: 600000 });
    res.setHeader('Cache-Control', 'no-store');
    res.redirect(url.href);
  });
  app.get('/api/auth/callback', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const binding = cookie(req, loginName);
    res.clearCookie(loginName, options);
    const transaction = binding ? database.consumeLogin(hashToken(binding)) : undefined;
    if (
      !transaction ||
      req.query['state'] !== transaction.state ||
      typeof req.query['code'] !== 'string' ||
      req.query['code'].length > 4000 ||
      req.query['error']
    ) {
      res.status(400).json({ error: 'INVALID_LOGIN_CALLBACK' });
      return;
    }
    try {
      const subject = await provider.exchange(
        req.query['code'],
        transaction.verifier,
        transaction.nonce,
      );
      if (!database.findIdentity(GOOGLE_ISSUER, subject)) {
        res.status(403).json({ error: 'MEMBERSHIP_REQUIRED', issuer: GOOGLE_ISSUER, subject });
        return;
      }
      const old = cookie(req, sessionName);
      if (old) database.deleteSession(hashToken(old));
      const session = randomToken();
      database.createSession(hashToken(session), GOOGLE_ISSUER, subject, Date.now() + 8 * 3600000);
      res.cookie(sessionName, session, { ...options, maxAge: 8 * 3600000 });
      res.redirect(transaction.destination);
    } catch {
      res.status(401).json({ error: 'GOOGLE_SIGN_IN_FAILED' });
    }
  });
  app.post('/api/auth/logout', requireOrigin, (req, res) => {
    const token = cookie(req, sessionName);
    if (token) database.deleteSession(hashToken(token));
    res.clearCookie(sessionName, options);
    res.status(204).end();
  });
  return (req, res, next) => {
    const token = cookie(req, sessionName);
    const actor = token ? database.findSession(hashToken(token)) : undefined;
    if (!actor) {
      res.status(401).json({ error: 'AUTHENTICATION_REQUIRED' });
      return;
    }
    if (
      !['GET', 'HEAD', 'OPTIONS'].includes(req.method) &&
      !origins.has(req.header('origin') ?? '')
    ) {
      res.status(403).json({ error: 'ORIGIN_FORBIDDEN' });
      return;
    }
    res.locals['actor'] = actor;
    return next();
  };
}
