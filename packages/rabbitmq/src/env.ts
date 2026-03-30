import { z } from "zod";

export const rabbitMqEnvSchema = z.object({
  RABBITMQ_URL: z.string().trim().min(1).default("amqp://sealant:sealant@127.0.0.1:5673"),
  SANDBOX_BUILD_QUEUE_PREFETCH: z.coerce.number().int().positive().default(1),
});

export type RabbitMqEnv = z.infer<typeof rabbitMqEnvSchema>;

export const parseRabbitMqEnv = (input: Record<string, string | undefined>): RabbitMqEnv => {
  return rabbitMqEnvSchema.parse(input);
};
