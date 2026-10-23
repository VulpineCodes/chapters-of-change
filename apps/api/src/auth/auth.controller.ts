import { Body, Controller, HttpCode, Inject, NotFoundException, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { CredentialAuthService, Store } from '@chapters/app-services';
import { JwtService } from './jwt.service';
import { CREDENTIAL_AUTH, STORE } from '../runtime/runtime.module';
import { workflowCall } from '../common/workflow-errors';
import { DevTokenDto, LoginDto, RegisterDto } from './auth.dto';

/**
 * Authentication endpoints.
 *
 * - `POST /auth/register` + `POST /auth/login` are the real credential
 *   flow: passwords are bcrypt-hashed at registration and verified at
 *   login by `CredentialAuthService` (packages/app-services); a successful
 *   login issues the standard HS256 JWT. Wrong password and unknown email
 *   both return the same generic 401.
 * - `POST /auth/dev-token` is a DEV-ONLY convenience for local demos. It
 *   issues a token without a password check and must never be exposed in a
 *   real deployment. Prefer register/login.
 */
@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly jwt: JwtService,
    @Inject(CREDENTIAL_AUTH) private readonly credentials: CredentialAuthService,
    @Inject(STORE) private readonly store: Store,
  ) {}

  @Post('register')
  @ApiOperation({ summary: 'Register with email + password (bcrypt-hashed; never stored in plaintext)' })
  async register(@Body() dto: RegisterDto) {
    const user = await workflowCall(() => this.credentials.register(dto));
    return {
      id: user.id,
      email: user.email,
      role: user.role,
      organizationId: user.organizationId,
      displayName: user.displayName,
    };
  }

  @Post('login')
  @HttpCode(200)
  @ApiOperation({ summary: 'Log in with email + password; returns the HS256 JWT' })
  async login(@Body() dto: LoginDto) {
    const result = await workflowCall(() => this.credentials.login(dto.email, dto.password));
    return { accessToken: result.accessToken, tokenType: result.tokenType };
  }

  /**
   * DEV ONLY — issues a token without any credential check so local demos
   * and the smoke test can act as any seeded synthetic user. Do not enable
   * in production.
   */
  @Post('dev-token')
  @HttpCode(200)
  @ApiOperation({
    summary: 'DEV ONLY: issue a JWT without a password check (local/demo use only)',
  })
  async devToken(@Body() dto: DevTokenDto) {
    if (dto?.userId) {
      const user = await this.store.users.getById(dto.userId);
      if (!user) throw new NotFoundException(`User ${dto.userId} not found`);
      return {
        accessToken: this.jwt.issue({
          sub: user.id,
          role: user.role,
          email: user.email,
          organizationId: user.organizationId,
        }),
        tokenType: 'Bearer' as const,
      };
    }
    // Default: the seeded synthetic donor, resolved from the store when the
    // seed has run so the token's claims match stored records.
    const seeded = await this.store.users.getByEmail('donor@example.com');
    if (seeded) {
      return {
        accessToken: this.jwt.issue({
          sub: seeded.id,
          role: seeded.role,
          email: seeded.email,
          organizationId: seeded.organizationId,
        }),
        tokenType: 'Bearer' as const,
      };
    }
    return this.jwt.issueForSeededUser();
  }
}
