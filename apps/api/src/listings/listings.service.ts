import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { Actor, Listing, ListingSearchParams, PaginatedResult } from '@chapters/domain';
import type { Store, WorkflowService } from '@chapters/app-services';
import { STORE, WORKFLOW_SERVICE } from '../runtime/runtime.module';
import { workflowCall } from '../common/workflow-errors';
import type { CreateListingDto } from './listings.dto';

/**
 * Thin Nest adapter over the tested `WorkflowService`
 * (`packages/app-services`). All rules — who may create a listing, input
 * validation, search/filter/pagination semantics — live in the application
 * and domain layers; this service only delegates and translates errors.
 */
@Injectable()
export class ListingsService {
  constructor(
    @Inject(WORKFLOW_SERVICE) private readonly workflow: WorkflowService,
    @Inject(STORE) private readonly store: Store,
  ) {}

  async create(actor: Actor, dto: CreateListingDto): Promise<Listing> {
    return workflowCall(() => this.workflow.createListing(actor, dto));
  }

  async search(params: ListingSearchParams): Promise<PaginatedResult<Listing>> {
    return this.workflow.searchListings(params);
  }

  async findOne(id: string): Promise<Listing> {
    const listing = await this.store.listings.getById(id);
    if (!listing) throw new NotFoundException(`Listing ${id} not found`);
    return listing;
  }
}
