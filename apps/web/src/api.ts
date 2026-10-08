export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly data: Record<string, unknown> = {}) {
    super(message);
  }

  get incompleteChecklist(): number | undefined {
    const count = this.data.incompleteChecklist;
    return this.status === 409 && typeof count === 'number' && Number.isInteger(count) && count > 0 ? count : undefined;
  }
}

export async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(path, options);
  if (!response.ok) {
    const data = await response.json() as { error?: string };
    throw new ApiError(data.error ?? 'request failed', response.status, data);
  }
  return response.json() as Promise<T>;
}

export const json = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body)
});

export function imageUpload(file: File, requestId: string = crypto.randomUUID()): RequestInit {
  const body = new FormData();
  body.append('file', file);
  return { method: 'POST', headers: { 'x-upload-id': requestId }, body };
}
