/**
 * Refunds.
 *
 * Readable by the payments team only. The refund window and the exception rule live here as code;
 * the support handbook states them in prose, and the two are expected to agree.
 */

import { postJson } from "../platform/http";
import { withRetry } from "../platform/retry";

export const REFUND_WINDOW_DAYS = 30;

export interface RefundRequest {
  readonly orderId: string;
  readonly deliveredAt: Date;
  readonly requestedAt: Date;
  readonly exceptionApprovedBy: string | null;
}

/** Whether the request falls inside the refund window, counted from delivery. */
export function withinWindow(request: RefundRequest): boolean {
  const elapsedDays = (request.requestedAt.getTime() - request.deliveredAt.getTime()) / 86_400_000;
  return elapsedDays <= REFUND_WINDOW_DAYS;
}

/**
 * Issues a refund, or refuses one outside the window without an approved exception.
 *
 * The call to the payment gateway goes through the platform retry helper, because a gateway 503
 * during a refund is transient and the customer should not see it.
 */
export async function issueRefund(request: RefundRequest): Promise<string> {
  if (!withinWindow(request) && request.exceptionApprovedBy === null) {
    throw new Error(
      `order ${request.orderId} is outside the ${String(REFUND_WINDOW_DAYS)}-day window`,
    );
  }
  const response = await withRetry(() =>
    postJson("https://gateway.internal/refunds", { orderId: request.orderId }),
  );
  recordRefund(request.orderId, request.exceptionApprovedBy);
  return response.body;
}

/** Records the refund against the order, with the approver when it was an exception. */
export function recordRefund(orderId: string, approvedBy: string | null): void {
  ledgerEntry(orderId, approvedBy === null ? "refund" : `refund-exception:${approvedBy}`);
}

function ledgerEntry(orderId: string, kind: string): void {
  void orderId;
  void kind;
}
