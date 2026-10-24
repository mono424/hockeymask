import { QueryClient } from '@tanstack/react-query'

/** The app's one query cache, shared with code outside React (the agent's tools). */
export const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 30_000, refetchOnWindowFocus: false } },
})
