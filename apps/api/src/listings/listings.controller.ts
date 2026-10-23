import { Body, Controller, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Condition, AgeSuitability } from '@chapters/domain';
import { ListingsService } from './listings.service';
import { Roles, RolesGuard } from '../auth/roles.guard';
import { actorFromRequest, type ActorRequest } from '../common/actor';
import { CreateListingDto } from './listings.dto';

@ApiTags('listings')
@Controller('listings')
export class ListingsController {
  constructor(private readonly listings: ListingsService) {}

  @Post()
  @UseGuards(RolesGuard)
  @Roles('DONOR', 'ADMIN')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Create a book listing (donors only; delegates to WorkflowService)' })
  create(@Req() req: ActorRequest, @Body() dto: CreateListingDto) {
    return this.listings.create(actorFromRequest(req), dto);
  }

  @Get()
  @ApiOperation({ summary: 'Search listings with filtering and pagination (public)' })
  search(@Query() q: Record<string, string>) {
    return this.listings.search({
      query: q.query,
      genre: q.genre,
      language: q.language,
      condition: q.condition as Condition | undefined,
      ageSuitability: q.ageSuitability as AgeSuitability | undefined,
      onlyAvailable: q.onlyAvailable === 'true' ? true : undefined,
      page: q.page ? Number(q.page) : undefined,
      pageSize: q.pageSize ? Number(q.pageSize) : undefined,
    });
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get one listing by id (public)' })
  findOne(@Param('id') id: string) {
    return this.listings.findOne(id);
  }
}
