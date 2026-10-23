import { Body, Controller, Get, Headers, Param, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';
import { DonationsService } from './donations.service';
import { Roles, RolesGuard } from '../auth/roles.guard';
import { actorFromRequest, type ActorRequest } from '../common/actor';
import { CreateDonationDto, ReasonDto } from './donations.dto';

/**
 * The real donor→recipient workflow over HTTP. Every endpoint delegates to
 * `WorkflowService` (packages/app-services): role checks happen here
 * (RolesGuard, from verified JWT claims) AND in the workflow layer
 * (ownership / cross-organization rules), so a caller from the wrong
 * organization is rejected even with a well-formed token.
 */
@ApiTags('donations')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller('donations')
export class DonationsController {
  constructor(private readonly donations: DonationsService) {}

  @Post()
  @Roles('ORG_ADMIN', 'ORG_MEMBER', 'ADMIN')
  @ApiOperation({ summary: 'Request a donation for a listing (organizations only, idempotent)' })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: false,
    description:
      'Client idempotency key. Replaying the same key returns the original donation instead of creating a duplicate.',
  })
  request(
    @Req() req: ActorRequest,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() dto: CreateDonationDto,
  ) {
    return this.donations.request(actorFromRequest(req), dto, idempotencyKey || undefined);
  }

  @Get()
  @ApiOperation({ summary: 'List donations visible to the caller (donor: own; org: their org’s)' })
  list(@Req() req: ActorRequest) {
    return this.donations.listForActor(actorFromRequest(req));
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get one donation (participants only)' })
  get(@Req() req: ActorRequest, @Param('id') id: string) {
    return this.donations.get(actorFromRequest(req), id);
  }

  @Post(':id/approve')
  @Roles('DONOR', 'ADMIN')
  @ApiOperation({ summary: 'Approve a pending request (owning donor only; reserves inventory)' })
  approve(@Req() req: ActorRequest, @Param('id') id: string) {
    return this.donations.approve(actorFromRequest(req), id);
  }

  @Post(':id/reject')
  @Roles('DONOR', 'ADMIN')
  @ApiOperation({ summary: 'Reject a pending request (owning donor only)' })
  reject(@Req() req: ActorRequest, @Param('id') id: string, @Body() dto: ReasonDto) {
    return this.donations.reject(actorFromRequest(req), id, dto?.reason);
  }

  @Post(':id/cancel')
  @ApiOperation({ summary: 'Cancel a donation (owning donor or receiving organization)' })
  cancel(@Req() req: ActorRequest, @Param('id') id: string, @Body() dto: ReasonDto) {
    return this.donations.cancel(actorFromRequest(req), id, dto?.reason);
  }

  @Post(':id/in-transit')
  @Roles('DONOR', 'ADMIN')
  @ApiOperation({ summary: 'Mark an approved donation in transit (owning donor only)' })
  inTransit(@Req() req: ActorRequest, @Param('id') id: string) {
    return this.donations.markInTransit(actorFromRequest(req), id);
  }

  @Post(':id/delivered')
  @Roles('DONOR', 'ADMIN')
  @ApiOperation({ summary: 'Mark an in-transit donation delivered (owning donor only)' })
  delivered(@Req() req: ActorRequest, @Param('id') id: string) {
    return this.donations.markDelivered(actorFromRequest(req), id);
  }

  @Post(':id/complete')
  @Roles('ORG_ADMIN', 'ORG_MEMBER', 'ADMIN')
  @ApiOperation({ summary: 'Confirm receipt and complete the donation (receiving organization only)' })
  complete(@Req() req: ActorRequest, @Param('id') id: string) {
    return this.donations.confirmCompleted(actorFromRequest(req), id);
  }
}
