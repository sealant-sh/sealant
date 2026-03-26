import { createAuthClient } from "better-auth/client";

export interface CreateSealantAuthClientOptions {
  readonly baseURL?: string;
}

export const createSealantAuthClient = (options: CreateSealantAuthClientOptions = {}) => {
  return createAuthClient(options.baseURL === undefined ? {} : { baseURL: options.baseURL });
};
