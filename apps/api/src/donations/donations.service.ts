import { Inject, Injectable } from '@nestjs/common';
import { canViewDonation, type Actor, type Donation } from '@chapters/domain';
import type { RequestDonationResult, Store, WorkflowService } from '@chapters/app-services';
import { STORE, WORKFLOW_SERVICE } from '../runtime/runtime.module';
import { workflowCall } from '../common/workflow-errors';

/**
 * Thin Nest adapter over the tested `WorkflowService`
 * (`packages/app-services`). The donation state machine, RBAC, idempotency,
 * inventory reservation, and outbox writes all live in the application /
 * domain layers and are integration-tested there; this service only
 * delegates and translates errors to HTTP.
 */
@Injectable()
export class DonationsService {
  constructor(
    @Inject(WORKFLOW_SERVICE) private readonly workflow: WorkflowService,
    @Inject(STORE) private readonly store: Store,
  ) {}

  async request(
    actor: Actor,
    input: { listingId: string; quantity: number; message?: string },
    idempotencyKey?: string,
  ): Promise<RequestDonationResult> {
    return workflowCall(() =>
      this.workflow.requestDonation(actor, { ...input, idempotencyKey }),
    );
  }

  /** Donations visible to the actor: their own (donor) or their org's. */
  async listForActor(actor: Actor): Promise<Donation[]> {
    const all = await this.store.donations.listAll();
    return all.filter((d) => canViewDonation(actor, d));
  }

  async get(actor: Actor, id: string): Promise<Donation> {
    return workflowCall(() => this.workflow.getDonation(actor, id));
  }

  async approve(actor: Actor, id: string): Promise<Donation> {
    return workflowCall(() => this.workflow.approveDonation(actor, id));
  }

  async reject(actor: Actor, id: string, reason?: string): Promise<Donation> {
    return workflowCall(() => this.workflow.rejectDonation(actor, id, reason));
  }

  async cancel(actor: Actor, id: string, reason?: string): Promise<Donation> {
    return workflowCall(() => this.workflow.cancelDonation(actor, id, reason));
  }

  async markInTransit(actor: Actor, id: string): Promise<Donation> {
    return workflowCall(() => this.workflow.markInTransit(actor, id));
  }

  async markDelivered(actor: Actor, id: string): Promise<Donation> {
    return workflowCall(() => this.workflow.markDelivered(actor, id));
  }

  async confirmCompleted(actor: Actor, id: string): Promise<Donation> {
    return workflowCall(() => this.workflow.confirmCompleted(actor, id));
  }
}
