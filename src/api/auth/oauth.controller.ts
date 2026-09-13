import {
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { APP_CONFIG } from '../../core/config/config.module.js';
import type { AppConfig } from '../../core/config/schema.js';
import { ConflictError, NotFoundError } from '../../core/errors/app-error.js';
import type { OAuthProvider } from '../../core/db/types.js';
import { CurrentUser } from './decorators/current-user.decorator.js';
import { OAuthProviderParamPipe } from './pipes/oauth-provider.pipe.js';
import { SessionGuard, type RequestUser } from './guards/session.guard.js';
import {
  OAuthIdentityRepository,
  toIdentitySummary,
  type IdentitySummary,
} from './repositories/oauth-identity.repository.js';
import { OAuthService } from './services/oauth.service.js';
import { clientIp } from './utils/client-ip.js';
import {
  clearOauthCookieOptions,
  oauthCookieName,
  oauthCookieOptions,
} from './utils/oauth-cookie.js';
import { sessionCookieName, sessionCookieOptions } from './utils/session-cookie.js';

/**
 * Sign in with Google or GitHub. Cookies, redirects and sessions live here;
 * the flow itself is `OAuthService`, and the linking policy behind it is
 * `OAuthIdentityService`.
 */
@Controller('auth')
export class OAuthController {
  constructor(
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    private readonly oauth: OAuthService,
    private readonly identities: OAuthIdentityRepository,
  ) {}

  /**
   * `302` to the provider. A plain anchor works: no JavaScript, no CORS
   * preflight, which is the whole reason this is a redirect rather than JSON.
   */
  @Get('oauth/:provider/start')
  async start(
    @Param('provider', OAuthProviderParamPipe) provider: OAuthProvider,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const result = await this.oauth.start(provider, {
      ip: clientIp(req),
      returnTo: req.query.returnTo,
    });

    res.cookie(oauthCookieName(this.cfg), result.cookieValue, oauthCookieOptions(this.cfg));
    res.redirect(302, result.redirectUrl.toString());
  }

  /**
   * Always a redirect, never JSON: this is a browser navigation the provider
   * sent, not an API call our own client made. Success goes to the stored
   * `returnTo`; failure to `/login?error=<code>`, a code from a fixed
   * enumeration -- the provider's own error text is attacker-influenced and
   * is logged, never rendered.
   */
  @Get('oauth/:provider/callback')
  async callback(
    @Param('provider', OAuthProviderParamPipe) provider: OAuthProvider,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const cookies = req.cookies as Record<string, unknown> | undefined;
    const cookieValue = cookies?.[oauthCookieName(this.cfg)];
    const sessionToken = cookies?.[sessionCookieName(this.cfg)];

    const result = await this.oauth.complete(provider, {
      ip: clientIp(req),
      cookieValue: typeof cookieValue === 'string' ? cookieValue : undefined,
      query: new URLSearchParams(req.url.split('?')[1] ?? ''),
      sessionToken: typeof sessionToken === 'string' ? sessionToken : undefined,
    });

    // Cleared unconditionally: whatever happened, this attempt is over.
    res.clearCookie(oauthCookieName(this.cfg), clearOauthCookieOptions(this.cfg));

    if (result.kind === 'error') {
      res.redirect(302, this.webUrl('/login', { error: result.code }));
      return;
    }

    res.cookie(
      sessionCookieName(this.cfg),
      result.token,
      sessionCookieOptions(this.cfg, result.expiresAt),
    );
    res.redirect(302, this.webUrl(result.returnTo));
  }

  /**
   * Starts a linking flow from an authenticated session. JSON rather than a
   * redirect, because it is called from a page that already has a fetch
   * client and a `DELETE`-style action should not be a navigable `GET`.
   */
  @Post('oauth/:provider/link')
  @HttpCode(200)
  @UseGuards(SessionGuard)
  async link(
    @Param('provider', OAuthProviderParamPipe) provider: OAuthProvider,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @CurrentUser() user: RequestUser,
  ): Promise<{ redirectUrl: string }> {
    const result = await this.oauth.start(provider, {
      ip: clientIp(req),
      returnTo: req.query.returnTo,
      userId: user.id,
    });

    res.cookie(oauthCookieName(this.cfg), result.cookieValue, oauthCookieOptions(this.cfg));
    return { redirectUrl: result.redirectUrl.toString() };
  }

  @Delete('oauth/:provider')
  @HttpCode(204)
  @UseGuards(SessionGuard)
  async unlink(
    @Param('provider', OAuthProviderParamPipe) provider: OAuthProvider,
    @CurrentUser() user: RequestUser,
  ): Promise<void> {
    const result = await this.identities.unlink(user.id, provider);

    if (result === 'not_found') throw new NotFoundError('identity');
    if (result === 'last_credential') {
      throw new ConflictError(
        'LAST_CREDENTIAL',
        'removing this would leave the account with no way to sign in',
      );
    }
  }

  @Get('identities')
  @UseGuards(SessionGuard)
  async identitiesList(@CurrentUser() user: RequestUser): Promise<IdentitySummary[]> {
    const rows = await this.identities.listForUser(user.id);
    return rows.map(toIdentitySummary);
  }

  /** `WEB_BASE_URL` plus an already-validated path, never the request's own origin. */
  private webUrl(path: string, params?: Record<string, string>): string {
    const url = new URL(path, this.cfg.WEB_BASE_URL);
    if (params) for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    return url.toString();
  }
}
