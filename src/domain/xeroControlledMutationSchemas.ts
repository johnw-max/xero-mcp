import { z } from "zod/v4";

export const executePreparedXeroMutationSchema = z.object({
  preparation_id: z.string().regex(/^xmp_[a-f0-9]{32}$/),
  request_id: z.string().min(8).max(128).regex(/^[A-Za-z0-9._:-]+$/),
  confirmation_phrase: z.string().min(1).max(256)
    .refine((value) => value === value.trim(), "must not have surrounding whitespace")
    .refine((value) => !/[\u0000-\u001f\u007f]/u.test(value), "must not contain control characters"),
}).strict();

export type ExecutePreparedXeroMutationInput = z.infer<typeof executePreparedXeroMutationSchema>;
