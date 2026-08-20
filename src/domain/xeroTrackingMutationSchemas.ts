import { z } from "zod/v4";

/**
 * Tracking maintenance is deliberately a closed surface.  The Xero object
 * contains status, option and archive/delete fields, but none of those fields
 * are part of this domain contract.  Lifecycle changes are not safe reference
 * data maintenance and therefore cannot enter the provider adapter through an
 * unknown-field escape hatch.
 */
const exactUuid = z.string().uuid().transform((value) => value.toLowerCase());
const trackingName = z.string().trim().min(1).max(100);

export const trackingCategoryCreateSchema = z.object({
  name: trackingName,
}).strict();

export const trackingCategoryUpdateSchema = z.object({
  trackingCategoryId: exactUuid,
  name: trackingName,
}).strict();

export const trackingOptionCreateSchema = z.object({
  trackingCategoryId: exactUuid,
  name: trackingName,
}).strict();

export const trackingOptionUpdateSchema = z.object({
  trackingCategoryId: exactUuid,
  trackingOptionId: exactUuid,
  name: trackingName,
}).strict();

export const trackingMutationIdempotencyKeySchema = z.string()
  .min(8)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/u);

export type TrackingCategoryCreateInput = z.infer<typeof trackingCategoryCreateSchema>;
export type TrackingCategoryUpdateInput = z.infer<typeof trackingCategoryUpdateSchema>;
export type TrackingOptionCreateInput = z.infer<typeof trackingOptionCreateSchema>;
export type TrackingOptionUpdateInput = z.infer<typeof trackingOptionUpdateSchema>;

export type TrackingMutationIdempotencyKey = z.infer<typeof trackingMutationIdempotencyKeySchema>;

export function parseTrackingCategoryCreateInput(input: unknown): TrackingCategoryCreateInput {
  return trackingCategoryCreateSchema.parse(input);
}

export function parseTrackingCategoryUpdateInput(input: unknown): TrackingCategoryUpdateInput {
  return trackingCategoryUpdateSchema.parse(input);
}

export function parseTrackingOptionCreateInput(input: unknown): TrackingOptionCreateInput {
  return trackingOptionCreateSchema.parse(input);
}

export function parseTrackingOptionUpdateInput(input: unknown): TrackingOptionUpdateInput {
  return trackingOptionUpdateSchema.parse(input);
}

export function parseTrackingMutationIdempotencyKey(input: unknown): TrackingMutationIdempotencyKey {
  return trackingMutationIdempotencyKeySchema.parse(input);
}
