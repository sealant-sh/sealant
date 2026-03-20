import { queryOptions } from "@tanstack/react-query";

import { getSessionServerFn } from "./session";

export const sessionQueryOptions = () =>
  queryOptions({
    queryKey: ["auth", "session"],
    queryFn: () => getSessionServerFn(),
    staleTime: 30_000,
  });
