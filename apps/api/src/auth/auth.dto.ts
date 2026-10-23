import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEmail, IsIn, IsOptional, IsString, MinLength } from 'class-validator';

export const REGISTERABLE_ROLES = ['DONOR', 'ORG_ADMIN', 'ORG_MEMBER'] as const;

export class RegisterDto {
  @ApiProperty({ example: 'donor@example.com' })
  @IsEmail()
  email!: string;

  @ApiProperty({ minLength: 8, description: 'Plaintext over TLS only; stored as a bcrypt hash.' })
  @IsString()
  @MinLength(8)
  password!: string;

  @ApiProperty({ enum: REGISTERABLE_ROLES })
  @IsIn(REGISTERABLE_ROLES)
  role!: (typeof REGISTERABLE_ROLES)[number];

  @ApiProperty({ example: 'Synthetic Donor' })
  @IsString()
  @MinLength(1)
  displayName!: string;

  @ApiPropertyOptional({ description: 'Required for ORG_ADMIN / ORG_MEMBER accounts' })
  @IsOptional()
  @IsString()
  organizationId?: string;
}

export class LoginDto {
  @ApiProperty()
  @IsEmail()
  email!: string;

  @ApiProperty()
  @IsString()
  @MinLength(1)
  password!: string;
}

export class DevTokenDto {
  @ApiPropertyOptional({
    description:
      'DEV ONLY: user id of a stored user to issue a token for. Omit to issue for the seeded synthetic donor.',
  })
  @IsOptional()
  @IsString()
  userId?: string;
}
