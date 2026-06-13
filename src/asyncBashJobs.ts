const asyncControllers = new Map<string, AbortController>();

export function registerAsyncBashController(jobId: string, controller: AbortController): void {
  asyncControllers.set(jobId, controller);
}

export function unregisterAsyncBashController(jobId: string): void {
  asyncControllers.delete(jobId);
}

export function cancelAsyncBashJob(jobId: string): boolean {
  const controller = asyncControllers.get(jobId);
  if (!controller) return false;
  controller.abort();
  return true;
}
