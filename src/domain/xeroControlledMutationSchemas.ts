import { z } from "zod/v4";

export const executePreparedXeroMutationSchema = z.object({
  preparation_id: z.string().regex(/^xmp_[a-f0-9]{32}$/),
  request_id: z.string().min(8).max(128).regex(/^[A-Za-z0-9._:-]+$/),
}).strict();

export type ExecutePreparedXeroMutationInput = z.infer<typeof executePreparedXeroMutationSchema>;
