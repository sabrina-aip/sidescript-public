export interface User {
  username: string
  displayName: string
  color: string
  isAdmin: boolean
  disabled?: boolean
}

export type Role = 'owner' | 'editor' | 'viewer'

export interface DocMeta {
  id: string
  title: string
  owner: string
  ownerName: string
  createdAt: string
  updatedAt: string
  trashed: boolean
  role: Role
  shares?: Record<string, 'editor' | 'viewer'>
}

export interface Version {
  name: string
  at: string
  label: string
  size: number
}

export class ApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

export async function api<T = any>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', 'X-Sidescript': '1' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    if (res.status === 401 && !url.startsWith('/api/login')) window.dispatchEvent(new Event('sidescript:signed-out'))
    throw new ApiError(res.status, data.error || res.statusText)
  }
  return data as T
}

export async function uploadFile(docId: string, file: Blob): Promise<{ url: string; size: number }> {
  const res = await fetch(`/api/docs/${docId}/media`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': file.type || 'application/octet-stream', 'X-Sidescript': '1' },
    body: file,
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new ApiError(res.status, data.error || 'Upload failed')
  return data
}
