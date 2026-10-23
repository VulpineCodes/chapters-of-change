import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Min, MinLength } from 'class-validator';

export const CONDITIONS = ['NEW', 'LIKE_NEW', 'GOOD', 'FAIR', 'POOR'] as const;
export const AGE_SUITABILITIES = ['ALL_AGES', 'CHILDREN', 'TEEN', 'YOUNG_ADULT', 'ADULT'] as const;

export class CreateListingDto {
  @ApiProperty({ example: 'Naruto Vol. 1–5 bundle' })
  @IsString()
  @MinLength(1)
  title!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  description?: string;

  @ApiProperty({ example: 'Manga' })
  @IsString()
  @MinLength(1)
  genre!: string;

  @ApiProperty({ example: 'English' })
  @IsString()
  @MinLength(1)
  language!: string;

  @ApiProperty({ enum: CONDITIONS })
  @IsIn(CONDITIONS)
  condition!: (typeof CONDITIONS)[number];

  @ApiProperty({ enum: AGE_SUITABILITIES })
  @IsIn(AGE_SUITABILITIES)
  ageSuitability!: (typeof AGE_SUITABILITIES)[number];

  @ApiProperty({ example: 5, minimum: 1 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  quantity!: number;
}
